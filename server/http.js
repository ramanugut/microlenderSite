export class HttpError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);this.name='HttpError';this.status=status;this.code=code;
  }
}

export const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PAYSTACK_REFERENCE_PATTERN=/^[A-Za-z0-9._=-]{3,120}$/;

export function allowMethod(req,res,methods) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(methods.includes(req.method))return true;
  res.setHeader('Allow',methods.join(', '));res.status(405).json({ok:false,message:'Method not allowed.'});return false;
}

export function bearerToken(req){const value=String(req.headers.authorization||'');const match=value.match(/^Bearer\s+(.+)$/i);if(!match?.[1])throw new HttpError(401,'Please sign in again.','authentication_required');return match[1].trim();}
export function requireUuid(value,label){const clean=String(value||'').trim();if(!UUID_PATTERN.test(clean))throw new HttpError(400,`${label} is invalid.`,'invalid_identifier');return clean;}
export function requestBody(req){if(!req.body)return{};if(typeof req.body==='object')return req.body;try{return JSON.parse(req.body);}catch{throw new HttpError(400,'The request body is invalid.','invalid_json');}}

export function siteUrl(req){
  const configured=String(process.env.APP_URL||'').trim().replace(/\/$/,'');
  if(configured){try{const url=new URL(configured);if(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='localhost'))return url.origin;}catch{}throw new HttpError(503,'The application URL is not configured correctly.','configuration_error');}
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
  if(!host||!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host))throw new HttpError(503,'The application URL is not configured.','configuration_error');
  return `${host.startsWith('localhost')?'http':'https'}://${host}`;
}

export function sendError(res,error,context){
  const status=error instanceof HttpError?error.status:500;
  const message=error instanceof HttpError?error.message:'Something went wrong. Please try again.';
  if(status>=500){
    console.error(context,{name:error?.name,code:error?.code,status:error?.status});
    if(!error?.__kredrunLogged){
      const req=res?.req;
      if(req)void import('./security.js').then(({logSystemError})=>logSystemError(req,error,context)).catch(()=>{});
    }
  }
  return res.status(status).json({ok:false,message,code:error instanceof HttpError?error.code:'server_error'});
}

export async function readRawBody(req,maxBytes=1024*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw new HttpError(413,'Request body is too large.','body_too_large');chunks.push(chunk);}return Buffer.concat(chunks);}
