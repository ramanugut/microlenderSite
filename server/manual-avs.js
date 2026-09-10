import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { avsRealtimeQuery, evaluateAvsPolicies, validateRiskServiceKey } from './netcash-avs.js';
import { loadNetcashCredentials } from './provider-secrets.js';
import { dbSelect, supabaseRequest } from './supabase-rest.js';

function norm(value){return String(value||'').replace(/\s/g,'').toLowerCase();}
function hash(value){return crypto.createHash('sha256').update(norm(value)).digest('hex');}
function valid(value){return ['valid','yes','y','true','active','1'].includes(norm(value));}

export async function manualAvsReadiness(){
  const[rows,credentials]=await Promise.all([dbSelect('netcash_config',{select:'*',id:'eq.true',limit:1}),loadNetcashCredentials()]);
  const config=rows?.[0]||{};
  return{ready:Boolean(config.account_number&&credentials?.riskServiceKey),automaticAvsEnabled:Boolean(config.avs_enabled),riskKeyConfigured:Boolean(credentials?.riskServiceKey),netcashConfigured:Boolean(config.account_number),validationStatus:config.validation_status||'not_configured'};
}

export async function runManualAvs(loanId){
  const[rows,credentials,loans]=await Promise.all([
    dbSelect('netcash_config',{select:'*',id:'eq.true',limit:1}),loadNetcashCredentials(),dbSelect('loans',{select:'*',id:`eq.${loanId}`,limit:1})
  ]);
  const config=rows?.[0]||{},loan=loans?.[0];
  if(!loan)throw new HttpError(404,'Loan not found.','loan_not_found');
  if(!config.account_number)throw new HttpError(409,'Enter the lender Netcash account number before running manual AVS.','netcash_account_required');
  if(!credentials?.riskServiceKey)throw new HttpError(409,'Manual AVS needs a Netcash Risk Reports Service Key. Automatic AVS may stay disabled.','netcash_avs_key_required');
  const keyCheck=await validateRiskServiceKey({accountNumber:config.account_number,softwareVendorKey:config.software_vendor_key,riskServiceKey:credentials.riskServiceKey});
  if(!keyCheck.valid)throw new HttpError(409,'The saved Netcash Risk Reports Service Key is not valid for this account.','netcash_avs_key_invalid');
  const profiles=await dbSelect('customer_profiles',{select:'*',id:`eq.${loan.user_id}`,limit:1});
  const profile=profiles?.[0];if(!profile)throw new HttpError(409,'Client profile is missing.','client_profile_required');
  const required=['id_number','bank_account_holder','bank_account_number','branch_code','bank_account_type'];
  const missing=required.filter(k=>!String(profile[k]||'').trim());if(missing.length)throw new HttpError(409,`Manual AVS needs the client ${missing.join(', ')}.`,'netcash_avs_data_incomplete');
  const ref=`KRMAVS${String(loan.id).replace(/-/g,'').slice(0,14).toUpperCase()}${Date.now().toString(36).slice(-3).toUpperCase()}`.slice(0,22);
  const result=await avsRealtimeQuery({serviceKey:credentials.riskServiceKey,accountReference:ref,profile,loanId:loan.id});
  const technicalValid=result.errorCode==='000'&&valid(result.bankAccountNumberValid)&&valid(result.idNumberMatch);
  const status=result.errorCode==='000'?(technicalValid?'valid':'invalid'):(result.errorCode==='203'?'invalid':'error');
  const policies=evaluateAvsPolicies(result,config);
  const fingerprint=`manual:${crypto.randomUUID()}`;
  const body={loan_id:loan.id,user_id:loan.user_id,request_fingerprint:fingerprint,identity_hash:hash(profile.id_number),account_hash:hash(profile.bank_account_number),account_last4:String(profile.bank_account_number).replace(/\D/g,'').slice(-4),branch_code:String(profile.branch_code).replace(/\D/g,'').padStart(6,'0'),status,error_code:result.errorCode||null,bank_account_number_valid:result.bankAccountNumberValid||null,id_number_match:result.idNumberMatch||null,last_name_match:result.lastNameMatch||null,initial_match:result.initialMatch||null,phone_number_match:result.phoneNumberMatch||null,email_match:result.emailMatch||null,account_active:result.accountActive||null,period_active:result.periodActive||null,accepts_debits:result.acceptsDebits||null,accepts_credits:result.acceptsCredits||null,account_dormant:result.accountDormant||null,tax_ref_match:result.taxRefMatch||null,file_token:result.fileToken||null,policy_result:policies,provider_result:{manual:true,account_reference:ref,messages:result.messages||[],offline_request:result.offlineRequest||null},verified_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  const saved=await supabaseRequest('/rest/v1/netcash_bank_verifications',{method:'POST',body,prefer:'return=representation'});
  return{verification:saved?.[0]||body,policies,automaticAvsEnabled:Boolean(config.avs_enabled)};
}
