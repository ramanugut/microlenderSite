import { allowMethod, HttpError, readRawBody, requestBody, requireUuid, sendError } from '../server/http.js';
import { runNetcashLenderMaintenance } from '../server/netcash-lender-maintenance.js';
import { ingestNetcashBulkStatement } from '../server/netcash-full-reconciliation.js';
import { sendNetcashPaymentRequest } from '../server/netcash-payment-service.js';
import { checkPayNowTransaction } from '../server/netcash-reconciliation.js';
import { debiCheckCurrentStatus } from '../server/netcash-debicheck.js';
import { setupNetcashLoan } from '../server/netcash-loan-setup.js';
import { ensureNetcashAvsForLoan } from '../server/netcash-avs.js';
import { syncNetcashAuthorisationTasks } from '../server/netcash-authorisation-tasks.js';
import { loadNetcashCredentials } from '../server/provider-secrets.js';
import { verifyNetcashEMandate } from '../server/netcash-emandate-verification.js';
import { enforceRateLimit } from '../server/security.js';
import {
  getNetcashAccountControls,disburseNetcashLoan,retrieveNetcashProofOfPayment,syncDebiCheckParticipatingBanks,amendNetcashDebiCheck,
  createSynchronousEMandate,requestEMandatePdf,updateEMandateMasterfile,createPayNowEcommerce,createPayNowQr,updateNetcashSubscription,
  deleteNetcashSubscription,requestNetcashRefund,validateSouthAfricanId,submitIdVerification,submitBulkAvs,createCardTokenizationSession,
  saveCardTokenReturn,submitCreditCardDebitOrder,syncBlockedAccounts,requestRegisteredMandateFallback
} from '../server/netcash-lender-suite.js';
import { dbRpc, dbSelect, dbUpdate, requireStaff, requireUser } from '../server/supabase-rest.js';

const EMANDATE_REFERENCE=/^[A-Za-z0-9._-]{3,50}$/;
function truthy(value){return['true','1','yes'].includes(String(value||'').trim().toLowerCase());}
function money(value){const n=Number(String(value||'').replace(/,/g,''));return Number.isFinite(n)?Math.round(n*100)/100:NaN;}
function origin(req){const proto=String(req.headers['x-forwarded-proto']||'https').split(',')[0],host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0];return `${proto}://${host}`;}
function safeReportedText(value,max=180){return String(value||'').trim().slice(0,max)||null;}
async function staffAction(req,roles=['owner','manager','collections']){const{user}=await requireUser(req);await requireStaff(user.id,roles);return user;}

async function clientRequest(req,res){const{user}=await requireUser(req),body=requestBody(req),loanId=requireUuid(body.loanId,'Loan'),paymentType=String(body.paymentType||'instalment');if(!['instalment','settlement'].includes(paymentType))throw new HttpError(400,'Choose instalment or settlement.','invalid_payment_type');const scheduleId=body.scheduleId?requireUuid(body.scheduleId,'Instalment'):null,result=await sendNetcashPaymentRequest({loanId,scheduleId,paymentType,userId:user.id,source:'client',triggerKind:'client_checkout'});return res.status(201).json({ok:true,provider:'netcash',requestId:result.request.id,amount:result.quote.amount,dueDate:result.quote.dueDate,message:result.invoiceReady?'Netcash sent your secure payment request. Check your SMS or email.':'Netcash is preparing your secure payment request. It will be sent when the invoice is ready.'});}
async function adminRequest(req,res){const user=await staffAction(req),body=requestBody(req),loanId=requireUuid(body.loanId,'Loan'),paymentType=String(body.paymentType||'instalment');if(!['instalment','settlement'].includes(paymentType))throw new HttpError(400,'Choose instalment or settlement.','invalid_payment_type');const scheduleId=body.scheduleId?requireUuid(body.scheduleId,'Instalment'):null,result=await sendNetcashPaymentRequest({loanId,scheduleId,paymentType,source:'admin',triggerKind:'manual',initiatedBy:user.id});return res.status(201).json({ok:true,provider:'netcash',requestId:result.request.id,amount:result.quote.amount,message:result.invoiceReady?'Netcash Pay Now request sent by SMS/email.':'Netcash Pay Now request queued while the invoice is prepared.'});}
async function loanSetup(req,res){const user=await staffAction(req,['owner','manager','collections','underwriter']),body=requestBody(req),loanId=requireUuid(body.loanId,'Loan'),avs=await ensureNetcashAvsForLoan(loanId),result=await setupNetcashLoan({loanId,stream:body.stream||null,authMode:body.authMode||null,staffId:user.id});return res.status(result.skipped||result.idempotent?200:201).json({ok:true,avs:avs?.verification?{status:avs.verification.status,verifiedAt:avs.verification.verified_at||null,cached:Boolean(avs.cached)}:{skipped:Boolean(avs?.skipped),reason:avs?.reason||null},...result});}
async function maintenance(req,res){await staffAction(req);const result=await runNetcashLenderMaintenance(),authorisationTasks=await syncNetcashAuthorisationTasks().catch(error=>({error:error.message||'Netcash authorisation task sync failed'}));return res.status(200).json({ok:true,result:{...result,authorisationTasks}});}

async function payNowNotify(req,res){
  const raw=await readRawBody(req,64*1024),form=new URLSearchParams(raw.toString('utf8')),accepted=truthy(form.get('TransactionAccepted')),trace=String(form.get('RequestTrace')||'').trim(),reference=String(form.get('Reference')||'').trim(),postedAmount=money(form.get('Amount'));
  if(!trace||!reference||!Number.isFinite(postedAmount))throw new HttpError(400,'Netcash notification is incomplete.','invalid_netcash_notify');
  const verified=await checkPayNowTransaction(trace),verifiedAccepted=truthy(verified.TransactionAccepted),verifiedAmount=money(verified.Amount),verifiedReference=String(verified.Reference||'').trim();
  if(verifiedReference!==reference||Math.round(verifiedAmount*100)!==Math.round(postedAmount*100))throw new HttpError(409,'Netcash notification did not match the verified transaction.','payment_mismatch');
  let rows=await dbSelect('netcash_payment_requests',{select:'*',reference:`eq.${reference}`,limit:1});if(!rows?.length)rows=await dbSelect('netcash_payment_requests',{select:'*',provider_reference:`eq.${reference}`,limit:1});const request=rows?.[0];
  if(request){if(Math.round(verifiedAmount*100)!==Math.round(Number(request.amount)*100))throw new HttpError(409,'Netcash payment amount does not match the request.','payment_mismatch');if(!accepted||!verifiedAccepted){await dbUpdate('netcash_payment_requests',{id:`eq.${request.id}`},{provider_metadata:{...(request.provider_metadata||{}),request_trace:trace,last_notify_accepted:false,reason:verified.Reason||form.get('Reason')||null},updated_at:new Date().toISOString()});return res.status(200).json({ok:true,processed:false,accepted:false});}const result=await dbRpc('process_netcash_payment',{p_request_id:request.id,p_provider_reference:trace,p_paid_amount:verifiedAmount,p_paid_at:new Date().toISOString(),p_channel:String(form.get('Method')||'')||null});return res.status(200).json({ok:true,processed:true,result});}
  const op=(await dbSelect('netcash_paynow_operations',{select:'*',reference:`eq.${reference}`,limit:1}))?.[0];if(!op)return res.status(200).json({ok:true,processed:false});
  if(!accepted||!verifiedAccepted){await dbUpdate('netcash_paynow_operations',{id:`eq.${op.id}`},{status:'failed',transaction_id:trace,provider_metadata:{...(op.provider_metadata||{}),notify:Object.fromEntries(form)},updated_at:new Date().toISOString()});return res.status(200).json({ok:true,processed:false,accepted:false});}
  if(!op.loan_id)throw new HttpError(409,'Netcash payment operation is not linked to a loan.','payment_mapping_required');
  const result=await dbRpc('process_netcash_external_payment_success',{p_loan_id:op.loan_id,p_schedule_id:op.schedule_id||null,p_provider_reference:trace,p_paid_amount:verifiedAmount,p_paid_at:new Date().toISOString(),p_channel:op.kind||String(form.get('Method')||'paynow')});
  await dbUpdate('netcash_paynow_operations',{id:`eq.${op.id}`},{status:result?.status==='review_required'?'review_required':'succeeded',transaction_id:trace,provider_metadata:{...(op.provider_metadata||{}),notify:Object.fromEntries(form),verified:true},updated_at:new Date().toISOString()});return res.status(200).json({ok:true,processed:result?.status!=='review_required',result});
}

async function debicheckPostback(req,res){const raw=await readRawBody(req,64*1024);let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Invalid Netcash DebiCheck postback.','invalid_netcash_postback');}const accountReference=String(payload.AccountReference||payload.accountReference||'').trim(),contractReference=String(payload.ContractReference||payload.contractReference||'').trim();if(!accountReference||!/^NC[0-9A-Za-z]{6,48}$/.test(contractReference))throw new HttpError(400,'Netcash DebiCheck postback is incomplete.','invalid_netcash_postback');const contract=(await dbSelect('netcash_contracts',{select:'*',account_reference:`eq.${accountReference}`,limit:1}))?.[0];if(!contract||contract.mode!=='debicheck')return res.status(200).json({ok:true,processed:false});const credentials=await loadNetcashCredentials();if(!credentials?.debitOrderServiceKey)throw new HttpError(503,'Netcash Debit Order credentials are unavailable.','configuration_error');const verified=await debiCheckCurrentStatus(credentials.debitOrderServiceKey,contractReference),status=String(verified.status||'').toLowerCase(),accepted=status==='accepted',rejected=['rejected','cancelled','failed'].includes(status);await dbUpdate('netcash_contracts',{id:`eq.${contract.id}`},{provider_contract_reference:contractReference,mandate_status:accepted?'accepted':rejected?'rejected':'awaiting_authorisation',provider_status:accepted?'active':rejected?'failed':'pending',authenticated_at:accepted?(contract.authenticated_at||new Date().toISOString()):contract.authenticated_at,activated_at:accepted?(contract.activated_at||new Date().toISOString()):contract.activated_at,last_error:rejected?(verified.cancellationReason||`DebiCheck ${verified.status}`):null,provider_metadata:{...(contract.provider_metadata||{}),debicheck_status:verified.status,debicheck_update_date:verified.updateDate,postback_process:payload.Process||null,registered_mandate_provider_rms:payload.RMS??null},updated_at:new Date().toISOString()});return res.status(200).json({ok:true,processed:true,status:verified.status,registeredMandate:payload.RMS??null});}

async function applyVerifiedEMandateStatus(contract,verified,reported={}){
  const now=new Date().toISOString();
  const accepted=verified.ready&&verified.found&&verified.statusCode==='6';
  const rejected=verified.ready&&verified.found&&['3','4','5'].includes(String(verified.statusCode||''));
  const nextStatus=accepted?'accepted':rejected?'rejected':'awaiting_authorisation';
  const providerStatus=accepted?'active':rejected?'failed':'pending';
  const mismatch=Boolean((reported.successful&&!accepted&&verified.ready)||(reported.declined&&accepted));
  const metadata={
    ...(contract.provider_metadata||{}),
    emandate_postback:{
      reported_status:reported.status||null,
      reported_successful:Boolean(reported.successful),
      reported_declined:Boolean(reported.declined),
      reported_valid:reported.isValid||null,
      reported_signed_by:reported.signedBy||null,
      reported_reason:reported.reason||null,
      reported_pdf_present:Boolean(reported.pdfPresent),
      received_at:reported.receivedAt||now,
      trusted_for_status:false
    },
    emandate_verification:{
      source:'netcash_request_mandate_data',
      ready:Boolean(verified.ready),
      found:Boolean(verified.found),
      status_code:verified.statusCode||null,
      status:verified.status||'pending',
      file_token:verified.fileToken||null,
      checked_at:verified.checkedAt||now,
      postback_mismatch:mismatch
    }
  };
  await dbUpdate('netcash_contracts',{id:`eq.${contract.id}`},{
    mandate_status:nextStatus,
    provider_status:providerStatus,
    authenticated_at:accepted?(contract.authenticated_at||now):contract.authenticated_at,
    activated_at:accepted?(contract.activated_at||now):contract.activated_at,
    last_error:rejected?`Netcash eMandate ${verified.status||'failed'}.`:null,
    provider_metadata:metadata,
    updated_at:now
  });
  return{accepted,rejected,status:verified.status||'pending',statusCode:verified.statusCode||null,verified:Boolean(verified.ready&&verified.found),mismatch};
}

async function emandatePostback(req,res){
  const raw=await readRawBody(req,128*1024),form=new URLSearchParams(raw.toString('utf8')),accountRef=String(form.get('AccountRef')||'').trim();
  if(!accountRef)return res.status(200).json({ok:true,processed:false});
  if(!EMANDATE_REFERENCE.test(accountRef))throw new HttpError(400,'The Netcash mandate reference is invalid.','invalid_emandate_reference');
  await enforceRateLimit(req,{scope:'netcash-emandate-postback',identity:accountRef,limit:12,windowSeconds:60});
  const contract=(await dbSelect('netcash_contracts',{select:'*',account_reference:`eq.${accountRef}`,limit:1}))?.[0];
  if(!contract||contract.mode==='debicheck'||contract.provider_metadata?.synchronous_emandate!==true)return res.status(200).json({ok:true,processed:false});
  const reported={
    successful:truthy(form.get('MandateSuccessful')),
    declined:truthy(form.get('IsDeclined')),
    status:safeReportedText(form.get('MandateStatus'),40),
    isValid:safeReportedText(form.get('IsValid'),20),
    signedBy:safeReportedText([form.get('SignBy_FirstName'),form.get('SignBy_LastName')].filter(Boolean).join(' '),120),
    reason:safeReportedText(form.get('ReasonForDecline'),180),
    pdfPresent:Boolean(String(form.get('MandatePDFLink')||'').trim()),
    receivedAt:new Date().toISOString()
  };
  const verified=await verifyNetcashEMandate(accountRef);
  const result=await applyVerifiedEMandateStatus(contract,verified,reported);
  return res.status(200).json({ok:true,processed:result.verified,verified:result.verified,accepted:result.accepted,status:result.status});
}

async function publicCardTokenReturn(req,res){const raw=await readRawBody(req,64*1024),form=Object.fromEntries(new URLSearchParams(raw.toString('utf8'))),card=await saveCardTokenReturn({userId:req.query?.user,state:String(req.query?.state||''),form});res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><meta charset="utf-8"><title>Card saved</title><body style="font-family:system-ui;padding:30px"><h2>Card saved securely</h2><p>${String(card.masked_number||'Tokenised card')}</p><script>if(window.opener){window.opener.postMessage({type:'kredrun-netcash-card-tokenized'},location.origin)}setTimeout(()=>window.close(),1200)</script></body>`);}
async function bulkStatementIngress(req,res){const configured=String(process.env.NETCASH_BULK_STATEMENT_INGEST_SECRET||''),supplied=String(req.headers['x-netcash-ingest-secret']||'');if(!configured||supplied!==configured)throw new HttpError(401,'Bulk Statement ingress authentication failed.','bulk_statement_auth_failed');const raw=await readRawBody(req,5*1024*1024);return res.status(200).json({ok:true,result:await ingestNetcashBulkStatement(raw.toString('utf8'))});}

async function suiteAction(req,res,action){const user=await staffAction(req,['owner','manager','collections','underwriter']),body=requestBody(req);switch(action){
  case'payout':return res.status(201).json({ok:true,...await disburseNetcashLoan({loanId:requireUuid(body.loanId,'Loan'),stream:body.stream||null,createdBy:user.id})});
  case'payout_controls':return res.status(200).json({ok:true,controls:await getNetcashAccountControls()});
  case'payout_pop':return res.status(200).json({ok:true,...await retrieveNetcashProofOfPayment(requireUuid(body.payoutId,'Payout'))});
  case'participating_banks':return res.status(200).json({ok:true,banks:await syncDebiCheckParticipatingBanks()});
  case'debicheck_amend':return res.status(200).json({ok:true,result:await amendNetcashDebiCheck({loanId:requireUuid(body.loanId,'Loan'),collectionAmount:body.collectionAmount,maximumCollectionAmount:body.maximumCollectionAmount})});
  case'registered_mandate':return res.status(201).json({ok:true,...await requestRegisteredMandateFallback({loanId:requireUuid(body.loanId,'Loan'),createdBy:user.id})});
  case'emandate_sync':return res.status(201).json({ok:true,...await createSynchronousEMandate({loanId:requireUuid(body.loanId,'Loan'),includeDebiCheck:Boolean(body.includeDebiCheck)})});
  case'emandate_status':{const loanId=requireUuid(body.loanId,'Loan'),contract=(await dbSelect('netcash_contracts',{select:'*',loan_id:`eq.${loanId}`,limit:1}))?.[0];if(!contract?.account_reference)throw new HttpError(409,'No Netcash eMandate exists for this loan.','emandate_missing');const verified=await verifyNetcashEMandate(contract.account_reference),result=await applyVerifiedEMandateStatus(contract,verified);return res.status(200).json({ok:true,...result});}
  case'emandate_pdf':return res.status(200).json({ok:true,...await requestEMandatePdf(requireUuid(body.loanId,'Loan'))});
  case'emandate_masterfile':return res.status(200).json({ok:true,...await updateEMandateMasterfile(requireUuid(body.loanId,'Loan'))});
  case'ecommerce':return res.status(201).json({ok:true,...await createPayNowEcommerce({loanId:requireUuid(body.loanId,'Loan'),scheduleId:body.scheduleId?requireUuid(body.scheduleId,'Instalment'):null,amount:body.amount,subscription:body.subscription||null,createdBy:user.id})});
  case'qr':return res.status(201).json({ok:true,...await createPayNowQr({loanId:requireUuid(body.loanId,'Loan'),scheduleId:body.scheduleId?requireUuid(body.scheduleId,'Instalment'):null,amount:body.amount,createdBy:user.id})});
  case'subscription_update':return res.status(200).json({ok:true,...await updateNetcashSubscription({...body,createdBy:user.id})});
  case'subscription_delete':return res.status(200).json({ok:true,...await deleteNetcashSubscription({reference:body.reference,createdBy:user.id})});
  case'refund':return res.status(201).json({ok:true,...await requestNetcashRefund({transactionId:body.transactionId,amount:body.amount,loanId:body.loanId||null,createdBy:user.id})});
  case'id_validate':return res.status(200).json({ok:true,...await validateSouthAfricanId({idNumber:body.idNumber,userId:body.userId||null,loanId:body.loanId||null,createdBy:user.id})});
  case'id_verify':return res.status(201).json({ok:true,...await submitIdVerification({userId:requireUuid(body.userId,'Client'),loanId:body.loanId||null,reasonCode:Number(body.reasonCode||32),createdBy:user.id})});
  case'bulk_avs':return res.status(201).json({ok:true,...await submitBulkAvs({userIds:body.userIds,createdBy:user.id})});
  case'card_token_session':return res.status(200).json({ok:true,...await createCardTokenizationSession({userId:requireUuid(body.userId,'Client'),origin:origin(req)})});
  case'card_debit':return res.status(201).json({ok:true,cardDebit:await submitCreditCardDebitOrder({loanId:requireUuid(body.loanId,'Loan'),scheduleId:requireUuid(body.scheduleId,'Instalment'),cardTokenId:requireUuid(body.cardTokenId,'Card token'),actionDate:body.actionDate||null,instruction:body.instruction||'same_day',createdBy:user.id})});
  case'blocked_accounts':return res.status(200).json({ok:true,accounts:await syncBlockedAccounts({startDate:body.startDate||new Date(Date.now()-7*86400000).toISOString().slice(0,10),endDate:body.endDate||new Date().toISOString().slice(0,10)})});
  default:throw new HttpError(400,'Unknown Netcash lender-suite action.','invalid_netcash_action');}}

export default async function handler(req,res){if(!allowMethod(req,res,['POST']))return;const action=String(req.query?.action||'').trim();try{if(action==='card_token_return')return await publicCardTokenReturn(req,res);if(action==='bulk_statement_ingest')return await bulkStatementIngress(req,res);if(action==='emandate_postback')return await emandatePostback(req,res);if(action==='notify')return await payNowNotify(req,res);if(action==='debicheck_postback')return await debicheckPostback(req,res);if(action==='request')return await clientRequest(req,res);if(action==='admin_request')return await adminRequest(req,res);if(action==='loan_setup')return await loanSetup(req,res);if(action==='maintenance')return await maintenance(req,res);return await suiteAction(req,res,action);}catch(error){return sendError(res,error,`Netcash ${action||'request'} failed`);}}
