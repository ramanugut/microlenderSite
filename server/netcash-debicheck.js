import { HttpError } from './http.js';

const NIF_URL = 'https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';
function xml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function unxml(value){return String(value??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');}
function tag(source,name){const m=String(source||'').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'));return m?unxml(m[1].trim()):null;}

export async function debiCheckCurrentStatus(serviceKey, contractReference){
  const method='DebiCheckAuthenticationCurrentStatus';
  const action=`http://tempuri.org/NIWS_NIF/${method}`;
  const envelope=`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/"><ServiceKey>${xml(serviceKey)}</ServiceKey><ContractReference>${xml(contractReference)}</ContractReference></${method}></soap:Body></soap:Envelope>`;
  const response=await fetch(NIF_URL,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${action}"`},body:envelope,signal:AbortSignal.timeout(20000)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text)) throw new HttpError(response.status>=500?502:400,tag(text,'faultstring')||'Netcash DebiCheck status lookup failed.','netcash_error');
  const errorCode=tag(text,'ErrorCode');
  const returnedReference=tag(text,'ContractReference');
  const status=tag(text,'Status');
  if(errorCode==='100') throw new HttpError(401,'Netcash rejected the Debit Order service key.','netcash_auth_failed');
  if(errorCode==='202') throw new HttpError(404,'Netcash could not find that DebiCheck contract.','netcash_contract_not_found');
  if(errorCode && errorCode!=='000') throw new HttpError(409,`Netcash DebiCheck returned ${errorCode}.`,'netcash_debicheck_error');
  if(returnedReference!==String(contractReference)) throw new HttpError(502,'Netcash returned a different DebiCheck contract reference.','netcash_verification_failed');
  return {contractReference:returnedReference,status,cancellationReason:tag(text,'CancellationReason'),dateCancelled:tag(text,'DateCancelled'),updateDate:tag(text,'UpdateDate'),errorCode};
}
