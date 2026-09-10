import { HttpError } from './http.js';
import { PROVIDER_CAPABILITIES, providerSupports, requireProviderCapability } from './provider-contract.js';
import { dbSelect } from './supabase-rest.js';
import { netcashProvider } from './providers/netcash-provider.js';
import { customHttpProvider } from './providers/custom-http-provider.js';

// Provider-specific API details stay inside adapters. Loan balances, settlement,
// arrears and payment allocation remain provider-neutral.
const providers=Object.freeze([netcashProvider,customHttpProvider]);
const byId=new Map(providers.map(provider=>[provider.id,provider]));

export function listRegisteredProviders(){return [...providers];}
export function getProvider(providerId){
  const id=String(providerId||'').trim().toLowerCase();
  const provider=byId.get(id);
  if(!provider) throw new HttpError(409,`Payment provider '${id||'unknown'}' is not installed in this KredRun build.`,'provider_not_registered');
  return provider;
}
export async function getPaymentProviderSettings(){
  const rows=await dbSelect('lender_settings',{select:'payment_request_provider,settlement_payments_enabled,automatic_payment_requests,day_before_reminders_enabled,due_date_reminders_enabled,reminder_days_before,missed_payment_reminders_enabled,arrears_daily_reminders_enabled,arrears_reminder_limit,collections_retry_limit',id:'eq.true',limit:1});
  return rows?.[0]||{};
}
export async function getActivePaymentRequestProvider({paymentType='instalment',source='client',capability=PROVIDER_CAPABILITIES.PAYMENT_REQUEST}={}){
  const settings=await getPaymentProviderSettings();
  const provider=getProvider(settings.payment_request_provider||'netcash');
  requireProviderCapability(provider,capability);
  if(paymentType==='settlement') requireProviderCapability(provider,PROVIDER_CAPABILITIES.EARLY_SETTLEMENT);
  if(source==='automatic') requireProviderCapability(provider,PROVIDER_CAPABILITIES.AUTOMATIC_REMINDERS);
  if(typeof provider.assertReady==='function') await provider.assertReady({paymentType,source,settings});
  return{provider,settings};
}
export async function findFallbackPaymentRequestProvider(excludeId){
  const candidates=providers.filter(provider=>provider.id!==excludeId&&providerSupports(provider,PROVIDER_CAPABILITIES.PAYMENT_REQUEST));
  for(const provider of candidates){if(typeof provider.assertReady!=='function')return provider;try{await provider.assertReady({paymentType:'instalment',source:'admin'});return provider;}catch{}}
  return candidates[0]||null;
}
export async function activeScheduledCollectionIds(scheduleIds){
  if(!scheduleIds?.length)return new Set();
  const sets=await Promise.all(providers.filter(provider=>providerSupports(provider,PROVIDER_CAPABILITIES.AUTOMATIC_COLLECTION)&&typeof provider.activeCollectionScheduleIds==='function').map(provider=>provider.activeCollectionScheduleIds(scheduleIds).catch(()=>new Set())));
  const result=new Set();for(const set of sets)for(const id of set||[])result.add(id);return result;
}
export async function runAllProviderMaintenance(){
  const entries=await Promise.all(providers.map(async provider=>{if(typeof provider.runMaintenance!=='function')return[provider.id,{skipped:true,reason:'maintenance_not_supported'}];try{return[provider.id,await provider.runMaintenance()];}catch(error){return[provider.id,{error:error.message||`${provider.name} maintenance failed`}];}}));
  return Object.fromEntries(entries);
}
export async function providerCatalog({checkReadiness=false}={}){
  const active=(await getPaymentProviderSettings()).payment_request_provider||'netcash';const rows=[];
  for(const provider of providers){
    let ready=null,reason=null,name=provider.name;
    if(typeof provider.getDisplayName==='function'){try{name=await provider.getDisplayName();}catch{}}
    if(checkReadiness&&providerSupports(provider,PROVIDER_CAPABILITIES.PAYMENT_REQUEST)&&typeof provider.assertReady==='function'){try{await provider.assertReady({paymentType:'instalment',source:'client'});ready=true;}catch(error){ready=false;reason=error.message||'Not ready';}}
    rows.push({id:provider.id,name,activeForPaymentRequests:provider.id===active,capabilities:[...provider.capabilities],ready,reason});
  }
  return rows;
}
