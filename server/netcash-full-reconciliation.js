import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbRpc, dbSelect, dbUpdate, supabaseRequest } from './supabase-rest.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECT_SUCCESS=new Set(['TDD','SDD','DCS']);
const DIRECT_RETURN=new Set(['DRU','DCX','DCD']);
const CARD_SUCCESS=new Set(['TDC','SDC']);
const CARD_RETURN=new Set(['DCU','DRC']);
const PAYOUT_SUCCESS=new Set(['CRP','DCP','CRT','PSC']);
const PAYOUT_RETURN=new Set(['CRU','CRR','CRJ','PCR','PCI','PCU']);
const PAYNOW_SUCCESS=new Set(['PNC','PNP','PNM','PNE','PIA','PIS','PIF','PVC','PFC','PGC','PMW','PME']);
const PAYNOW_REFUND=new Set(['PNR','PNX','PIR','PVR','PFR','PGR']);
const RM_CODES=new Set(['RMS','RMX','RMT','RMD','RPS','RMM']);
const MANDATE_CODES=new Set(['ELM','DCM','DCT','DPS']);

function sha(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex');}
function money(value){const n=Math.abs(Number(value||0));return Math.round(n*100)/100;}
function eventTime(row){const raw=String(row.statementDate||row.transactionDate||'').replace(/-/g,'');return /^\d{8}$/.test(raw)?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T12:00:00+02:00`:new Date().toISOString();}
function referenceCandidates(row){return [...new Set([row.extra1,row.extra2,row.extra3,row.transactionId].map(v=>String(v||'').trim()).filter(Boolean))];}
function reasonCode(description){return (String(description||'').match(/(?:code\s*:?\s*|[-\s])(\d{2})(?:\D|$)/i)||[])[1]||null;}

async function instructionFor(row){
  if(UUID.test(String(row.extra1||''))){const x=await dbSelect('netcash_collection_instructions',{select:'*',id:`eq.${row.extra1}`,limit:1});if(x?.[0])return x[0];}
  if(UUID.test(String(row.extra3||''))){const x=await dbSelect('netcash_collection_instructions',{select:'*',schedule_id:`eq.${row.extra3}`,limit:1});if(x?.[0])return x[0];}
  return null;
}
async function cardDebitFor(row){
  for(const ref of referenceCandidates(row)){if(!UUID.test(ref))continue;const x=await dbSelect('netcash_card_debit_orders',{select:'*',id:`eq.${ref}`,limit:1});if(x?.[0])return x[0];}
  return null;
}
async function payoutFor(row){
  for(const ref of referenceCandidates(row)){if(!UUID.test(ref))continue;const x=await dbSelect('netcash_payouts',{select:'*',id:`eq.${ref}`,limit:1});if(x?.[0])return x[0];}
  return null;
}
async function classicPaymentRequestFor(row){
  for(const ref of referenceCandidates(row)){if(UUID.test(ref)){const byId=await dbSelect('netcash_payment_requests',{select:'*',id:`eq.${ref}`,limit:1});if(byId?.[0])return byId[0];}const byRef=await dbSelect('netcash_payment_requests',{select:'*',reference:`eq.${ref}`,limit:1}).catch(()=>[]);if(byRef?.[0])return byRef[0];}
  return null;
}
async function payNowOperationFor(row){
  for(const ref of referenceCandidates(row)){const byRef=await dbSelect('netcash_paynow_operations',{select:'*',reference:`eq.${ref}`,limit:1}).catch(()=>[]);if(byRef?.[0])return byRef[0];}
  const candidates=await dbSelect('netcash_paynow_operations',{select:'*',status:'in.(created,pending,active,authorisation_required)',order:'created_at.desc',limit:100}).catch(()=>[]);
  const desc=String(row.description||'');
  return (candidates||[]).find(op=>desc.includes(op.reference))||null;
}
async function pendingRefundFor(row){
  const refs=referenceCandidates(row);const description=String(row.description||'');
  const candidates=await dbSelect('netcash_paynow_operations',{select:'*',kind:'in.(refund,batch_refund)',status:'in.(authorisation_required,pending,succeeded)',order:'created_at.desc',limit:100}).catch(()=>[]);
  return (candidates||[]).find(op=>refs.includes(String(op.transaction_id||''))||refs.includes(String(op.reference||''))||description.includes(String(op.transaction_id||''))||description.includes(String(op.reference||'')))||null;
}

export async function processNetcashStatementTransaction(row){
  const type=String(row.transactionType||'').trim().toUpperCase();const amount=money(row.amount);const at=eventTime(row);
  if(DIRECT_SUCCESS.has(type)||DIRECT_RETURN.has(type)){
    const instruction=await instructionFor(row);if(!instruction)return{status:'review_required',reason:'Could not map debit-order statement row to a KredRun instruction.'};
    if(DIRECT_SUCCESS.has(type))return dbRpc('process_netcash_collection_success',{p_instruction_id:instruction.id,p_provider_reference:row.transactionId,p_paid_amount:amount,p_paid_at:at,p_transaction_type:type});
    return dbRpc('process_netcash_collection_return',{p_instruction_id:instruction.id,p_provider_reference:row.transactionId,p_amount:amount||Number(instruction.amount),p_returned_at:at,p_transaction_type:type,p_reason_code:reasonCode(row.description)});
  }
  if(CARD_SUCCESS.has(type)||CARD_RETURN.has(type)){
    const card=await cardDebitFor(row);if(!card)return{status:'review_required',reason:'Could not map tokenised card debit-order statement row.'};
    if(CARD_SUCCESS.has(type)){
      const result=await dbRpc('process_netcash_external_payment_success',{p_loan_id:card.loan_id,p_schedule_id:card.schedule_id,p_provider_reference:row.transactionId,p_paid_amount:amount,p_paid_at:at,p_channel:'card_debit_order'});
      await dbUpdate('netcash_card_debit_orders',{id:`eq.${card.id}`},{status:result?.status==='review_required'?'review_required':'paid',transaction_id:row.transactionId,provider_result:{...(card.provider_result||{}),statement_type:type},updated_at:new Date().toISOString()});return result;
    }
    if(!card.transaction_id)return{status:'review_required',reason:'Card debit return arrived before a successful card debit transaction was mapped.'};
    const result=await dbRpc('process_netcash_external_payment_return',{p_original_provider_reference:card.transaction_id,p_return_provider_reference:row.transactionId,p_amount:amount||Number(card.amount),p_returned_at:at,p_channel:'card_debit_order_return'});
    await dbUpdate('netcash_card_debit_orders',{id:`eq.${card.id}`},{status:result?.status==='review_required'?'review_required':'returned',provider_result:{...(card.provider_result||{}),return_transaction_id:row.transactionId,statement_type:type},updated_at:new Date().toISOString()});return result;
  }
  if(PAYOUT_SUCCESS.has(type)||PAYOUT_RETURN.has(type)){
    const payout=await payoutFor(row);if(!payout)return{status:'review_required',reason:'Could not map Netcash creditor-payment statement row to a payout.'};
    return dbRpc('process_netcash_payout_statement',{p_payout_id:payout.id,p_transaction_id:row.transactionId,p_transaction_type:type,p_amount:amount,p_processed_at:at,p_is_return:PAYOUT_RETURN.has(type)});
  }
  if(PAYNOW_SUCCESS.has(type)){
    const request=await classicPaymentRequestFor(row);
    if(request)return dbRpc('process_netcash_payment',{p_request_id:request.id,p_provider_reference:row.transactionId,p_paid_amount:amount,p_paid_at:at,p_channel:type});
    const op=await payNowOperationFor(row);if(!op||!op.loan_id)return{status:'review_required',reason:'Could not map Pay Now eCommerce/QR/subscription statement row to a KredRun loan.'};
    const result=await dbRpc('process_netcash_external_payment_success',{p_loan_id:op.loan_id,p_schedule_id:op.schedule_id||null,p_provider_reference:row.transactionId,p_paid_amount:amount,p_paid_at:at,p_channel:op.kind||type});
    await dbUpdate('netcash_paynow_operations',{id:`eq.${op.id}`},{status:result?.status==='review_required'?'review_required':'succeeded',transaction_id:row.transactionId,provider_metadata:{...(op.provider_metadata||{}),statement_type:type},updated_at:new Date().toISOString()});return result;
  }
  if(PAYNOW_REFUND.has(type)){
    const refund=await pendingRefundFor(row);if(!refund?.transaction_id)return{status:'review_required',reason:'Could not map Netcash refund to its original payment transaction.'};
    const result=await dbRpc('process_netcash_external_payment_return',{p_original_provider_reference:refund.transaction_id,p_return_provider_reference:row.transactionId,p_amount:amount||Number(refund.amount),p_returned_at:at,p_channel:'paynow_refund'});
    await dbUpdate('netcash_paynow_operations',{id:`eq.${refund.id}`},{status:result?.status==='review_required'?'review_required':'refunded',provider_metadata:{...(refund.provider_metadata||{}),refund_transaction_id:row.transactionId,statement_type:type},updated_at:new Date().toISOString()});return result;
  }
  if(RM_CODES.has(type))return{status:'registered_mandate',transactionType:type};
  if(MANDATE_CODES.has(type))return{status:'mandate_event',transactionType:type};
  return{status:'informational',transactionType:type};
}

export function parseNetcashBulkStatement(text){
  let fileDate=null,softwareVendorKey=null,current=null;const result=[];
  for(const line of String(text||'').split(/\r?\n/)){
    if(!line.trim())continue;const f=line.split('\t');
    if(f[0]==='FH'){fileDate=f[1]||null;softwareVendorKey=f[2]||null;continue;}
    if(f[0]==='SH'){current={statementDate:f[1],accountNumber:f[2],accountServiceKey:f[3]};continue;}
    if(f[0]==='SF'){current=null;continue;}if(f[0]==='FF')break;if(!current||f.length<7)continue;
    const transactionDate=String(f[0]||'').trim();if(!/^\d{8}$/.test(transactionDate))continue;
    result.push({fileDate,softwareVendorKey,statementDate:current.statementDate,netcashAccountNumber:current.accountNumber,accountServiceKey:current.accountServiceKey,transactionDate,transactionType:String(f[1]||'').trim().toUpperCase(),transactionId:String(f[2]||'').trim(),description:String(f[3]||''),amount:money(Number(f[4]||0)/100),symbol:String(f[5]||''),vat:money(Number(f[6]||0)/100),extra1:String(f[7]||'').trim()||null,extra2:String(f[8]||'').trim()||null,extra3:String(f[9]||'').trim()||null,raw:f});
  }
  return result;
}
function dateIso(raw){const d=String(raw||'').replace(/-/g,'');return /^\d{8}$/.test(d)?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:null;}
export async function ingestNetcashBulkStatement(text){
  const config=(await dbSelect('netcash_config',{select:'*',id:'eq.true',limit:1}))?.[0]||{};if(!config.bulk_statement_enabled)throw new HttpError(409,'Netcash Bulk Statement is disabled.','bulk_statement_disabled');
  const credentials=await loadNetcashCredentials();const entries=parseNetcashBulkStatement(text);let received=0,processed=0,reviewRequired=0,otherTenant=0;
  for(const row of entries){
    const saved=await supabaseRequest('/rest/v1/netcash_bulk_statement_entries?on_conflict=netcash_account_number,transaction_type,transaction_id',{method:'POST',body:{file_date:dateIso(row.fileDate),software_vendor_key:row.softwareVendorKey,statement_date:dateIso(row.statementDate)||dateIso(row.transactionDate),netcash_account_number:row.netcashAccountNumber,account_service_key_hash:sha(row.accountServiceKey),transaction_type:row.transactionType,transaction_id:row.transactionId,description:row.description,amount:row.amount,symbol:row.symbol,vat:row.vat,extra1:row.extra1,extra2:row.extra2,extra3:row.extra3,raw:{fields:row.raw}},prefer:'resolution=ignore-duplicates,return=representation'});
    if(!saved?.[0])continue;received+=1;
    const belongsHere=row.netcashAccountNumber===config.account_number&&credentials?.accountServiceKey&&sha(row.accountServiceKey)===sha(credentials.accountServiceKey);
    if(!belongsHere){otherTenant+=1;continue;}
    let result;try{result=await processNetcashStatementTransaction(row);}catch(error){result={status:'review_required',reason:error.message||'Statement processing failed'};}
    const review=result?.status==='review_required';await dbUpdate('netcash_bulk_statement_entries',{id:`eq.${saved[0].id}`},{processing_status:review?'review_required':'processed',processing_message:review?String(result.reason||'Review required').slice(0,500):null,processed_at:new Date().toISOString()});if(review)reviewRequired+=1;else processed+=1;
  }
  return{entries:entries.length,received,processed,reviewRequired,otherTenant};
}
