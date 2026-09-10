import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { NETCASH_DEFAULT_SVK } from './netcash.js';

const PARTNER_URL = 'https://ws.netcash.co.za/NIWS/NIWS_Partner.svc';

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[char]);
}
function unxml(value) {
  return String(value ?? '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function tag(source,name) {
  const match=String(source||'').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'));
  return match?unxml(match[1].trim()):null;
}
function blocks(source,name) {
  return [...String(source||'').matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'gi'))].map(match=>match[1]);
}

async function partnerValidate({accountNumber,softwareVendorKey,services}) {
  const action='http://tempuri.org/NIWS_Partner/ValidateServiceKey';
  const serviceXml=services.map(service=>`<d:ServiceInfo><d:ServiceId>${xml(service.id)}</d:ServiceId><d:ServiceKey>${xml(service.key)}</d:ServiceInfo>`).join('');
  const envelope=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">${action}</a:Action><a:MessageID>urn:uuid:${crypto.randomUUID()}</a:MessageID><a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="1">${PARTNER_URL}</a:To></s:Header><s:Body><ValidateServiceKey xmlns="http://tempuri.org/"><request xmlns:d="http://schemas.datacontract.org/2004/07/NIWS_Partner" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><d:SoftwareVendorKey>${xml(softwareVendorKey)}</d:SoftwareVendorKey><d:MerchantAccount>${xml(accountNumber)}</d:MerchantAccount><d:ServiceInfoList>${serviceXml}</d:ServiceInfoList></request></ValidateServiceKey></s:Body></s:Envelope>`;
  const response=await fetch(PARTNER_URL,{method:'POST',headers:{'Content-Type':`application/soap+xml; charset=utf-8; action="${action}"`},body:envelope,signal:AbortSignal.timeout(25000)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text)){
    throw new HttpError(response.status>=500?502:400,tag(text,'faultstring')||tag(text,'Text')||`Netcash returned HTTP ${response.status}.`,'netcash_partner_validation_failed');
  }
  const statusRows=blocks(text,'ServiceInfoResponse').map(block=>({id:tag(block,'ServiceId'),status:tag(block,'ServiceStatus')}));
  return { accountStatus:tag(text,'AccountStatus'), serviceStatuses:statusRows };
}

export async function validateNetcashProductionReadiness(credentials, config) {
  if (!config?.account_number) throw new HttpError(400,'Enter the lender Netcash account number first.','netcash_account_required');
  const services=[];
  if(credentials?.debitOrderServiceKey)services.push({id:'1',key:credentials.debitOrderServiceKey,name:'Debit orders'});
  if(credentials?.creditorServiceKey)services.push({id:'2',key:credentials.creditorServiceKey,name:'Creditor payments'});
  if(credentials?.riskServiceKey||credentials?.riskReportsServiceKey)services.push({id:'3',key:credentials.riskServiceKey||credentials.riskReportsServiceKey,name:'Risk reports'});
  if(credentials?.accountServiceKey)services.push({id:'5',key:credentials.accountServiceKey,name:'Account service'});
  if(credentials?.payNowServiceKey)services.push({id:'14',key:credentials.payNowServiceKey,name:'Pay Now'});
  if(!services.length)throw new HttpError(400,'No Netcash service keys are configured.','netcash_service_key_required');

  const result=await partnerValidate({accountNumber:config.account_number,softwareVendorKey:config.software_vendor_key||NETCASH_DEFAULT_SVK,services});
  const byId=new Map(result.serviceStatuses.map(item=>[String(item.id),item.status]));
  const checked=services.map(item=>({id:item.id,name:item.name,status:byId.get(item.id)||null,valid:byId.get(item.id)==='001'}));
  const required=[];
  if(config.standard_debit_orders_enabled||config.emandate_enabled||config.debicheck_enabled||config.registered_mandate_enabled)required.push('1');
  if(config.creditor_payments_enabled)required.push('2');
  if(config.avs_enabled||config.id_verification_enabled||config.bulk_avs_enabled)required.push('3');
  if(config.standard_debit_orders_enabled||config.emandate_enabled||config.debicheck_enabled||config.creditor_payments_enabled||config.bulk_statement_enabled)required.push('5');
  if(config.payment_requests_enabled||config.paynow_ecommerce_enabled||config.paynow_qr_enabled||config.paynow_subscriptions_enabled||config.paynow_refunds_enabled)required.push('14');

  const missingRequired=required.filter(id=>!services.some(service=>service.id===id));
  const invalidRequired=checked.filter(service=>required.includes(service.id)&&!service.valid).map(service=>service.id);
  const accountValid=result.accountStatus==='001';
  const valid=accountValid&&missingRequired.length===0&&invalidRequired.length===0;
  return {
    valid,
    accountValid,
    accountStatus:result.accountStatus,
    services:checked,
    requiredServiceIds:[...new Set(required)],
    missingRequiredServiceIds:missingRequired,
    invalidRequiredServiceIds:invalidRequired,
    checkedAt:new Date().toISOString()
  };
}
