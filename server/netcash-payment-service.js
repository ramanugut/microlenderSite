import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { batchFileUpload, buildPayNowInvoiceFile, requestFileUploadReport, requestPayNowInvoice } from './netcash.js';
import { loadPaymentQuote, validCustomerEmail } from './loan-payments.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbInsert, dbSelect, dbUpdate, logCommunication } from './supabase-rest.js';

function reference() {
  return `KR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0,25);
}

function johannesburgEndOfDay(asOf) {
  return `${String(asOf).slice(0,10)}T23:59:59+02:00`;
}

async function settings(paymentType, source) {
  const [lenderRows, netcashRows, credentials] = await Promise.all([
    dbSelect('lender_settings',{ select:'payment_request_provider,settlement_payments_enabled,automatic_payment_requests',id:'eq.true',limit:1 }),
    dbSelect('netcash_config',{ select:'*',id:'eq.true',limit:1 }),
    loadNetcashCredentials()
  ]);
  const lender = lenderRows?.[0] || {};
  const netcash = netcashRows?.[0] || {};
  if (lender.payment_request_provider !== 'netcash') throw new HttpError(409,'Netcash is not the active payment-request provider.','provider_not_active');
  if (!netcash.enabled || netcash.validation_status !== 'validated' || !netcash.payment_requests_enabled || !credentials?.payNowServiceKey) {
    throw new HttpError(409,'Netcash Pay Now is not connected and enabled.','netcash_paynow_not_ready');
  }
  if (paymentType === 'settlement' && !lender.settlement_payments_enabled) throw new HttpError(409,'Early settlement payments are disabled.','settlements_disabled');
  if (source === 'automatic' && !lender.automatic_payment_requests) throw new HttpError(409,'Automatic payment requests are disabled.','automatic_requests_disabled');
  return { lender,netcash,credentials };
}

function tag(source,name) {
  const match = String(source || '').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'));
  return match ? match[1].trim().replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&') : null;
}

function loadReportState(raw) {
  const text = String(raw || '').trim();
  if (!text || /FILE NOT READY/i.test(text)) return { ready:false,status:'file_not_ready' };
  const begin = text.split(/\r?\n/).find(line => line.startsWith('###BEGIN')) || '';
  const result = String(begin.split('\t')[2] || '').trim().toUpperCase();
  if (result === 'SUCCESSFUL') return { ready:true,status:'successful' };
  if (result === 'SUCCESSFUL WITH ERRORS') return { ready:true,status:'successful_with_errors' };
  if (result === 'UNSUCCESSFUL' || /^100$|^200$/.test(text) || text.includes('###ERROR')) return { ready:true,status:'unsuccessful' };
  return { ready:false,status:'processing' };
}

async function tryInvoice(serviceKey,fileToken) {
  for (let attempt=0;attempt<3;attempt+=1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve,650));
    const xml = await requestPayNowInvoice(serviceKey,fileToken);
    if (!xml || /FILE NOT READY/i.test(xml)) continue;
    return {
      clientReference:tag(xml,'ClientReference'), uniqueReference:tag(xml,'UniqueReference'), securityToken:tag(xml,'SecurityToken'), raw:xml.slice(0,12000)
    };
  }
  return null;
}

async function assertNoCollectionConflict(quote,paymentType) {
  if (paymentType === 'instalment' && quote.schedule?.id) {
    const activeDebit = await dbSelect('netcash_collection_instructions',{
      select:'id,status,action_date,due_date',schedule_id:`eq.${quote.schedule.id}`,status:'in.(queued,submitted,accepted)',limit:1
    });
    if (activeDebit?.length) {
      throw new HttpError(409,'A Netcash debit order is already queued or submitted for this instalment. Do not send a Pay Now request until that debit is cancelled, fails or is reconciled.','netcash_collection_already_active');
    }
    const pending = await dbSelect('netcash_payment_requests',{ select:'id',schedule_id:`eq.${quote.schedule.id}`,status:'in.(initializing,pending)',limit:1 });
    if (pending?.length) throw new HttpError(409,'A Netcash payment request is already active for this instalment.','payment_request_exists');
    return;
  }
  if (paymentType === 'settlement') {
    const pendingSettlement = await dbSelect('netcash_payment_requests',{ select:'id',loan_id:`eq.${quote.loan.id}`,payment_type:'eq.settlement',status:'in.(initializing,pending)',limit:1 });
    if (pendingSettlement?.length) throw new HttpError(409,'A Netcash settlement request is already active for this loan.','settlement_request_exists');
    const activeDebit = await dbSelect('netcash_collection_instructions',{
      select:'id,status,action_date,due_date',loan_id:`eq.${quote.loan.id}`,status:'in.(submitted,accepted)',limit:1
    });
    if (activeDebit?.length) {
      throw new HttpError(409,'A debit-order batch for this loan has already been submitted. Cancel or resolve that batch before sending an early-settlement request.','settlement_conflicts_with_submitted_debit');
    }
  }
}

export async function sendNetcashPaymentRequest({ loanId,scheduleId=null,paymentType='instalment',source='manual',triggerKind='manual',initiatedBy=null,userId=null }) {
  const { netcash,credentials } = await settings(paymentType,source);
  const quote = await loadPaymentQuote({ loanId,scheduleId,paymentType,userId });
  if (!quote.profile) throw new HttpError(409,'The client profile could not be found.','customer_profile_required');
  const email = validCustomerEmail(quote.profile.email);
  const mobile = String(quote.profile.mobile || '').trim();
  if (netcash.send_email && !email && netcash.send_sms && !mobile) throw new HttpError(409,'The client needs an email address or mobile number for a Netcash payment request.','customer_contact_required');
  if (netcash.send_email && !email && !netcash.send_sms) throw new HttpError(409,'The client needs a valid email address for Netcash payment requests.','customer_email_required');
  if (netcash.send_sms && !mobile && !netcash.send_email) throw new HttpError(409,'The client needs a mobile number for Netcash payment requests.','customer_mobile_required');
  await assertNoCollectionConflict(quote,paymentType);

  const ref = reference();
  const expiresAt = paymentType === 'settlement' ? johannesburgEndOfDay(quote.asOf) : null;
  let created;
  try {
    created = await dbInsert('netcash_payment_requests',{
      loan_id:quote.loan.id,schedule_id:quote.schedule?.id || null,user_id:quote.loan.user_id,
      payment_type:paymentType,source,trigger_kind:triggerKind,amount:quote.amount,due_date:quote.dueDate,
      reference:ref,status:'initializing',expires_at:expiresAt,
      provider_metadata:{ quote_as_of:quote.asOf,quote_components:quote.components,initiated_by:initiatedBy || null }
    });
  } catch (error) {
    if (paymentType === 'settlement' && (error.databaseCode === '23505' || error.code === '23505')) {
      throw new HttpError(409,'A Netcash settlement request is already active for this loan.','settlement_request_exists');
    }
    throw error;
  }
  const local = created?.[0];
  if (!local) throw new HttpError(502,'The Netcash payment request could not be saved.','database_error');

  const account = quote.loan.account_number || 'loan account';
  const description = paymentType === 'settlement' ? `Early settlement ${account}` : `Instalment ${quote.schedule.instalment_number} ${account}`;
  const batchName = `KR-PAYNOW-${ref}`.slice(0,50);
  const file = buildPayNowInvoiceFile({
    serviceKey:credentials.payNowServiceKey,softwareVendorKey:netcash.software_vendor_key,batchName,reference:ref,
    amount:quote.amount,description,email,mobile,sendSms:netcash.send_sms,sendEmail:netcash.send_email,
    extra1:local.id,extra2:quote.loan.id,extra3:quote.schedule?.id || ''
  });

  try {
    const fileToken = await batchFileUpload(credentials.payNowServiceKey,file);
    let reportRaw = '';
    try { reportRaw = await requestFileUploadReport(credentials.payNowServiceKey,fileToken); } catch {}
    const report = loadReportState(reportRaw);
    if (report.ready && report.status !== 'successful') {
      await dbUpdate('netcash_payment_requests',{ id:`eq.${local.id}` },{
        file_token:fileToken,status:'failed',failure_message:`Netcash Pay Now load report: ${report.status}.`,
        provider_metadata:{ ...local.provider_metadata,batch_name:batchName,load_status:report.status,load_report:String(reportRaw).slice(0,12000) },updated_at:new Date().toISOString()
      });
      throw new HttpError(409,'Netcash rejected the Pay Now invoice batch.','netcash_paynow_load_failed');
    }
    const invoice = await tryInvoice(credentials.payNowServiceKey,fileToken);
    const ready = Boolean(invoice?.uniqueReference || invoice?.securityToken);
    const updatedRows = await dbUpdate('netcash_payment_requests',{ id:`eq.${local.id}` },{
      file_token:fileToken,
      security_token:ready ? (invoice.securityToken || null) : null,
      provider_reference:ready ? (invoice.uniqueReference || ref) : null,
      status:ready ? 'pending' : 'initializing',
      notified_at:ready ? new Date().toISOString() : null,
      failure_message:null,
      provider_metadata:{ ...local.provider_metadata,batch_name:batchName,client_reference:invoice?.clientReference || null,invoice_ready:ready,load_status:report.status },
      updated_at:new Date().toISOString()
    });
    await logCommunication({
      userId:quote.loan.user_id,loanId:quote.loan.id,createdBy:initiatedBy,
      subject:paymentType === 'settlement' ? 'Netcash early settlement request' : 'Netcash instalment payment request',
      message:ready
        ? `Netcash Pay Now request ${ref} sent for R${quote.amount.toFixed(2)} due ${quote.dueDate}.`
        : `Netcash Pay Now request ${ref} queued for R${quote.amount.toFixed(2)} while Netcash prepares the invoice.`
    });
    return { request:updatedRows?.[0] || local,quote,invoiceReady:ready };
  } catch (error) {
    if (error?.code !== 'netcash_paynow_load_failed') {
      await dbUpdate('netcash_payment_requests',{ id:`eq.${local.id}` },{ status:'failed',failure_message:String(error.message || 'Netcash request failed').slice(0,500),updated_at:new Date().toISOString() }).catch(()=>{});
    }
    throw error;
  }
}
