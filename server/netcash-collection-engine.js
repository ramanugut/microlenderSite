import { HttpError } from './http.js';
import {
  batchFileUpload,
  buildDebiCheckBatch,
  buildStandardDebitBatch,
  debiCheckCancelAuthentication,
  requestFileUploadReport,
  requestPayNowInvoice
} from './netcash.js';
import { debiCheckCurrentStatus } from './netcash-debicheck.js';
import {
  mandateState,
  parseMandateData,
  requestActionDate,
  requestMandateData,
  requestPresentationDate,
  retrieveMandateData
} from './netcash-reconciliation.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbInsert, dbRpc, dbSelect, dbUpdate, supabaseRequest } from './supabase-rest.js';

const NIF_URL = 'https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUCCESS_CODES = new Set(['TDD', 'SDD', 'DCS']);
const RETURN_CODES = new Set(['DRU', 'DCX', 'DCD']);

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' })[char]);
}
function unxml(value) {
  return String(value ?? '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function tag(source, name) {
  const match = String(source || '').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return match ? unxml(match[1].trim()) : null;
}
async function nifCall(method, params, timeout = 30000) {
  const action = `http://tempuri.org/NIWS_NIF/${method}`;
  const payload = Object.entries(params).map(([key,value]) => `<${key}>${xml(value)}</${key}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/">${payload}</${method}></soap:Body></soap:Envelope>`;
  const response = await fetch(NIF_URL, {
    method:'POST',
    headers:{ 'Content-Type':'text/xml; charset=utf-8', SOAPAction:`"${action}"` },
    body:envelope,
    signal:AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault[\s>]/i.test(text)) {
    throw new HttpError(response.status >= 500 ? 502 : 400, tag(text,'faultstring') || tag(text,'Text') || `Netcash ${method} failed.`, 'netcash_error');
  }
  return String(tag(text, `${method}Result`) || '').trim();
}

function zaDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Africa/Johannesburg', year:'numeric', month:'2-digit', day:'2-digit' }).format(value);
}
function addDays(value, amount) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0,10);
}
function daysBetween(a,b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
function date8(value) { return String(value || '').replace(/-/g,'').slice(0,8); }
function cleanMoney(value) { return Math.round(Math.abs(Number(value || 0)) * 100) / 100; }
function batchInstruction(stream) { return stream === 'efts' ? 'CompactSameDay' : 'CompactTwoDay'; }
function batchPrefix(stream) { return stream === 'debicheck' ? 'DC' : stream === 'efts' ? 'SD' : '2D'; }
function reasonCode(description) {
  const match = String(description || '').match(/(?:code\s*:?\s*|[-\s])([0-9]{2})(?:\D|$)/i);
  return match?.[1] || null;
}
function streamKind(stream) {
  if (stream === 'debicheck') return 'debicheck';
  if (stream === 'efts' || stream === 'eft_2day') return 'standard_debit';
  return 'all';
}
function flowApplies(flow,stream) {
  const kind = streamKind(stream);
  return flow?.applies_to === 'all' || flow?.applies_to === kind;
}
function trackingDays(value,fallback=1) {
  const number = Number(value);
  return Math.min(10,Math.max(1,Number.isFinite(number) ? number : fallback));
}

function parseLoadReport(text) {
  const raw = String(text || '').trim();
  if (!raw || /FILE NOT READY/i.test(raw)) return { status:'file_not_ready', ready:false, raw };
  if (/^100$/.test(raw)) return { status:'unsuccessful', ready:true, raw, error:'Authentication failure' };
  if (/^200$/.test(raw)) return { status:'unsuccessful', ready:true, raw, error:'Netcash processing error' };
  const begin = raw.split(/\r?\n/).find(line => line.startsWith('###BEGIN')) || '';
  const fields = begin.split('\t');
  const result = String(fields[2] || '').trim().toUpperCase();
  if (result === 'SUCCESSFUL') return { status:'successful', ready:true, raw };
  if (result === 'SUCCESSFUL WITH ERRORS') return { status:'successful_with_errors', ready:true, raw };
  if (result === 'UNSUCCESSFUL' || raw.includes('###ERROR')) return { status:'unsuccessful', ready:true, raw };
  return { status:'processing', ready:false, raw };
}

function parseStatement(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const rawDate = String(f[0] || '').trim();
    const type = String(f[1] || '').trim().toUpperCase();
    if (!/^\d{8}$/.test(rawDate) || !/^[A-Z]{3}$/.test(type)) continue;
    rows.push({
      statementDate:`${rawDate.slice(0,4)}-${rawDate.slice(4,6)}-${rawDate.slice(6,8)}`,
      transactionType:type,
      transactionId:String(f[2] || '').trim(),
      description:String(f[3] || '').trim(),
      amount:cleanMoney(f[4]),
      symbol:String(f[5] || '').trim(),
      vat:cleanMoney(f[6]),
      extra1:String(f[7] || '').trim() || null,
      extra2:String(f[8] || '').trim() || null,
      extra3:String(f[9] || '').trim() || null,
      raw:f
    });
  }
  return rows;
}

async function configAndCredentials() {
  const [rows, credentials] = await Promise.all([
    dbSelect('netcash_config', { select:'*', id:'eq.true', limit:1 }),
    loadNetcashCredentials()
  ]);
  return { config:rows?.[0] || null, credentials };
}

async function requestMerchantStatement(serviceKey, statementDate) {
  const result = await nifCall('RequestMerchantStatement', { ServiceKey:serviceKey, FromActionDate:date8(statementDate) });
  if (result === '100') throw new HttpError(401,'Netcash rejected the Account service key.','netcash_auth_failed');
  if (['101','102','200'].includes(result) || !result) throw new HttpError(502,`Netcash could not create statement ${statementDate}.`,'netcash_statement_request_failed');
  return result;
}
async function retrieveMerchantStatement(serviceKey, pollingId) {
  return nifCall('RetrieveMerchantStatement', { ServiceKey:serviceKey, PollingId:pollingId });
}
async function retrieveBatchStatus(serviceKey) {
  const result = await nifCall('RetrieveBatchStatus', { ServiceKey:serviceKey });
  if (['100','200','311'].includes(result)) throw new HttpError(502,'Netcash batch status could not be retrieved.','netcash_batch_status_failed');
  return result;
}
function parseBatchStatus(text) {
  return String(text || '').split(/\r?\n/).map(line => line.split('\t')).filter(f => f.length >= 4).map(f => ({
    serviceKey:f[0], batchId:f[1], batchName:f[2], status:String(f[3]), volume:Number(f[4] || 0), value:Number(f[5] || 0)
  }));
}

async function instructionForStatement(row) {
  if (row.extra1 && UUID.test(row.extra1)) {
    const direct = await dbSelect('netcash_collection_instructions', { select:'*', id:`eq.${row.extra1}`, limit:1 });
    if (direct?.[0]) return direct[0];
  }
  if (row.extra3 && UUID.test(row.extra3)) {
    const bySchedule = await dbSelect('netcash_collection_instructions', { select:'*', schedule_id:`eq.${row.extra3}`, limit:1 });
    if (bySchedule?.[0]) return bySchedule[0];
  }
  return null;
}

async function storeStatementRow(row) {
  const result = await supabaseRequest('/rest/v1/netcash_statement_entries?on_conflict=transaction_type,transaction_id', {
    method:'POST',
    body:{
      statement_date:row.statementDate, transaction_type:row.transactionType, transaction_id:row.transactionId,
      description:row.description, amount:row.amount, symbol:row.symbol, vat:row.vat,
      extra1:row.extra1, extra2:row.extra2, extra3:row.extra3, raw:{ fields:row.raw }
    },
    prefer:'resolution=ignore-duplicates,return=representation'
  });
  return result?.[0] || null;
}

async function processStatementRows(rows) {
  const summary = { received:rows.length, processed:0, ignored:0, reviewRequired:0, failed:0 };
  for (const row of rows) {
    let saved;
    try {
      saved = await storeStatementRow(row);
      if (!saved) continue;
      if (!SUCCESS_CODES.has(row.transactionType) && !RETURN_CODES.has(row.transactionType)) {
        await dbUpdate('netcash_statement_entries', { id:`eq.${saved.id}` }, { processing_status:'ignored', processing_message:'Not a debit-order settlement code.', processed_at:new Date().toISOString() });
        summary.ignored += 1;
        continue;
      }
      const instruction = await instructionForStatement(row);
      if (!instruction) {
        await dbUpdate('netcash_statement_entries', { id:`eq.${saved.id}` }, { processing_status:'review_required', processing_message:'Could not map Netcash statement row to a KredRun collection instruction.', processed_at:new Date().toISOString() });
        summary.reviewRequired += 1;
        continue;
      }
      const paidAt = `${row.statementDate}T12:00:00+02:00`;
      let result;
      if (SUCCESS_CODES.has(row.transactionType)) {
        result = await dbRpc('process_netcash_collection_success', {
          p_instruction_id:instruction.id,
          p_provider_reference:row.transactionId,
          p_paid_amount:row.amount,
          p_paid_at:paidAt,
          p_transaction_type:row.transactionType
        });
      } else {
        result = await dbRpc('process_netcash_collection_return', {
          p_instruction_id:instruction.id,
          p_provider_reference:row.transactionId,
          p_amount:row.amount || Number(instruction.amount),
          p_returned_at:paidAt,
          p_transaction_type:row.transactionType,
          p_reason_code:reasonCode(row.description)
        });
      }
      const review = result?.status === 'review_required';
      await dbUpdate('netcash_statement_entries', { id:`eq.${saved.id}` }, {
        processing_status:review ? 'review_required' : 'processed',
        processing_message:review ? String(result?.reason || 'Review required') : null,
        processed_at:new Date().toISOString()
      });
      if (review) summary.reviewRequired += 1; else summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      if (saved?.id) await dbUpdate('netcash_statement_entries', { id:`eq.${saved.id}` }, { processing_status:'failed', processing_message:String(error.message || error).slice(0,500), processed_at:new Date().toISOString() }).catch(()=>{});
    }
  }
  return summary;
}

export async function reconcileNetcashStatement() {
  const { config, credentials } = await configAndCredentials();
  if (!config?.enabled || config.validation_status !== 'validated' || !credentials?.accountServiceKey) return { skipped:true, reason:'account_service_not_ready' };
  const today = zaDate();
  const target = config.statement_last_reconciled_date ? addDays(config.statement_last_reconciled_date,1) : addDays(today,-1);
  if (target >= today) return { skipped:true, reason:'up_to_date' };
  let pollingId = config.statement_polling_id;
  if (!pollingId) {
    pollingId = await requestMerchantStatement(credentials.accountServiceKey, target);
    await dbUpdate('netcash_config', { id:'eq.true' }, { statement_polling_id:pollingId, statement_requested_at:new Date().toISOString(), updated_at:new Date().toISOString() });
  }
  const file = await retrieveMerchantStatement(credentials.accountServiceKey, pollingId);
  if (/FILE NOT READY/i.test(file)) return { pending:true, statementDate:target };
  if (/^NO CHANGE$/i.test(file)) {
    await dbUpdate('netcash_config', { id:'eq.true' }, { statement_last_reconciled_date:target, statement_polling_id:null, statement_requested_at:null, updated_at:new Date().toISOString() });
    return { statementDate:target, received:0, processed:0 };
  }
  const rows = parseStatement(file);
  const result = await processStatementRows(rows);
  await dbUpdate('netcash_config', { id:'eq.true' }, { statement_last_reconciled_date:target, statement_polling_id:null, statement_requested_at:null, updated_at:new Date().toISOString() });
  return { statementDate:target, ...result };
}

export async function syncNetcashMandates() {
  const { config, credentials } = await configAndCredentials();
  if (!config?.enabled || config.validation_status !== 'validated' || !credentials?.debitOrderServiceKey) return { skipped:true };
  if (!config.mandate_sync_token) {
    const token = await requestMandateData(credentials.debitOrderServiceKey);
    await dbUpdate('netcash_config', { id:'eq.true' }, { mandate_sync_token:token, mandate_sync_requested_at:new Date().toISOString(), updated_at:new Date().toISOString() });
    return { requested:true };
  }
  const file = await retrieveMandateData(credentials.debitOrderServiceKey, config.mandate_sync_token);
  if (/FILE NOT READY/i.test(file)) return { pending:true };
  const rows = parseMandateData(file);
  let updated = 0;
  for (const row of rows) {
    const contracts = await dbSelect('netcash_contracts', { select:'*', account_reference:`eq.${row.accountReference}`, limit:1 });
    const contract = contracts?.[0];
    if (!contract || contract.debicheck_auth_mode === 'tt1') continue;
    const state = mandateState(row.statusCode,row.active);
    await dbUpdate('netcash_contracts', { id:`eq.${contract.id}` }, {
      mandate_status:state.mandateStatus,
      provider_status:state.providerStatus,
      authenticated_at:state.mandateStatus==='accepted' ? (contract.authenticated_at || new Date().toISOString()) : contract.authenticated_at,
      activated_at:state.providerStatus==='active' ? (contract.activated_at || new Date().toISOString()) : contract.activated_at,
      last_error:state.providerStatus==='failed' ? `Netcash mandate status ${row.statusCode}` : null,
      provider_metadata:{ ...(contract.provider_metadata || {}), mandate_status_code:row.statusCode, mandate_active:row.active },
      updated_at:new Date().toISOString()
    });
    updated += 1;
  }
  await dbUpdate('netcash_config', { id:'eq.true' }, { mandate_sync_token:null, mandate_sync_requested_at:null, updated_at:new Date().toISOString() });
  return { updated };
}

export async function syncPendingTt1() {
  const { config, credentials } = await configAndCredentials();
  if (!config?.enabled || !credentials?.debitOrderServiceKey) return { skipped:true };
  const contracts = await dbSelect('netcash_contracts', {
    select:'*', debicheck_auth_mode:'eq.tt1', mandate_status:'eq.awaiting_authorisation', provider_contract_reference:'not.is.null', limit:100
  });
  let updated = 0;
  for (const contract of contracts || []) {
    try {
      const current = await debiCheckCurrentStatus(credentials.debitOrderServiceKey, contract.provider_contract_reference);
      const status = String(current.status || '').toLowerCase();
      const accepted = status === 'accepted';
      const rejected = ['rejected','cancelled','failed'].includes(status);
      await dbUpdate('netcash_contracts', { id:`eq.${contract.id}` }, {
        mandate_status:accepted ? 'accepted' : rejected ? 'rejected' : 'awaiting_authorisation',
        provider_status:accepted ? 'active' : rejected ? 'failed' : 'pending',
        authenticated_at:accepted ? (contract.authenticated_at || new Date().toISOString()) : contract.authenticated_at,
        activated_at:accepted ? (contract.activated_at || new Date().toISOString()) : contract.activated_at,
        last_error:rejected ? `DebiCheck TT1 ${current.status}` : null,
        provider_metadata:{ ...(contract.provider_metadata || {}), last_tt1_trace:current, last_tt1_trace_at:new Date().toISOString() },
        updated_at:new Date().toISOString()
      });
      updated += 1;
    } catch {}
  }
  return { updated };
}

async function cancelClosedDebicheckMandates(config, credentials) {
  if (!credentials?.debitOrderServiceKey) return { cancelled:0 };
  const contracts = await dbSelect('netcash_contracts', { select:'*', collection_stream:'eq.debicheck', mandate_status:'eq.accepted', provider_status:'eq.active', limit:200 });
  if (!contracts?.length) return { cancelled:0 };
  const loanIds = contracts.map(row => row.loan_id);
  const loans = await dbSelect('loans', { select:'id,status', id:`in.(${loanIds.join(',')})`, status:'in.(paid,cancelled,written_off)' });
  const closed = new Set((loans || []).map(row => row.id));
  let cancelled = 0;
  for (const contract of contracts) {
    if (!closed.has(contract.loan_id) || !contract.provider_contract_reference) continue;
    try {
      const response = await debiCheckCancelAuthentication(credentials.debitOrderServiceKey, contract.provider_contract_reference, 'CUST');
      if (response.errorCode === '000') {
        await dbUpdate('netcash_contracts', { id:`eq.${contract.id}` }, { mandate_status:'cancelled', provider_status:'cancelled', cancelled_at:new Date().toISOString(), cancellation_reason:'Loan closed in KredRun.', updated_at:new Date().toISOString() });
        cancelled += 1;
      } else {
        await dbUpdate('netcash_contracts', { id:`eq.${contract.id}` }, { provider_status:'review_required', last_error:`DebiCheck cancellation returned ${response.errorCode || 'unknown'}.`, updated_at:new Date().toISOString() });
      }
    } catch (error) {
      await dbUpdate('netcash_contracts', { id:`eq.${contract.id}` }, { provider_status:'review_required', last_error:String(error.message || error).slice(0,500), updated_at:new Date().toISOString() }).catch(()=>{});
    }
  }
  return { cancelled };
}

async function refreshPayNowRequests(config, credentials) {
  if (!credentials?.payNowServiceKey) return { updated:0 };
  const requests = await dbSelect('netcash_payment_requests', { select:'*', status:'eq.initializing', file_token:'not.is.null', limit:100 });
  let updated = 0;
  for (const request of requests || []) {
    try {
      const load = parseLoadReport(await requestFileUploadReport(credentials.payNowServiceKey, request.file_token));
      if (load.status === 'unsuccessful' || load.status === 'successful_with_errors') {
        await dbUpdate('netcash_payment_requests', { id:`eq.${request.id}` }, { status:'failed', failure_message:'Netcash rejected the Pay Now invoice batch.', provider_metadata:{ ...(request.provider_metadata || {}), load_report:load.raw.slice(0,12000) }, updated_at:new Date().toISOString() });
        continue;
      }
      const invoiceXml = await requestPayNowInvoice(credentials.payNowServiceKey, request.file_token);
      if (!invoiceXml || /FILE NOT READY/i.test(invoiceXml)) continue;
      const uniqueReference = tag(invoiceXml,'UniqueReference');
      const securityToken = tag(invoiceXml,'SecurityToken');
      await dbUpdate('netcash_payment_requests', { id:`eq.${request.id}` }, {
        provider_reference:uniqueReference || request.provider_reference,
        security_token:securityToken || request.security_token,
        status:'pending', notified_at:new Date().toISOString(), failure_message:null,
        provider_metadata:{ ...(request.provider_metadata || {}), invoice_ready:true, load_status:load.status },
        updated_at:new Date().toISOString()
      });
      updated += 1;
    } catch {}
  }
  return { updated };
}

async function eligibleCollectionRows(today) {
  const horizon = addDays(today,7);
  const instructions = await dbSelect('netcash_collection_instructions', {
    select:'*', status:'in.(planned,queued)', resubmission_blocked:'eq.false', due_date:`lte.${horizon}`, order:'due_date.asc', limit:500
  });
  if (!instructions?.length) return [];
  const contractIds = [...new Set(instructions.map(row => row.contract_id))];
  const loanIds = [...new Set(instructions.map(row => row.loan_id))];
  const scheduleIds = [...new Set(instructions.map(row => row.schedule_id))];
  const [contracts,loans,schedules,flows] = await Promise.all([
    dbSelect('netcash_contracts', { select:'*', id:`in.(${contractIds.join(',')})` }),
    dbSelect('loans', { select:'id,status,payout_status,outstanding_balance,debit_order_flow_id', id:`in.(${loanIds.join(',')})` }),
    dbSelect('repayment_schedule', { select:'*', id:`in.(${scheduleIds.join(',')})` }),
    dbSelect('debit_order_flows', { select:'id,is_default,applies_to,enabled,tracking_enabled,tracking_days', enabled:'eq.true', archived_at:'is.null', limit:100 }).catch(()=>[])
  ]);
  const c = new Map((contracts || []).map(row => [row.id,row]));
  const l = new Map((loans || []).map(row => [row.id,row]));
  const s = new Map((schedules || []).map(row => [row.id,row]));
  const flowById = new Map((flows || []).map(flow => [flow.id,flow]));
  const result = [];
  for (const row of instructions) {
    const contract = c.get(row.contract_id); const loan = l.get(row.loan_id); const schedule = s.get(row.schedule_id);
    if (!contract || contract.mandate_status !== 'accepted' || contract.provider_status !== 'active') continue;
    if (!loan || !['active','overdue'].includes(loan.status) || loan.payout_status !== 'paid' || Number(loan.outstanding_balance) <= 0) continue;
    if (!schedule || ['paid','waived'].includes(schedule.status)) continue;
    const remaining = Math.max(0, Number(schedule.amount_due) - Number(schedule.amount_paid || 0));
    if (remaining <= 0) {
      await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { status:'cancelled', cancelled_at:new Date().toISOString(), cancellation_reason:'No instalment balance remains.', updated_at:new Date().toISOString() });
      continue;
    }
    if (row.due_date < today) {
      await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { status:'review_required', last_error:'Past-due debit order will not be backdated. Use a catch-up payment request or create a new approved action date.', updated_at:new Date().toISOString() });
      continue;
    }
    let flow = row.debit_order_flow_id ? flowById.get(row.debit_order_flow_id) : null;
    if (!flow && loan.debit_order_flow_id) flow = flowById.get(loan.debit_order_flow_id) || null;
    if (!flow) flow = (flows || []).find(item => item.is_default && flowApplies(item,row.collection_stream)) || (flows || []).find(item => item.is_default) || (flows || []).find(item => flowApplies(item,row.collection_stream)) || null;
    const flowId = flow?.id || row.debit_order_flow_id || loan.debit_order_flow_id || null;
    const rowTrackingDays = row.collection_stream === 'debicheck'
      ? trackingDays(flow?.tracking_enabled === false ? 1 : (flow?.tracking_days ?? row.tracking_days ?? 1),1)
      : null;
    if ((flowId && row.debit_order_flow_id !== flowId) || (rowTrackingDays && Number(row.tracking_days) !== rowTrackingDays)) {
      await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, {
        ...(flowId ? { debit_order_flow_id:flowId } : {}),
        ...(rowTrackingDays ? { tracking_days:rowTrackingDays } : {}),
        updated_at:new Date().toISOString()
      }).catch(()=>{});
    }
    result.push({ ...row, amount:remaining, contract, schedule, flow, debit_order_flow_id:flowId, trackingDays:rowTrackingDays });
  }
  return result;
}

async function prepareAction(row, serviceKey, today) {
  if (row.collection_stream === 'debicheck') {
    return { actionDate:row.due_date, presentationDate:null, ready:daysBetween(today,row.due_date) <= 2 };
  }
  const instruction = batchInstruction(row.collection_stream);
  const actionDate = await requestActionDate(serviceKey,row.due_date,instruction,true);
  if (!actionDate) throw new Error('Netcash did not return a valid action date.');
  const presentationDate = await requestPresentationDate(serviceKey,actionDate,instruction);
  const ready = presentationDate ? daysBetween(today,presentationDate) <= 1 : daysBetween(today,actionDate) <= (row.collection_stream === 'efts' ? 1 : 3);
  return { actionDate, presentationDate, ready };
}

async function syncExistingBatchTokens(credentials) {
  const rows = await dbSelect('netcash_collection_instructions', { select:'*', status:'in.(queued,submitted)', file_token:'not.is.null', limit:300 });
  const byToken = new Map();
  for (const row of rows || []) {
    if (!byToken.has(row.file_token)) byToken.set(row.file_token,[]);
    byToken.get(row.file_token).push(row);
  }
  let updated = 0;
  for (const [token,items] of byToken) {
    try {
      const report = parseLoadReport(await requestFileUploadReport(credentials.debitOrderServiceKey,token));
      if (!report.ready) continue;
      const status = report.status === 'successful' ? 'submitted' : report.status === 'successful_with_errors' ? 'review_required' : 'failed';
      const auth = report.status === 'successful' ? 'manual_required' : 'failed';
      for (const row of items) {
        await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, {
          status, load_status:report.status, authorisation_status:auth,
          provider_result:report.raw.slice(0,12000),
          last_error:report.status === 'successful' ? 'Batch loaded. Authorise it in Netcash before the provider cut-off unless Auto Batch Authorization is active on the merchant account.' : 'Netcash load report requires review.',
          updated_at:new Date().toISOString()
        });
        updated += 1;
      }
    } catch {}
  }
  return { updated };
}

async function syncRecentBatchStatuses(credentials) {
  let parsed = [];
  try { parsed = parseBatchStatus(await retrieveBatchStatus(credentials.debitOrderServiceKey)); } catch { return { updated:0 }; }
  if (!parsed.length) return { updated:0 };
  const rows = await dbSelect('netcash_collection_instructions', { select:'*', status:'in.(submitted,accepted)', limit:300 });
  let updated = 0;
  for (const row of rows || []) {
    const match = parsed.find(item => (row.batch_id && item.batchId === row.batch_id) || (row.batch_name && item.batchName === row.batch_name));
    if (!match) continue;
    const authorisationStatus = match.status === '1' ? 'manual_required' : ['2','3'].includes(match.status) ? 'authorised' : match.status === '4' ? 'processed' : row.authorisation_status;
    const status = ['2','3'].includes(match.status) ? 'accepted' : row.status;
    await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { batch_id:match.batchId || row.batch_id, authorisation_status:authorisationStatus, status, updated_at:new Date().toISOString() });
    updated += 1;
  }
  return { updated };
}

export async function submitNetcashCollections() {
  const { config, credentials } = await configAndCredentials();
  if (!config?.enabled || config.validation_status !== 'validated' || !credentials?.debitOrderServiceKey) return { skipped:true, reason:'debit_service_not_ready' };
  const today = zaDate();
  await syncExistingBatchTokens(credentials);
  const candidates = await eligibleCollectionRows(today);
  const prepared = [];
  for (const row of candidates) {
    try {
      const timing = await prepareAction(row,credentials.debitOrderServiceKey,today);
      await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, {
        action_date:timing.actionDate,
        presentation_date:timing.presentationDate,
        amount:row.amount,
        ...(row.debit_order_flow_id ? { debit_order_flow_id:row.debit_order_flow_id } : {}),
        ...(row.collection_stream === 'debicheck' ? { tracking_days:row.trackingDays || 1 } : {}),
        updated_at:new Date().toISOString()
      });
      if (timing.ready) prepared.push({ ...row, ...timing });
    } catch (error) {
      await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { status:'review_required', last_error:String(error.message || error).slice(0,500), updated_at:new Date().toISOString() }).catch(()=>{});
    }
  }
  const groups = new Map();
  for (const row of prepared) {
    const key = `${row.collection_stream}|${row.actionDate}`;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(row);
  }
  let submitted = 0;
  let reviewRequired = 0;
  for (const [key,rows] of groups) {
    const [stream,actionDate] = key.split('|');
    const batchName = `KR-${batchPrefix(stream)}-${date8(actionDate)}-${String(rows[0].id).slice(0,8)}`.slice(0,50);
    for (const row of rows) await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { status:'queued', batch_name:batchName, action_date:actionDate, updated_at:new Date().toISOString() });
    const fileRows = rows.map(row => ({
      instructionId:row.id, accountReference:row.contract.account_reference, contractReference:row.contract.provider_contract_reference,
      amount:row.amount, loanId:row.loan_id, scheduleId:row.schedule_id, instalmentNumber:row.instalment_number,
      trackingDays:row.collection_stream === 'debicheck' ? trackingDays(row.trackingDays ?? row.tracking_days ?? config.tracking_days ?? 1,1) : 1
    }));
    try {
      const file = stream === 'debicheck'
        ? buildDebiCheckBatch({ serviceKey:credentials.debitOrderServiceKey, softwareVendorKey:config.software_vendor_key, batchName, actionDate, rows:fileRows, trackingDays:trackingDays(config.tracking_days || 1,1) })
        : buildStandardDebitBatch({ serviceKey:credentials.debitOrderServiceKey, softwareVendorKey:config.software_vendor_key, batchName, actionDate, rows:fileRows, stream });
      const token = await batchFileUpload(credentials.debitOrderServiceKey,file);
      const report = parseLoadReport(await requestFileUploadReport(credentials.debitOrderServiceKey,token));
      for (const row of rows) {
        const success = report.status === 'successful';
        await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, {
          file_token:token,
          submitted_at:new Date().toISOString(),
          load_status:report.status,
          status:success ? 'submitted' : report.ready ? 'review_required' : 'queued',
          authorisation_status:success ? 'manual_required' : report.ready ? 'failed' : 'unknown',
          provider_result:report.raw.slice(0,12000),
          last_error:success ? 'Batch loaded. Authorise in Netcash before cut-off unless the merchant account has approved Auto Batch Authorization.' : report.ready ? 'Netcash load report requires review.' : null,
          updated_at:new Date().toISOString()
        });
        if (success) submitted += 1; else if (report.ready) reviewRequired += 1;
      }
    } catch (error) {
      for (const row of rows) await dbUpdate('netcash_collection_instructions', { id:`eq.${row.id}` }, { status:'review_required', last_error:String(error.message || error).slice(0,500), updated_at:new Date().toISOString() }).catch(()=>{});
      reviewRequired += rows.length;
    }
  }
  const batchStatus = await syncRecentBatchStatuses(credentials);
  return { candidates:candidates.length, submitted, reviewRequired, batchStatusUpdated:batchStatus.updated };
}

export async function runNetcashMaintenance() {
  const { config, credentials } = await configAndCredentials();
  if (!config?.enabled || config.validation_status !== 'validated') return { skipped:true, reason:'netcash_disabled' };
  const result = {};
  result.tt1 = await syncPendingTt1().catch(error => ({ error:error.message }));
  result.mandates = await syncNetcashMandates().catch(error => ({ error:error.message }));
  result.closedMandates = await cancelClosedDebicheckMandates(config,credentials).catch(error => ({ error:error.message }));
  result.payNow = await refreshPayNowRequests(config,credentials).catch(error => ({ error:error.message }));
  result.collections = await submitNetcashCollections().catch(error => ({ error:error.message }));
  result.statement = await reconcileNetcashStatement().catch(error => ({ error:error.message }));
  return result;
}
