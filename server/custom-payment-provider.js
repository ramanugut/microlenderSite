import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError, siteUrl } from './http.js';
import { loadPaymentQuote, validCustomerEmail } from './loan-payments.js';
import { loadCustomPaymentProviderCredentials } from './provider-secrets.js';
import { dbInsert, dbRpc, dbSelect, dbUpdate } from './supabase-rest.js';

function privateIpv4(address) {
  const parts=String(address).split('.').map(Number);
  if(parts.length!==4||parts.some(n=>!Number.isInteger(n)||n<0||n>255))return true;
  const[a,b]=parts;
  return a===0||a===10||a===127||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===198&&(b===18||b===19))||a>=224;
}
function privateIp(address){
  if(net.isIP(address)===4)return privateIpv4(address);
  if(net.isIP(address)===6){const a=String(address).toLowerCase();return a==='::1'||a==='::'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe8')||a.startsWith('fe9')||a.startsWith('fea')||a.startsWith('feb')||a.startsWith('::ffff:127.')||a.startsWith('::ffff:10.')||a.startsWith('::ffff:192.168.');}
  return true;
}
export async function assertSafeProviderBaseUrl(value){
  let url;
  try{url=new URL(String(value||'').trim());}catch{throw new HttpError(400,'Enter a valid custom-provider URL.','invalid_provider_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new HttpError(400,'Custom providers must use public HTTPS on the standard secure port.','unsafe_provider_url');
  const host=url.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))throw new HttpError(400,'Local or private provider hosts are not allowed.','unsafe_provider_url');
  const allowed=String(process.env.CUSTOM_PROVIDER_ALLOWED_HOSTS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(allowed.length&&!allowed.includes(host))throw new HttpError(403,'This custom-provider host is not on the deployment allowlist.','provider_host_not_allowed');
  const addresses=net.isIP(host)?[{address:host}]:await dns.lookup(host,{all:true,verbatim:true}).catch(()=>[]);
  if(!addresses.length||addresses.some(item=>privateIp(item.address)))throw new HttpError(400,'Custom provider must resolve only to public internet addresses.','unsafe_provider_url');
  return url.origin;
}
function safePath(value,label){const path=String(value||'').trim();if(!path.startsWith('/')||path.startsWith('//')||path.includes('..'))throw new HttpError(400,`${label} must be a relative API path beginning with /.`,'invalid_provider_path');return path;}

export async function customProviderSettings(){
  const [rows,credentials]=await Promise.all([dbSelect('custom_payment_provider_config',{select:'*',id:'eq.true',limit:1}),loadCustomPaymentProviderCredentials()]);
  return{config:rows?.[0]||null,credentials};
}

async function requestProvider(config,credentials,path,{method='POST',body}={}){
  const origin=await assertSafeProviderBaseUrl(config.base_url);
  const target=new URL(safePath(path,'Provider endpoint'),`${origin}/`);
  const headers={'Accept':'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(credentials?.authValue)headers[String(config.auth_header_name||'Authorization')]=String(credentials.authValue);
  const response=await fetch(target,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
  const text=await response.text();
  let payload={};try{payload=text?JSON.parse(text):{};}catch{throw new HttpError(502,'Custom provider returned a non-JSON response.','custom_provider_invalid_response');}
  if(!response.ok)throw new HttpError(response.status>=500?502:400,payload?.message||`Custom provider returned HTTP ${response.status}.`,'custom_provider_error');
  return payload;
}

export async function validateCustomProviderConnection(){
  const{config,credentials}=await customProviderSettings();
  if(!config?.base_url)throw new HttpError(409,'Configure the custom provider URL first.','custom_provider_not_configured');
  await assertSafeProviderBaseUrl(config.base_url);
  if(config.health_path){const payload=await requestProvider(config,credentials,config.health_path,{method:'GET'});if(payload?.ok===false)throw new HttpError(409,payload.message||'Custom provider health check failed.','custom_provider_health_failed');}
  return{valid:true,credentialsConfigured:Boolean(credentials),displayName:config.display_name||'Custom payment provider'};
}

function localReference(){return`KRC${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`.slice(0,32);}
function endOfDay(asOf){return`${String(asOf).slice(0,10)}T23:59:59+02:00`;}

async function assertReady(paymentType){
  const{config,credentials}=await customProviderSettings();
  if(!config?.enabled||config.validation_status!=='validated'||!config.base_url)throw new HttpError(409,'The custom payment provider is not connected and enabled.','custom_provider_not_ready');
  if(paymentType==='settlement'){
    const rows=await dbSelect('lender_settings',{select:'settlement_payments_enabled',id:'eq.true',limit:1});
    if(!rows?.[0]?.settlement_payments_enabled)throw new HttpError(409,'Early settlement payments are disabled.','settlements_disabled');
  }
  return{config,credentials};
}

async function assertNoDuplicate(quote,paymentType){
  const filters={select:'id',loan_id:`eq.${quote.loan.id}`,status:'in.(initializing,pending)',limit:1};
  if(paymentType==='instalment'&&quote.schedule?.id)filters.schedule_id=`eq.${quote.schedule.id}`;else filters.payment_type='eq.settlement';
  const rows=await dbSelect('provider_payment_requests',filters);
  if(rows?.length)throw new HttpError(409,paymentType==='settlement'?'A settlement payment is already active for this loan.':'A payment request is already active for this instalment.','payment_request_exists');
}

export async function startCustomProviderPayment({loanId,scheduleId=null,paymentType='instalment',source='client',initiatedBy=null,userId=null,req}){
  const{config,credentials}=await assertReady(paymentType);
  const quote=await loadPaymentQuote({loanId,scheduleId,paymentType,userId});
  await assertNoDuplicate(quote,paymentType);
  const reference=localReference();
  const expiresAt=paymentType==='settlement'?endOfDay(quote.asOf):null;
  const created=await dbInsert('provider_payment_requests',{
    provider:'custom_http',loan_id:quote.loan.id,schedule_id:quote.schedule?.id||null,user_id:quote.loan.user_id,payment_type:paymentType,source,trigger_kind:source,
    amount:quote.amount,due_date:quote.dueDate,local_reference:reference,status:'initializing',expires_at:expiresAt,created_by:initiatedBy,
    provider_metadata:{quote_as_of:quote.asOf,quote_components:quote.components}
  });
  const request=created?.[0];if(!request)throw new HttpError(502,'The custom-provider request could not be saved.','database_error');
  const returnUrl=`${siteUrl(req)}/account.html?payment=verify&provider=custom_http&reference=${encodeURIComponent(reference)}`;
  const payload={externalReference:reference,loanId:quote.loan.id,scheduleId:quote.schedule?.id||null,paymentType,amount:quote.amount,currency:'ZAR',customer:{name:[quote.profile?.first_name,quote.profile?.last_name].filter(Boolean).join(' '),email:validCustomerEmail(quote.profile?.email),mobile:String(quote.profile?.mobile||'')},returnUrl,metadata:{accountNumber:quote.loan.account_number||null}};
  try{
    const result=await requestProvider(config,credentials,config.create_payment_path,{body:payload});
    const providerReference=String(result.reference||result.providerReference||reference).trim();
    const authorizationUrl=result.paymentUrl||result.authorizationUrl||null;
    if(authorizationUrl){const url=new URL(authorizationUrl);if(url.protocol!=='https:')throw new HttpError(502,'Custom provider returned an unsafe payment URL.','custom_provider_invalid_payment_url');}
    const status=String(result.status||'pending').toLowerCase();
    const normalized=status==='paid'?'pending':status==='failed'?'failed':'pending';
    const updated=await dbUpdate('provider_payment_requests',{id:`eq.${request.id}`},{provider_reference:providerReference,status:normalized,authorization_url:authorizationUrl,failure_message:normalized==='failed'?String(result.message||'Provider rejected the payment request').slice(0,500):null,provider_metadata:{...request.provider_metadata,provider_response_status:status},updated_at:new Date().toISOString()});
    if(status==='paid')await dbRpc('process_provider_payment',{p_request_id:request.id,p_provider:'custom_http',p_provider_reference:providerReference,p_paid_amount:quote.amount,p_paid_at:new Date().toISOString(),p_channel:'create_response'});
    return{request:updated?.[0]||request,quote,interaction:authorizationUrl?'redirect':'request',authorizationUrl,message:result.message||'Payment request created.'};
  }catch(error){await dbUpdate('provider_payment_requests',{id:`eq.${request.id}`},{status:'failed',failure_message:String(error.message||error).slice(0,500),updated_at:new Date().toISOString()}).catch(()=>{});throw error;}
}

export async function verifyCustomProviderPayment({reference,user}){
  const{config,credentials}=await assertReady('instalment');
  const rows=await dbSelect('provider_payment_requests',{select:'*',provider:'eq.custom_http',local_reference:`eq.${reference}`,limit:1});
  const request=rows?.[0];if(!request)throw new HttpError(404,'Payment request not found.','payment_request_not_found');
  if(user?.id&&request.user_id!==user.id)throw new HttpError(403,'This payment does not belong to your account.','payment_access_denied');
  if(request.status==='succeeded')return{status:'succeeded',outstandingBalance:null};
  const payload=await requestProvider(config,credentials,config.verify_payment_path,{body:{externalReference:request.local_reference,reference:request.provider_reference}});
  const status=String(payload.status||'').toLowerCase();
  if(status!=='paid'){
    if(['failed','cancelled'].includes(status))await dbUpdate('provider_payment_requests',{id:`eq.${request.id}`},{status:'failed',failure_message:String(payload.message||'Provider reports payment failed').slice(0,500),updated_at:new Date().toISOString()});
    return{status:status||'pending'};
  }
  const amount=Number(payload.amount);if(!Number.isFinite(amount))throw new HttpError(502,'Custom provider did not return a valid paid amount.','custom_provider_invalid_amount');
  const providerReference=String(payload.reference||payload.providerReference||request.provider_reference||'').trim();
  const result=await dbRpc('process_provider_payment',{p_request_id:request.id,p_provider:'custom_http',p_provider_reference:providerReference,p_paid_amount:amount,p_paid_at:payload.paidAt||new Date().toISOString(),p_channel:payload.channel||'custom'});
  return result;
}
