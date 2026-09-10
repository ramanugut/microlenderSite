import crypto from 'node:crypto';
import { HttpError } from './http.js';
import {
  batchFileUpload,
  buildEMandateFile,
  debiCheckAuthenticate,
  debiCheckCancelAuthentication,
  debiCheckRetrieveMandateTemplateDetail
} from './netcash.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbInsert, dbSelect, dbUpdate, supabaseRequest } from './supabase-rest.js';

const STREAMS = new Set(['efts','eft_2day','debicheck']);
const AUTH_MODES = new Set(['tt1','tt2']);

function accountReference(loanId) {
  return `KR${String(loanId || '').replace(/-/g, '').slice(0, 20).toUpperCase()}`;
}

async function loadConfig() {
  const rows = await dbSelect('netcash_config', { select:'*', id:'eq.true', limit:1 });
  return rows?.[0] || null;
}

async function upsertContract(body) {
  const rows = await supabaseRequest('/rest/v1/netcash_contracts?on_conflict=loan_id', {
    method:'POST', body, prefer:'resolution=merge-duplicates,return=representation'
  });
  return rows?.[0] || null;
}

async function upsertInstruction(body) {
  const rows = await supabaseRequest('/rest/v1/netcash_collection_instructions?on_conflict=schedule_id', {
    method:'POST', body, prefer:'resolution=merge-duplicates,return=representation'
  });
  return rows?.[0] || null;
}

async function createFailureTask({ userId, loanId, message, staffId }) {
  if (!staffId) return;
  const existing = await dbSelect('business_tasks', {
    select:'id,description', loan_id:`eq.${loanId}`, status:'in.(open,in_progress)', task_type:'eq.collection', limit:20
  }).catch(() => []);
  if ((existing || []).some(row => String(row.description || '').includes('Netcash'))) return;
  await dbInsert('business_tasks', {
    title:'Netcash mandate setup needs attention',
    description:`Netcash mandate setup failed. ${message}`.slice(0,1000),
    task_type:'collection', priority:'urgent', status:'open',
    user_id:userId, loan_id:loanId, assigned_to:staffId, due_at:new Date().toISOString(), created_by:staffId
  }).catch(() => {});
}

function validateStream(stream, config) {
  if (!STREAMS.has(stream)) throw new HttpError(400,'Choose EFTS, 2-Day EFT or DebiCheck.','invalid_netcash_collection_stream');
  if (stream === 'debicheck') {
    if (!config.debicheck_enabled || !config.debicheck_template_id) throw new HttpError(409,'Netcash DebiCheck is not fully configured.','netcash_debicheck_not_ready');
    return;
  }
  if (!config.emandate_enabled || !config.standard_debit_orders_enabled) {
    throw new HttpError(409,'Netcash eMandate and Standard debit orders must both be enabled for EFTS or 2-Day EFT.','netcash_standard_debit_not_ready');
  }
}

function acceptedDebiCheck(status) { return String(status || '').trim().toLowerCase() === 'accepted'; }
function rejectedDebiCheck(status) { return ['rejected','declined','cancelled','failed'].includes(String(status || '').trim().toLowerCase()); }

function expectedTemplateFrequency(value) {
  const clean = String(value || 'monthly').toLowerCase();
  if (clean === 'weekly') return 'WEEK';
  if (clean === 'fortnightly' || clean === 'biweekly' || clean === 'bi-weekly') return 'FRTNF';
  if (clean === 'quarterly') return 'QURT';
  if (clean === 'semiannual' || clean === 'six_monthly') return 'MIAN';
  if (clean === 'annual' || clean === 'annually') return 'YEAR';
  return 'MNTH';
}

function fingerprint({ loan, profile, stream, authMode, firstSchedule, regularAmount, firstAmount }) {
  const payload = {
    stream, authMode:authMode || null,
    userId:loan.user_id,
    idNumber:String(profile.id_number || '').trim(),
    accountHolder:String(profile.bank_account_holder || '').trim().toLowerCase(),
    accountNumber:String(profile.bank_account_number || '').replace(/\s/g,''),
    branchCode:String(profile.branch_code || '').padStart(6,'0'),
    accountType:String(profile.bank_account_type || '').toLowerCase(),
    mobile:String(profile.mobile || '').replace(/\D/g,''),
    frequency:String(loan.repayment_frequency || 'monthly').toLowerCase(),
    regularAmount:Number(regularAmount).toFixed(2),
    firstAmount:Number(firstAmount).toFixed(2),
    firstDate:firstSchedule.due_date
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function archiveContract(contract, eventType) {
  if (!contract?.id) return;
  await dbInsert('netcash_mandate_history', {
    contract_id:contract.id,
    loan_id:contract.loan_id,
    revision:Number(contract.revision || 1),
    event_type:eventType,
    snapshot:contract
  }).catch(() => {});
}

async function validateDebiCheckTemplate({ credentials, config, authMode, loan }) {
  const template = await debiCheckRetrieveMandateTemplateDetail(credentials.debitOrderServiceKey, config.debicheck_template_id);
  if (template.errorCode !== '000') throw new HttpError(409,`Netcash could not validate the DebiCheck template (${template.errorCode || 'unknown'}).`,'netcash_template_invalid');
  const authText = `${template.authenticationType || ''} ${template.debtorAuthCode || ''}`.toUpperCase();
  if (authMode === 'tt1' && !(/TT1/.test(authText) || /REAL/.test(authText))) {
    throw new HttpError(409,'The configured Netcash DebiCheck template is not a TT1 real-time template.','netcash_template_not_tt1');
  }
  if (authMode === 'tt2' && !(/TT2/.test(authText) || /BATCH/.test(authText))) {
    throw new HttpError(409,'The configured Netcash DebiCheck template is not a TT2 batch template.','netcash_template_not_tt2');
  }
  const expectedFrequency = expectedTemplateFrequency(loan.repayment_frequency);
  if (template.collectionFrequency && String(template.collectionFrequency).toUpperCase() !== expectedFrequency) {
    throw new HttpError(409,`The DebiCheck template frequency is ${template.collectionFrequency}, but this loan is ${loan.repayment_frequency || 'monthly'}.`,'netcash_template_frequency_mismatch');
  }
  return template;
}

async function safelyReplaceExistingMandate(existing, credentials, newFingerprint) {
  if (!existing || existing.mandate_fingerprint === newFingerprint) return;
  const activeStates = ['requested','awaiting_authorisation','accepted'];
  if (!activeStates.includes(existing.mandate_status)) return;
  await archiveContract(existing,'supersede_requested');
  if (existing.collection_stream === 'debicheck' && existing.mandate_status === 'accepted' && existing.provider_contract_reference) {
    const cancelled = await debiCheckCancelAuthentication(credentials.debitOrderServiceKey, existing.provider_contract_reference, 'CUST');
    if (cancelled.errorCode !== '000') {
      throw new HttpError(409,`The old DebiCheck mandate must be cancelled before it can be replaced (Netcash ${cancelled.errorCode || 'unknown'}).`,'netcash_old_mandate_cancel_required');
    }
    await dbUpdate('netcash_contracts', { id:`eq.${existing.id}` }, {
      mandate_status:'cancelled', provider_status:'cancelled', cancelled_at:new Date().toISOString(),
      cancellation_reason:'Mandate details changed and a replacement was requested.', updated_at:new Date().toISOString()
    });
    return;
  }
  throw new HttpError(409,'This loan already has a mandate in progress. Cancel the existing provider mandate before changing bank, amount, date, stream or authentication details.','netcash_mandate_change_requires_cancellation');
}

export async function setupNetcashLoan({ loanId, stream = null, authMode = null, staffId }) {
  let context = null;
  try {
    const [config, credentials, loanRows] = await Promise.all([
      loadConfig(), loadNetcashCredentials(), dbSelect('loans',{ select:'*', id:`eq.${loanId}`, limit:1 })
    ]);
    const loan = loanRows?.[0];
    if (!loan) throw new HttpError(404,'Loan not found.','loan_not_found');
    context = { userId:loan.user_id, loanId, staffId };
    if (!['active','overdue'].includes(loan.status) || Number(loan.outstanding_balance) <= 0) {
      throw new HttpError(409,'Only an active loan with an outstanding balance can receive a new mandate.','loan_not_payable');
    }
    if (!config?.enabled || config.validation_status !== 'validated' || !credentials?.debitOrderServiceKey) {
      throw new HttpError(409,'Netcash debit orders are not connected and validated in Settings.','netcash_not_ready');
    }

    const explicitStream = stream ? String(stream).trim() : null;
    const websiteOrigin = !explicitStream && Boolean(loan.application_id);
    if (!explicitStream && loan.collection_method !== 'debit_order' && !websiteOrigin) return { skipped:true, reason:'not_debit_order' };
    const collectionStream = websiteOrigin
      ? (config.website_default_collection_stream || 'debicheck')
      : (explicitStream || loan.netcash_collection_stream || config.website_default_collection_stream || 'debicheck');
    validateStream(collectionStream,config);
    const selectedAuthMode = collectionStream === 'debicheck'
      ? (websiteOrigin ? (config.website_debicheck_auth_mode || 'tt1') : String(authMode || 'tt1').toLowerCase())
      : null;
    if (selectedAuthMode && !AUTH_MODES.has(selectedAuthMode)) throw new HttpError(400,'Choose TT1 real-time or TT2 batch DebiCheck.','invalid_debicheck_auth_mode');

    const [profileRows,schedules,existingContracts] = await Promise.all([
      dbSelect('customer_profiles',{ select:'*', id:`eq.${loan.user_id}`, limit:1 }),
      dbSelect('repayment_schedule',{ select:'*', loan_id:`eq.${loanId}`, order:'instalment_number.asc' }),
      dbSelect('netcash_contracts',{ select:'*', loan_id:`eq.${loanId}`, limit:1 })
    ]);
    const profile = profileRows?.[0];
    if (!profile) throw new HttpError(409,'Client profile is missing.','client_profile_required');
    if (!schedules?.length) throw new HttpError(409,'Repayment schedule is missing.','repayment_schedule_required');
    const required = ['id_number','first_name','last_name','bank_account_holder','bank_account_number','branch_code','bank_account_type','mobile'];
    const missing = required.filter(key => !String(profile[key] || '').trim());
    if (missing.length) throw new HttpError(409,`Netcash needs the client ${missing.join(', ')} before a mandate can be created.`,'netcash_client_data_incomplete');

    const payableSchedules = schedules.filter(row => !['paid','waived'].includes(row.status) && Number(row.amount_due) > Number(row.amount_paid || 0));
    if (!payableSchedules.length) throw new HttpError(409,'This loan has no unpaid instalments to collect.','instalment_not_payable');
    const firstSchedule = payableSchedules[0];
    const regularAmount = Number(loan.instalment_amount || firstSchedule.amount_due);
    const firstAmount = Number(firstSchedule.amount_due) - Number(firstSchedule.amount_paid || 0);
    if (!(regularAmount > 0) || !(firstAmount > 0)) throw new HttpError(409,'The mandate amount is invalid.','invalid_netcash_amount');
    const variableDebit = payableSchedules.some(row => Math.abs((Number(row.amount_due)-Number(row.amount_paid || 0)) - regularAmount) > 0.005);

    let template = null;
    if (collectionStream === 'debicheck') template = await validateDebiCheckTemplate({ credentials,config,authMode:selectedAuthMode,loan });
    const newFingerprint = fingerprint({ loan,profile,stream:collectionStream,authMode:selectedAuthMode,firstSchedule,regularAmount,firstAmount });
    const existing = existingContracts?.[0] || null;

    if (existing?.mandate_fingerprint === newFingerprint && ['requested','awaiting_authorisation','accepted'].includes(existing.mandate_status) && (existing.file_token || existing.provider_contract_reference)) {
      return { idempotent:true, contractId:existing.id, accountReference:existing.account_reference, mandateStatus:existing.mandate_status, scheduleCount:payableSchedules.length, stream:collectionStream, debicheckAuthMode:selectedAuthMode };
    }
    await safelyReplaceExistingMandate(existing,credentials,newFingerprint);

    const mode = collectionStream === 'debicheck' ? 'debicheck' : 'emandate';
    const instructionType = collectionStream === 'debicheck' ? 'debicheck' : 'standard_debit_order';
    const ref = existing?.account_reference || accountReference(loanId);
    const revision = Number(existing?.revision || 0) + (existing ? 1 : 0) || 1;
    const contract = await upsertContract({
      id:existing?.id || undefined,
      loan_id:loanId, user_id:loan.user_id, mode, collection_stream:collectionStream,
      debicheck_auth_mode:selectedAuthMode, account_reference:ref,
      mandate_fingerprint:newFingerprint, revision,
      provider_contract_reference:null, file_token:null,
      mandate_status:'not_requested', provider_status:'pending', cancelled_at:null, cancellation_reason:null,
      provider_metadata:{ ...(existing?.provider_metadata || {}), mandate_snapshot:{ fingerprint:newFingerprint, stream:collectionStream, auth_mode:selectedAuthMode, bank_account_last4:String(profile.bank_account_number).slice(-4), branch_code:String(profile.branch_code), regular_amount:regularAmount, first_amount:firstAmount, first_date:firstSchedule.due_date, frequency:loan.repayment_frequency || 'monthly' } },
      updated_at:new Date().toISOString()
    });
    if (!contract?.id) throw new HttpError(502,'Netcash contract record could not be created.','netcash_contract_error');
    await archiveContract(contract,'mandate_requested');

    await dbUpdate('loans',{ id:`eq.${loanId}` },{ collection_method:'debit_order', netcash_collection_stream:collectionStream, updated_at:new Date().toISOString() });

    for (const schedule of schedules) {
      const remaining = Math.max(0,Number(schedule.amount_due)-Number(schedule.amount_paid || 0));
      if (remaining <= 0 || ['paid','waived'].includes(schedule.status)) {
        const existingInstruction = await dbSelect('netcash_collection_instructions',{ select:'id,status', schedule_id:`eq.${schedule.id}`, limit:1 });
        if (existingInstruction?.[0] && ['planned','queued'].includes(existingInstruction[0].status)) {
          await dbUpdate('netcash_collection_instructions',{ id:`eq.${existingInstruction[0].id}` },{ status:'cancelled', cancelled_at:new Date().toISOString(), cancellation_reason:'No instalment balance remains.', updated_at:new Date().toISOString() });
        }
        continue;
      }
      await upsertInstruction({
        contract_id:contract.id, loan_id:loanId, schedule_id:schedule.id, user_id:loan.user_id,
        instalment_number:schedule.instalment_number, due_date:schedule.due_date, amount:remaining,
        instruction_type:instructionType, collection_stream:collectionStream,
        status:'planned', batch_name:null, file_token:null, batch_id:null, provider_reference:null, provider_result:null,
        submitted_at:null, processed_at:null, authorisation_status:'unknown', action_date:null, presentation_date:null,
        load_status:'not_submitted', last_error:null, cancelled_at:null, cancellation_reason:null,
        updated_at:new Date().toISOString()
      });
    }

    try {
      if (collectionStream === 'debicheck' && selectedAuthMode === 'tt1') {
        const result = await debiCheckAuthenticate({
          serviceKey:credentials.debitOrderServiceKey,
          accountReference:ref,
          templateId:config.debicheck_template_id,
          profile,
          amount:regularAmount,
          firstCollectionAmount:firstAmount,
          firstCollectionDate:firstSchedule.due_date
        });
        if (result.errorCode !== '000') {
          if (result.errorCode === '325') throw new HttpError(409,'Netcash rejected TT1 because the configured template is not real-time.','netcash_template_not_tt1');
          throw new HttpError(409,`Netcash TT1 authentication failed with code ${result.errorCode || 'unknown'}.`,'netcash_tt1_failed');
        }
        const accepted = acceptedDebiCheck(result.status);
        const rejected = rejectedDebiCheck(result.status);
        const now = new Date().toISOString();
        await dbUpdate('netcash_contracts',{ id:`eq.${contract.id}` },{
          provider_contract_reference:result.contractReference || null,
          mandate_status:accepted ? 'accepted' : rejected ? 'rejected' : 'awaiting_authorisation',
          provider_status:accepted ? 'active' : rejected ? 'failed' : 'pending',
          requested_at:now, authenticated_at:accepted ? now : null, activated_at:accepted ? now : null,
          last_error:rejected ? `DebiCheck TT1 ${result.status || 'rejected'}` : null,
          provider_metadata:{ ...(contract.provider_metadata || {}), template, collection_stream:collectionStream, stream_label:'DebiCheck', debicheck_auth_mode:'tt1', realtime:true, status:result.status || null, error_code:result.errorCode || null, bank_response_code:result.bankResponseCode || null, bankserv_response_code:result.bankservResponseCode || null, client_response_code:result.clientResponseCode || null, schedule_rows_planned:payableSchedules.length },
          updated_at:now
        });
        if (rejected) throw new HttpError(409,'The DebiCheck TT1 mandate was rejected.','netcash_debicheck_rejected');
        return { contractId:contract.id, accountReference:ref, providerContractReference:result.contractReference || null, mandateStatus:accepted ? 'accepted' : 'awaiting_authorisation', scheduleCount:payableSchedules.length, collectionInstructionType:instructionType, stream:collectionStream, debicheckAuthMode:'tt1', realtime:true };
      }

      const batchName = `KR-MANDATE-${ref}-${revision}`.slice(0,50);
      const mandateFile = buildEMandateFile({
        serviceKey:credentials.debitOrderServiceKey,
        softwareVendorKey:config.software_vendor_key,
        batchName,
        contract,
        loan:{ ...loan, collection_method:'debit_order', netcash_collection_stream:collectionStream, allow_variable_debit:variableDebit },
        profile,
        firstSchedule,
        includeDebiCheck:collectionStream === 'debicheck',
        templateId:config.debicheck_template_id
      });
      const fileToken = await batchFileUpload(credentials.debitOrderServiceKey,mandateFile);
      await dbUpdate('netcash_contracts',{ id:`eq.${contract.id}` },{
        file_token:fileToken, mandate_status:'requested', provider_status:'pending', requested_at:new Date().toISOString(), last_error:null,
        provider_metadata:{ ...(contract.provider_metadata || {}), template, mandate_batch_name:batchName, schedule_rows_planned:payableSchedules.length, collection_stream:collectionStream, debicheck_auth_mode:collectionStream === 'debicheck' ? 'tt2' : null, stream_label:collectionStream === 'debicheck' ? 'DebiCheck' : collectionStream === 'efts' ? 'EFTS' : '2-Day EFT' },
        updated_at:new Date().toISOString()
      });
      return { contractId:contract.id, accountReference:ref, fileToken, mandateStatus:'requested', scheduleCount:payableSchedules.length, collectionInstructionType:instructionType, stream:collectionStream, debicheckAuthMode:collectionStream === 'debicheck' ? 'tt2' : null };
    } catch (error) {
      if (error?.code !== 'netcash_debicheck_rejected') {
        await dbUpdate('netcash_contracts',{ id:`eq.${contract.id}` },{ mandate_status:'failed', provider_status:'failed', last_error:error.message || 'Netcash mandate setup failed.', updated_at:new Date().toISOString() }).catch(()=>{});
      }
      throw error;
    }
  } catch (error) {
    if (context) await createFailureTask({ ...context, message:error.message || 'Unknown Netcash error.' });
    throw error;
  }
}
