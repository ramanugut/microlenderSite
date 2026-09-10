import crypto from 'node:crypto';
import { allowMethod, HttpError, readRawBody, sendError } from '../server/http.js';
import { customProviderSettings } from '../server/custom-payment-provider.js';
import { dbRpc, dbSelect, dbUpdate } from '../server/supabase-rest.js';
import { enforceRateLimit, logSystemError } from '../server/security.js';

export const config={api:{bodyParser:false}};
function safeEqual(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&aa.length>0&&crypto.timingSafeEqual(aa,bb);}

export default async function handler(req,res){
  if(!allowMethod(req,res,['POST']))return;
  try{
    await enforceRateLimit(req,{scope:'custom-provider-webhook',limit:180,windowSeconds:60});
    const{config:provider,credentials}=await customProviderSettings();
    if(!provider?.enabled||provider.validation_status!=='validated'||!credentials?.webhookSecret)throw new HttpError(503,'Custom provider webhook is not configured.','custom_provider_webhook_not_ready');
    const raw=await readRawBody(req,256*1024);
    const header=String(req.headers[String(provider.signature_header_name||'X-KredRun-Signature').toLowerCase()]||'').replace(/^sha256=/i,'').trim();
    const expected=crypto.createHmac('sha256',String(credentials.webhookSecret)).update(raw).digest('hex');
    if(!safeEqual(header,expected))throw new HttpError(401,'Invalid custom-provider webhook signature.','invalid_webhook_signature');
    let body;try{body=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Webhook body is not valid JSON.','invalid_json');}
    const externalReference=String(body.externalReference||'').trim();if(!externalReference)throw new HttpError(400,'Webhook externalReference is required.','invalid_reference');
    const rows=await dbSelect('provider_payment_requests',{select:'*',provider:'eq.custom_http',local_reference:`eq.${externalReference}`,limit:1});const request=rows?.[0];
    if(!request)throw new HttpError(404,'Payment request not found.','payment_request_not_found');
    const status=String(body.status||'').toLowerCase();
    if(status==='paid'){
      const amount=Number(body.amount);if(!Number.isFinite(amount))throw new HttpError(400,'Webhook amount is invalid.','invalid_amount');
      const result=await dbRpc('process_provider_payment',{p_request_id:request.id,p_provider:'custom_http',p_provider_reference:String(body.reference||body.providerReference||request.provider_reference||'').trim(),p_paid_amount:amount,p_paid_at:body.paidAt||new Date().toISOString(),p_channel:body.channel||'webhook'});
      return res.status(200).json({ok:true,status:result?.status||'succeeded'});
    }
    if(['failed','cancelled'].includes(status))await dbUpdate('provider_payment_requests',{id:`eq.${request.id}`},{status:'failed',failure_message:String(body.message||`Provider reported ${status}`).slice(0,500),updated_at:new Date().toISOString()});
    return res.status(200).json({ok:true,status:status||'pending'});
  }catch(error){
    if(error?.status>=500||!(error instanceof HttpError))await logSystemError(req,error,'Custom provider webhook failed',{source:'webhook'});
    return sendError(res,error,'Custom provider webhook failed');
  }
}
