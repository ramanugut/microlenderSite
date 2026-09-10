import crypto from 'node:crypto';
import { HttpError } from './http.js';

export const NETCASH_DEFAULT_SVK = '24ade73c-98cf-47b3-99be-cc7b867b3080';
const NIF_URL = 'https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';
const PARTNER_URL = 'https://ws.netcash.co.za/NIWS/NIWS_Partner.svc';

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
  })[char]);
}
function unxml(value) {
  return String(value ?? '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function tag(source,name) {
  const match=String(source||'').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'));
  return match?unxml(match[1].trim()):null;
}
function allBlocks(source,name) {
  return [...String(source||'').matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'gi'))].map(match=>match[1]);
}
function soapFault(text,status) {
  const reason=tag(text,'faultstring')||tag(text,'Text')||tag(text,'Reason')||`Netcash web service returned HTTP ${status}.`;
  return new HttpError(status>=500?502:400,reason,'netcash_error');
}
async function postNif(method,methodBody,timeout=30000) {
  const action=`http://tempuri.org/NIWS_NIF/${method}`;
  const envelope=`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/">${methodBody}</${method}></soap:Body></soap:Envelope>`;
  const response=await fetch(NIF_URL,{method:'POST',headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${action}"`},body:envelope,signal:AbortSignal.timeout(timeout)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text))throw soapFault(text,response.status);
  return{text,result:tag(text,`${method}Result`)};
}
async function nifCall(method,params,timeout=30000) {
  const body=Object.entries(params).map(([key,value])=>`<${key}>${xml(value)}</${key}>`).join('');
  return postNif(method,body,timeout);
}
async function nifMethodParametersCall(method,params,timeout=30000) {
  const fields=Object.entries(params).map(([key,value])=>`<${key}>${xml(value)}</${key}>`).join('');
  return postNif(method,`<MethodParameters>${fields}</MethodParameters>`,timeout);
}

async function partnerValidate({accountNumber,softwareVendorKey,services}) {
  const action='http://tempuri.org/NIWS_Partner/ValidateServiceKey';
  const serviceXml=services.map(service=>`<d:ServiceInfo><d:ServiceId>${xml(service.id)}</d:ServiceId><d:ServiceKey>${xml(service.key)}</d:ServiceInfo>`).join('');
  const messageId=`urn:uuid:${crypto.randomUUID()}`;
  const envelope=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">${action}</a:Action><a:MessageID>${messageId}</a:MessageID><a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="1">${PARTNER_URL}</a:To></s:Header><s:Body><ValidateServiceKey xmlns="http://tempuri.org/"><request xmlns:d="http://schemas.datacontract.org/2004/07/NIWS_Partner" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><d:SoftwareVendorKey>${xml(softwareVendorKey)}</d:SoftwareVendorKey><d:MerchantAccount>${xml(accountNumber)}</d:MerchantAccount><d:ServiceInfoList>${serviceXml}</d:ServiceInfoList></request></ValidateServiceKey></s:Body></s:Envelope>`;
  const response=await fetch(PARTNER_URL,{method:'POST',headers:{'Content-Type':`application/soap+xml; charset=utf-8; action="${action}"`},body:envelope,signal:AbortSignal.timeout(20000)});
  const text=await response.text();
  if(!response.ok||/<(?:\w+:)?Fault[\s>]/i.test(text))throw soapFault(text,response.status);
  const accountStatus=tag(text,'AccountStatus');
  const blocks=allBlocks(text,'ServiceInfoResponse');
  const serviceStatuses=blocks.map(block=>({id:tag(block,'ServiceId'),status:tag(block,'ServiceStatus')}));
  if(!serviceStatuses.length){
    const ids=[...text.matchAll(/<(?:\w+:)?ServiceId>(.*?)<\/(?:\w+:)?ServiceId>/gi)].map(match=>unxml(match[1]));
    const statuses=[...text.matchAll(/<(?:\w+:)?ServiceStatus>(.*?)<\/(?:\w+:)?ServiceStatus>/gi)].map(match=>unxml(match[1]));
    ids.forEach((id,index)=>serviceStatuses.push({id,status:statuses[index]||null}));
  }
  return{accountStatus,serviceStatuses,raw:text};
}

export async function validateNetcashCredentials(credentials,config) {
  const services=[];
  if(credentials.debitOrderServiceKey)services.push({id:'1',key:credentials.debitOrderServiceKey,name:'Debit orders'});
  if(credentials.riskReportsServiceKey)services.push({id:'3',key:credentials.riskReportsServiceKey,name:'Risk reports'});
  if(credentials.accountServiceKey)services.push({id:'5',key:credentials.accountServiceKey,name:'Account service'});
  if(credentials.payNowServiceKey)services.push({id:'14',key:credentials.payNowServiceKey,name:'Pay Now'});
  if(!services.length)throw new HttpError(400,'Enter at least one Netcash service key.','netcash_service_key_required');
  const result=await partnerValidate({accountNumber:config.account_number,softwareVendorKey:config.software_vendor_key||NETCASH_DEFAULT_SVK,services});
  const statusById=new Map(result.serviceStatuses.map(item=>[String(item.id),item.status]));
  const checked=services.map(item=>({...item,status:statusById.get(item.id)||null,valid:statusById.get(item.id)==='001'}));
  return{accountStatus:result.accountStatus,accountValid:result.accountStatus==='001',services:checked,valid:result.accountStatus==='001'&&checked.every(item=>item.valid)};
}

export async function batchFileUpload(serviceKey,file) {
  const{result}=await nifCall('BatchFileUpload',{ServiceKey:serviceKey,File:file},30000);
  const clean=String(result||'').trim();
  if(!clean)throw new HttpError(502,'Netcash did not return a file token.','netcash_empty_response');
  const errors={'100':'Netcash rejected the service key.','101':'Netcash rejected a date in the batch.','102':'Netcash rejected one or more batch parameters.','200':'Netcash returned a processing error.'};
  if(errors[clean])throw new HttpError(400,errors[clean],`netcash_${clean}`);
  return clean;
}
export async function requestFileUploadReport(serviceKey,fileToken){const{result}=await nifCall('RequestFileUploadReport',{ServiceKey:serviceKey,FileToken:fileToken});return String(result||'');}
export async function requestPayNowInvoice(serviceKey,fileToken){const{result}=await nifCall('RequestPayNowInvoice',{ServiceKey:serviceKey,FileToken:fileToken});return String(result||'');}

export async function debiCheckAuthenticate({serviceKey,accountReference,templateId,profile,amount,firstCollectionAmount,firstCollectionDate}) {
  const{text}=await nifCall('DebiCheckAuthenticate',{
    ServiceKey:serviceKey,AccountReference:accountReference,DebiCheckMandateTemplateId:templateId,IsIdNumber:'1',DebtorIdentification:profile.id_number,
    AccountName:`${profile.first_name||''} ${profile.last_name||''}`.trim(),BankAccountName:profile.bank_account_holder,
    BranchCode:String(profile.branch_code||'').padStart(6,'0'),BankAccountNumber:profile.bank_account_number,BankAccountType:bankAccountTypeName(profile.bank_account_type),
    MobileNumber:saMobileInternational(profile.mobile),EmailAddress:profile.email||'',CollectionAmount:Number(amount).toFixed(2),
    FirstCollectionDiffers:Math.abs(Number(firstCollectionAmount)-Number(amount))>0.005?'1':'0',FirstCollectionAmount:Number(firstCollectionAmount).toFixed(2),FirstCollectionDate:yyyymmdd(firstCollectionDate)
  },190000);
  return{errorCode:tag(text,'ErrorCode'),bankResponseCode:tag(text,'BankResponseCode'),bankservResponseCode:tag(text,'BankservResponseCode'),clientResponseCode:tag(text,'ClientResponseCode'),contractReference:tag(text,'ContractReference'),status:tag(text,'Status'),raw:text};
}

export async function debiCheckRetrieveMandateTemplateDetail(serviceKey,templateId) {
  // Netcash documents this specific operation with a MethodParameters request wrapper.
  const{text}=await nifMethodParametersCall('DebiCheckRetrieveMandateTemplateDetail',{ServiceKey:serviceKey,DebiCheckMandateTemplateId:templateId});
  return{
    errorCode:tag(text,'ErrorCode'),authenticationType:tag(text,'AuthenticationType'),debtorAuthCode:tag(text,'DebtorAuthCode'),collectionFrequency:tag(text,'CollectionFrequency'),
    collectionFrequencyDayCode:tag(text,'CollectionFrequencyDayCode'),debitValueType:tag(text,'DebitValueType'),installmentOccurrence:tag(text,'InstallmentOccurrence'),trackingIndicator:tag(text,'TrackingIndicator'),trackingDayCode:tag(text,'TrackingDayCode'),templateId:tag(text,'TemplateId')||templateId,raw:text
  };
}
export async function debiCheckCancelAuthentication(serviceKey,contractReference,reasonCode='CUST') {
  const{text}=await nifCall('DebiCheckCancelAuthentication',{ServiceKey:serviceKey,ContractReference:contractReference,ReasonCode:reasonCode});
  return{errorCode:tag(text,'ErrorCode'),contractReference:tag(text,'ContractReference')||contractReference,raw:text};
}
export async function debiCheckAmendAuthentication(serviceKey,contractReference,collectionAmountCents,maximumCollectionAmountCents) {
  const{text}=await nifCall('DebiCheckAmendAuthentication',{ServiceKey:serviceKey,ContractReference:contractReference,CollectionAmountInCents:Math.round(Number(collectionAmountCents)),MaximumCollectionAmountInCents:Math.round(Number(maximumCollectionAmountCents))});
  return{errorCode:tag(text,'ErrorCode'),contractReference:tag(text,'ContractReference')||contractReference,raw:text};
}

export async function avsRealtimeQuery({serviceKey,accountReference,profile}) {
  const{text}=await nifCall('AVSRealtimeQuery',{
    ServiceKey:serviceKey,
    AccountReference:accountReference,
    BankAccountNumber:String(profile.bank_account_number||'').replace(/\s/g,''),
    BranchCode:String(profile.branch_code||'').padStart(6,'0'),
    BankAccountType:bankAccountTypeName(profile.bank_account_type),
    EnquiryName:String(profile.bank_account_holder||`${profile.first_name||''} ${profile.last_name||''}`).trim(),
    IDNumber:String(profile.id_number||'').trim(),
    IsIdNumber:'True',
    Extra1:'KredRun',
    Extra2:'',
    Extra3:'',
    Initials:'',
    PhoneNumber:saMobileInternational(profile.mobile),
    Email:profile.email||''
  },60000);
  const messages=allBlocks(text,'StringArray').map(value=>String(value).trim()).filter(Boolean);
  return{
    errorCode:tag(text,'ErrorCode'),bankAccountNumberValid:tag(text,'BankAccountNumberValid'),idNumberMatch:tag(text,'IdNumberMatch'),lastNameMatch:tag(text,'LastNameMatch'),
    accountActive:tag(text,'AccountActive'),acceptsDebits:tag(text,'AcceptsDebits'),acceptsCredits:tag(text,'AcceptsCredits'),periodActive:tag(text,'PeriodActive'),offlineRequest:tag(text,'OfflineRequest'),fileToken:tag(text,'FileToken'),messages,raw:text
  };
}

export function yyyymmdd(value=new Date()) {
  const date=value instanceof Date?value:new Date(`${String(value).slice(0,10)}T00:00:00Z`);
  if(Number.isNaN(date.getTime()))throw new HttpError(400,'A Netcash date is invalid.','invalid_date');
  return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`;
}
export function cents(amount){const value=Math.round(Number(amount)*100);if(!Number.isSafeInteger(value)||value<0)throw new HttpError(400,'A Netcash amount is invalid.','invalid_amount');return value;}
export function saMobileLocal(value){let digits=String(value||'').replace(/\D/g,'');if(digits.startsWith('27')&&digits.length===11)digits=`0${digits.slice(2)}`;return digits.slice(0,10);}
export function saMobileInternational(value){let digits=String(value||'').replace(/\D/g,'');if(digits.startsWith('0')&&digits.length===10)digits=`27${digits.slice(1)}`;return digits;}
export const saMobile=saMobileInternational;
export function bankAccountTypeCode(value){const clean=String(value||'').toLowerCase();if(clean.includes('saving'))return'2';if(clean.includes('transmission'))return'3';return'1';}
export function bankAccountTypeName(value){const code=bankAccountTypeCode(value);return code==='2'?'Savings':code==='3'?'Transmission':'Current';}

function batchHeader(serviceKey,instruction,batchName,actionDate,softwareVendorKey){return['H',serviceKey,'1',instruction,batchName,yyyymmdd(actionDate),softwareVendorKey||NETCASH_DEFAULT_SVK].join('\t');}
function lastDayCode(dateValue){const date=new Date(`${String(dateValue).slice(0,10)}T00:00:00Z`);const monthEnd=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0));return date.getUTCDate()===monthEnd.getUTCDate()?'LDOM':String(date.getUTCDate()).padStart(2,'0');}
function debitFrequency(value){const clean=String(value||'monthly').toLowerCase();if(clean==='weekly')return'6';if(clean==='fortnightly'||clean==='biweekly'||clean==='bi-weekly')return'7';if(clean==='quarterly')return'3';if(clean==='semiannual'||clean==='six_monthly')return'4';if(clean==='annual'||clean==='annually')return'5';return'1';}
function debiCheckFrequencyDayCode(frequency,dateValue){const date=new Date(`${String(dateValue).slice(0,10)}T00:00:00Z`);const clean=String(frequency||'monthly').toLowerCase();const weekday=date.getUTCDay()===0?7:date.getUTCDay();if(clean==='weekly')return`WEEK_${String(weekday).padStart(2,'0')}`;if(clean==='fortnightly'||clean==='biweekly'||clean==='bi-weekly')return`FRTN_${String(weekday).padStart(2,'0')}`;return`MNTH_${String(date.getUTCDate()).padStart(2,'0')}`;}

export function buildEMandateFile({serviceKey,softwareVendorKey,batchName,contract,loan,profile,firstSchedule,includeDebiCheck=false,templateId=null}) {
  const regularAmount=cents(loan.instalment_amount||firstSchedule.amount_due);
  const firstOutstanding=Math.max(0,Number(firstSchedule.amount_due)-Number(firstSchedule.amount_paid||0));
  const firstAmount=cents(firstOutstanding||firstSchedule.amount_due);
  const frequency=debitFrequency(loan.repayment_frequency);
  const commencementMonth=String(firstSchedule.due_date).slice(5,7).padStart(2,'0');
  const debitDay=lastDayCode(firstSchedule.due_date);
  const keys=[101,102,110,113,114,121,122,123,126,127,131,132,133,134,135,136,161,201,202,530,531,532,533,534,535,537,540,541,542];
  const values=[
    contract.account_reference,`${profile.first_name||''} ${profile.last_name||''}`.trim().slice(0,50),'1',profile.last_name||'',profile.first_name||'','','','',profile.id_number||'','1',
    '1',profile.bank_account_holder||'',bankAccountTypeCode(profile.bank_account_type),String(profile.branch_code||'').padStart(6,'0'),'0',profile.bank_account_number||'',
    String(regularAmount),profile.email||'',saMobileLocal(profile.mobile),frequency,commencementMonth,debitDay,debitDay,yyyymmdd(loan.start_date||new Date()),loan.account_number||contract.account_reference,loan.allow_variable_debit?'1':'0','1','1','1'
  ];
  if(includeDebiCheck){keys.push(241,242,243,246,247,248,250);values.push('1',templateId||'',String(regularAmount),regularAmount===firstAmount?'0':'1',String(firstAmount),yyyymmdd(firstSchedule.due_date),debiCheckFrequencyDayCode(loan.repayment_frequency,firstSchedule.due_date));}
  return[batchHeader(serviceKey,'Mandates',batchName,new Date(),softwareVendorKey),['K',...keys].join('\t'),['T',...values].join('\t'),['F','1',String(regularAmount),'9999'].join('\t')].join('\n');
}

export function buildStandardDebitBatch({serviceKey,softwareVendorKey,batchName,actionDate,rows,stream='eft_2day'}) {
  const total=rows.reduce((sum,row)=>sum+cents(row.amount),0);const instruction=stream==='efts'?'CompactSameDay':'CompactTwoDay';
  return[batchHeader(serviceKey,instruction,batchName,actionDate,softwareVendorKey),['K','101','162','301','302','303'].join('\t'),...rows.map(row=>['T',row.accountReference,String(cents(row.amount)),row.instructionId||'',row.loanId||'',row.scheduleId||''].join('\t')),['F',String(rows.length),String(total),'9999'].join('\t')].join('\n');
}
export function buildDebiCheckBatch({serviceKey,softwareVendorKey,batchName,actionDate,rows,trackingDays=1}) {
  const total=rows.reduce((sum,row)=>sum+cents(row.amount),0);const safeTracking=Math.min(10,Math.max(1,Number(trackingDays||1)));
  return[batchHeader(serviceKey,'DebiCheck',batchName,actionDate,softwareVendorKey),['K','101','162','232','249','301','302','303'].join('\t'),...rows.map(row=>['T',row.accountReference,String(cents(row.amount)),String(row.trackingDays||safeTracking),row.contractReference,row.instructionId||'',row.loanId||'',row.scheduleId||''].join('\t')),['F',String(rows.length),String(total),'9999'].join('\t')].join('\n');
}
export function buildPayNowInvoiceFile({serviceKey,softwareVendorKey,batchName,reference,amount,description,email,mobile,sendSms,sendEmail,extra1='',extra2='',extra3=''}) {
  const amountCents=cents(amount);const keys=['253','254','162','138','201','202','255','256','301','302','303'];const values=[reference,String(description||'').slice(0,50),String(amountCents),'N',email||'',saMobileInternational(mobile),sendSms&&mobile?'Y':'N',sendEmail&&email?'Y':'N',extra1,extra2,extra3];
  return[batchHeader(serviceKey,'Invoice',batchName,new Date(),softwareVendorKey),['K',...keys].join('\t'),['T',...values].join('\t'),['F','1',String(amountCents),'9999'].join('\t')].join('\n');
}
