import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbSelect, dbUpdate, supabaseRequest } from './supabase-rest.js';

const NIF_URL='https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';
const PARTNER_URL='https://ws.netcash.co.za/NIWS/NIWS_Partner.svc';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AVS_FIELD_KEYS=Object.freeze([
  'bank_account_number_valid','id_number_match','last_name_match','initial_match','phone_number_match','email_match',
  'account_active','period_active','accepts_debits','accepts_credits'
]);

const DEFAULT_MANDATE_RULES=Object.freeze({bank_account_number_valid:true,id_number_match:true,account_active:true,accepts_debits:true});
const DEFAULT_PAYOUT_RULES=Object.freeze({bank_account_number_valid:true,id_number_match:true,account_active:true,accepts_credits:true});

function xml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function unxml(value){return String(value??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
function tag(source,name){const m=String(source||'').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'));return m?unxml(m[1].trim()):null;}
function tags(source,prefix='StringArray'){return [...String(source||'').matchAll(new RegExp(`<(?:\\w+:)?${prefix}\\d+[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${prefix}\\d+>`,'gi'))].map(m=>unxml(m[1].trim())).filter(Boolean);}
function soapError(text,status,label='Netcash AVS'){return new HttpError(status>=500?502:400,tag(text,'faultstring')||tag(text,'Text')||`${label} returned HTTP ${status}.`,'netcash_error');}

export async function validateRiskServiceKey({accountNumber,softwareVendorKey,riskServiceKey}){
  if(!GUID.test(String(riskServiceKey||'')))return{valid:false,accountStatus:null,serviceStatus:null};
  const action='http://tempuri.org/NIWS_Partner/ValidateServiceKey';
  const messageId=`urn:uuid:${crypto.randomUUID()}`;
  const envelope=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">${action}</a:Action><a:MessageID>${messageId}</a:MessageID><a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="1">${PARTNER_URL}</a:To></s:Header><s:Body><ValidateServiceKey xmlns="http://tempuri.org/"><request xmlns:d="http://schemas.datacontract.org/2004/07/NIWS_Partner" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><d:SoftwareVendorKey>${xml(softwareVendorKey)}</d:SoftwareVendorKey><d:MerchantAccount>${xml(accountNumber)}</d:MerchantAccount><d:ServiceInfoList><d:ServiceInfo><d:ServiceId>3</d:ServiceId><d:ServiceKey>${xml(riskServiceKey)}</d:ServiceKey></d:ServiceInfo></d:ServiceInfoList></request></ValidateServiceKey></s:Body></s:Envelope>`;
  const response=await fetch(PARTNER_URL,{method:'POST',headers:{'Content-Type':`application/soap+xml; charset=utf-8; action="${action}"`},body:envelope,signal:AbortSignal.timeout(20000)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text))throw soapError(text,response.status,'Netcash Risk Service validation');
  const accountStatus=tag(text,'AccountStatus');
  const serviceStatus=tag(text,'ServiceStatus');
  return{valid:accountStatus==='001'&&serviceStatus==='001',accountStatus,serviceStatus};
}

function bankType(value){const clean=String(value||'').toLowerCase();if(clean.includes('saving'))return'Savings';if(clean.includes('transmission'))return'Transmission';return'Current';}
function phone27(value){let d=String(value||'').replace(/\D/g,'');if(d.startsWith('0')&&d.length===10)d=`27${d.slice(1)}`;return d;}

export async function avsRealtimeQuery({serviceKey,accountReference,profile,loanId}){
  const method='AVSRealtimeQuery';
  const action=`http://tempuri.org/NIWS_NIF/${method}`;
  const params={
    ServiceKey:serviceKey,
    AccountReference:accountReference,
    BankAccountNumber:String(profile.bank_account_number||'').replace(/\s/g,''),
    BranchCode:String(profile.branch_code||'').replace(/\D/g,'').padStart(6,'0'),
    BankAccountType:bankType(profile.bank_account_type),
    EnquiryName:String(profile.bank_account_holder||`${profile.first_name||''} ${profile.last_name||''}`).trim().slice(0,80),
    IDNumber:String(profile.id_number||'').trim(),
    IsIdNumber:/^\d{13}$/.test(String(profile.id_number||'').trim())?'True':'False',
    Extra1:String(loanId||''),
    Extra2:String(profile.id||''),
    Extra3:'KredRun',
    Initials:String(profile.first_name||'').trim().slice(0,1),
    PhoneNumber:phone27(profile.mobile),
    Email:String(profile.email||'').trim()
  };
  const inner=Object.entries(params).map(([k,v])=>`<${k}>${xml(v)}</${k}>`).join('');
  const envelope=`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/"><MethodParameters>${inner}</MethodParameters></${method}></soap:Body></soap:Envelope>`;
  const response=await fetch(NIF_URL,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${action}"`},body:envelope,signal:AbortSignal.timeout(60000)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text))throw soapError(text,response.status,'Netcash AVS');
  return{
    errorCode:tag(text,'ErrorCode'),fileToken:tag(text,'FileToken'),
    bankAccountNumberValid:tag(text,'BankAccountNumberValid'),idNumberMatch:tag(text,'IdNumberMatch'),lastNameMatch:tag(text,'LastNameMatch'),initialMatch:tag(text,'InitialMatch'),
    phoneNumberMatch:tag(text,'PhoneNumberMatch'),emailMatch:tag(text,'EmailMatch'),accountActive:tag(text,'AccountActive'),periodActive:tag(text,'PeriodActive'),
    acceptsDebits:tag(text,'AcceptsDebits'),acceptsCredits:tag(text,'AcceptsCredits'),accountDormant:tag(text,'AccountDormant'),taxRefMatch:tag(text,'TaxRefMatch'),
    offlineRequest:tag(text,'OfflineRequest'),messages:tags(text)
  };
}

function norm(value){return String(value||'').replace(/\s/g,'').toLowerCase();}
function hashValue(value){return crypto.createHash('sha256').update(norm(value)).digest('hex');}
function requestFingerprint(loan,profile){return crypto.createHash('sha256').update(JSON.stringify({loanId:loan.id,userId:loan.user_id,id:norm(profile.id_number),account:norm(profile.bank_account_number),branch:norm(profile.branch_code),type:norm(profile.bank_account_type),holder:norm(profile.bank_account_holder)})).digest('hex');}
function isValidValue(value){return ['valid','yes','y','true','active','1'].includes(norm(value));}
function isNotAvailable(value){return ['','notapplicable','n/a','n\\a','na','null'].includes(norm(value));}

function cleanRules(value,defaults){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return Object.fromEntries(AVS_FIELD_KEYS.map(key=>[key,source[key]===undefined?Boolean(defaults[key]):Boolean(source[key])]));
}

function verificationValues(source={}){
  return {
    bank_account_number_valid:source.bank_account_number_valid ?? source.bankAccountNumberValid ?? null,
    id_number_match:source.id_number_match ?? source.idNumberMatch ?? null,
    last_name_match:source.last_name_match ?? source.lastNameMatch ?? null,
    initial_match:source.initial_match ?? source.initialMatch ?? null,
    phone_number_match:source.phone_number_match ?? source.phoneNumberMatch ?? null,
    email_match:source.email_match ?? source.emailMatch ?? null,
    account_active:source.account_active ?? source.accountActive ?? null,
    period_active:source.period_active ?? source.periodActive ?? null,
    accepts_debits:source.accepts_debits ?? source.acceptsDebits ?? null,
    accepts_credits:source.accepts_credits ?? source.acceptsCredits ?? null
  };
}

function evaluateRuleSet(values,rules,failOnNA){
  const checks={};let passed=true;
  for(const key of AVS_FIELD_KEYS){
    if(!rules[key])continue;
    const value=values[key] ?? null;
    const unavailable=isNotAvailable(value);
    const ok=unavailable?!failOnNA:isValidValue(value);
    checks[key]={required:true,value,passed:ok,notApplicable:unavailable};
    if(!ok)passed=false;
  }
  return{passed,checks};
}

export function evaluateAvsPolicies(source,config={}){
  const values=verificationValues(source);
  const failOnNA=Boolean(config.avs_fail_on_not_applicable);
  return{
    failOnNotApplicable:failOnNA,
    mandate:evaluateRuleSet(values,cleanRules(config.avs_mandate_rules,DEFAULT_MANDATE_RULES),failOnNA),
    payout:evaluateRuleSet(values,cleanRules(config.avs_payout_rules,DEFAULT_PAYOUT_RULES),failOnNA)
  };
}

async function upsertVerification(body){const rows=await supabaseRequest('/rest/v1/netcash_bank_verifications?on_conflict=loan_id,request_fingerprint',{method:'POST',body,prefer:'resolution=merge-duplicates,return=representation'});return rows?.[0]||null;}

export async function ensureNetcashAvsForLoan(loanId,{force=false,context='mandate'}={}){
  const [configRows,credentials,loanRows]=await Promise.all([
    dbSelect('netcash_config',{select:'*',id:'eq.true',limit:1}),loadNetcashCredentials(),dbSelect('loans',{select:'*',id:`eq.${loanId}`,limit:1})
  ]);
  const config=configRows?.[0]||{};const loan=loanRows?.[0];
  if(!loan)throw new HttpError(404,'Loan not found.','loan_not_found');
  const requiredByContext=context==='payout'?Boolean(config.require_avs_before_payout):Boolean(config.require_avs_before_mandate);
  if(!config.avs_enabled){if(requiredByContext)throw new HttpError(409,'Netcash AVS is required by the lender policy but AVS is disabled.','netcash_avs_required');return{skipped:true,reason:'avs_disabled'};}
  if(!credentials?.riskServiceKey){if(requiredByContext)throw new HttpError(409,'Netcash AVS requires a Risk Reports Service Key.','netcash_avs_key_required');return{skipped:true,reason:'avs_key_missing'};}
  const profileRows=await dbSelect('customer_profiles',{select:'*',id:`eq.${loan.user_id}`,limit:1});const profile=profileRows?.[0];
  if(!profile)throw new HttpError(409,'Client profile is missing.','client_profile_required');
  const required=['id_number','bank_account_holder','bank_account_number','branch_code','bank_account_type'];const missing=required.filter(k=>!String(profile[k]||'').trim());
  if(missing.length)throw new HttpError(409,`AVS needs the client ${missing.join(', ')}.`,'netcash_avs_data_incomplete');
  const fp=requestFingerprint(loan,profile);
  const identityHash=hashValue(profile.id_number);const accountHash=hashValue(profile.bank_account_number);
  const existingRows=await dbSelect('netcash_bank_verifications',{select:'*',loan_id:`eq.${loan.id}`,request_fingerprint:`eq.${fp}`,limit:1});const existing=existingRows?.[0];
  if(existing&&!force&&['valid','invalid','not_supported'].includes(existing.status)){
    const policies=evaluateAvsPolicies(existing,config);
    const policy=context==='payout'?policies.payout:policies.mandate;
    await dbUpdate('netcash_bank_verifications',{id:`eq.${existing.id}`},{policy_result:policies,identity_hash:existing.identity_hash||identityHash,account_hash:existing.account_hash||accountHash,updated_at:new Date().toISOString()}).catch(()=>{});
    if(requiredByContext&&(existing.status!=='valid'||!policy.passed))throw new HttpError(409,`The client bank account did not pass the lender's Netcash AVS ${context} rules. Review the AVS result in Admin Settings.`,'netcash_avs_policy_failed');
    return{cached:true,verification:{...existing,policy_result:policies},policies};
  }
  const ref=`KRAVS${String(loan.id).replace(/-/g,'').slice(0,17).toUpperCase()}`.slice(0,22);
  await upsertVerification({loan_id:loan.id,user_id:loan.user_id,request_fingerprint:fp,identity_hash:identityHash,account_hash:accountHash,account_last4:String(profile.bank_account_number).replace(/\D/g,'').slice(-4),branch_code:String(profile.branch_code).replace(/\D/g,'').padStart(6,'0'),status:'pending',updated_at:new Date().toISOString()});
  let result;
  try{result=await avsRealtimeQuery({serviceKey:credentials.riskServiceKey,accountReference:ref,profile,loanId:loan.id});}
  catch(error){await dbUpdate('netcash_bank_verifications',{loan_id:`eq.${loan.id}`,request_fingerprint:`eq.${fp}`},{status:'error',provider_result:{message:String(error.message||error).slice(0,500)},updated_at:new Date().toISOString()}).catch(()=>{});throw error;}
  const technicalValid=result.errorCode==='000'&&isValidValue(result.bankAccountNumberValid)&&isValidValue(result.idNumberMatch);
  const status=result.errorCode==='000'?(technicalValid?'valid':'invalid'):(result.errorCode==='203'?'invalid':'error');
  const policies=evaluateAvsPolicies(result,config);
  const updated=await upsertVerification({
    loan_id:loan.id,user_id:loan.user_id,request_fingerprint:fp,identity_hash:identityHash,account_hash:accountHash,
    account_last4:String(profile.bank_account_number).replace(/\D/g,'').slice(-4),branch_code:String(profile.branch_code).replace(/\D/g,'').padStart(6,'0'),status,error_code:result.errorCode||null,
    bank_account_number_valid:result.bankAccountNumberValid||null,id_number_match:result.idNumberMatch||null,last_name_match:result.lastNameMatch||null,initial_match:result.initialMatch||null,
    phone_number_match:result.phoneNumberMatch||null,email_match:result.emailMatch||null,account_active:result.accountActive||null,period_active:result.periodActive||null,
    accepts_debits:result.acceptsDebits||null,accepts_credits:result.acceptsCredits||null,account_dormant:result.accountDormant||null,tax_ref_match:result.taxRefMatch||null,
    file_token:result.fileToken||null,policy_result:policies,
    provider_result:{messages:result.messages||[],offline_request:result.offlineRequest||null},verified_at:new Date().toISOString(),updated_at:new Date().toISOString()
  });
  const policy=context==='payout'?policies.payout:policies.mandate;
  if(requiredByContext&&(status!=='valid'||!policy.passed))throw new HttpError(409,`The client bank account did not pass the lender's Netcash AVS ${context} rules. Review the AVS result in Admin Settings.`,'netcash_avs_policy_failed');
  return{cached:false,verification:updated,result,policies};
}
