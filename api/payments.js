import { allowMethod, HttpError, requestBody, requireUuid, sendError } from '../server/http.js';
import { loadPaymentQuote } from '../server/loan-payments.js';
import { getActivePaymentRequestProvider, getProvider } from '../server/payment-provider-registry.js';
import { PROVIDER_CAPABILITIES } from '../server/provider-contract.js';
import { requireUser } from '../server/supabase-rest.js';

async function quote(req,res){
  if(!allowMethod(req,res,['GET']))return;
  const {user}=await requireUser(req);
  const loanId=requireUuid(req.query?.loanId,'Loan');
  const paymentType=String(req.query?.paymentType||'');
  if(!['instalment','settlement'].includes(paymentType))throw new HttpError(400,'Choose instalment or settlement.','invalid_payment_type');
  const scheduleId=req.query?.scheduleId?requireUuid(req.query.scheduleId,'Instalment'):null;
  const {provider}=await getActivePaymentRequestProvider({paymentType,source:'client',capability:PROVIDER_CAPABILITIES.CLIENT_CHECKOUT});
  const paymentQuote=await loadPaymentQuote({loanId,userId:user.id,scheduleId,paymentType});
  return res.status(200).json({ok:true,provider:provider.id,providerName:provider.name,loanId,scheduleId:paymentQuote.schedule?.id||null,paymentType,amount:paymentQuote.amount,dueDate:paymentQuote.dueDate,breakdown:paymentQuote.components});
}

async function start(req,res){
  if(!allowMethod(req,res,['POST']))return;
  const {user}=await requireUser(req);
  const body=requestBody(req);
  const loanId=requireUuid(body.loanId,'Loan');
  const paymentType=String(body.paymentType||'');
  if(!['instalment','settlement'].includes(paymentType))throw new HttpError(400,'Choose instalment or settlement.','invalid_payment_type');
  const scheduleId=body.scheduleId?requireUuid(body.scheduleId,'Instalment'):null;
  const {provider}=await getActivePaymentRequestProvider({paymentType,source:'client',capability:PROVIDER_CAPABILITIES.CLIENT_CHECKOUT});
  const result=await provider.startClientPayment({loanId,scheduleId,paymentType,user,req});
  return res.status(200).json({ok:true,provider:provider.id,providerName:provider.name,...result});
}

async function verify(req,res){
  if(!allowMethod(req,res,['GET']))return;
  const {user}=await requireUser(req);
  const provider=getProvider(req.query?.provider||'');
  if(typeof provider.verifyClientReturn!=='function')throw new HttpError(409,`${provider.name} does not use browser-return verification.`,'provider_return_verification_not_supported');
  const reference=String(req.query?.reference||'').trim();
  if(!reference||reference.length>120)throw new HttpError(400,'The payment reference is invalid.','invalid_reference');
  const result=await provider.verifyClientReturn({reference,user,req});
  return res.status(200).json({ok:true,provider:provider.id,...result});
}

export default async function handler(req,res){
  const action=String(req.query?.action||'').trim();
  try{
    if(action==='quote')return await quote(req,res);
    if(action==='start')return await start(req,res);
    if(action==='verify')return await verify(req,res);
    throw new HttpError(400,'Unknown payment action.','invalid_payment_action');
  }catch(error){return sendError(res,error,`Payment ${action||'request'} failed`);}
}
