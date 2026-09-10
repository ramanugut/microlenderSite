import crypto from 'node:crypto';
import { HttpError, bearerToken, UUID_PATTERN } from './http.js';

function settings() {
  const url=String(process.env.SUPABASE_URL||'').trim().replace(/\/$/,'');
  const serviceKey=String(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
  if(!url||!serviceKey)throw new HttpError(503,'The secure payment service is not configured.','configuration_error');
  return{url,serviceKey};
}

async function parseResponse(response){const text=await response.text();let payload=null;if(text){try{payload=JSON.parse(text);}catch{payload=text;}}if(!response.ok){const pass=response.status===401||response.status===403;const error=new HttpError(pass?response.status:502,'The secure payment database request failed.',payload?.code||'database_error');error.databaseCode=payload?.code;error.upstreamMessage=typeof payload==='object'?payload?.message:undefined;throw error;}return payload;}

export async function supabaseRequest(path,{method='GET',body,token,prefer}={}){const{url,serviceKey}=settings();const response=await fetch(`${url}${path}`,{method,headers:{apikey:serviceKey,Authorization:`Bearer ${token||serviceKey}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...(prefer?{Prefer:prefer}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});return parseResponse(response);}

function jwtPayload(token){try{const segment=String(token||'').split('.')[1];if(!segment)return null;const normalized=segment.replace(/-/g,'+').replace(/_/g,'/');const padding=normalized.length%4?'='.repeat(4-(normalized.length%4)):'';return JSON.parse(Buffer.from(normalized+padding,'base64').toString('utf8'));}catch{return null;}}
function jwtSessionId(token){const payload=jwtPayload(token);const sessionId=String(payload?.session_id||'');return UUID_PATTERN.test(sessionId)?sessionId:null;}
function firstIp(req){return String(req?.headers?.['x-vercel-forwarded-for']||req?.headers?.['x-forwarded-for']||req?.socket?.remoteAddress||'unknown').split(',')[0].trim();}
async function enforceAuthenticatedRateLimit(req,userId){const{serviceKey}=settings();const secret=String(process.env.SECURITY_RATE_LIMIT_SECRET||serviceKey);const hash=crypto.createHmac('sha256',secret).update(`authenticated-api|${userId}|${firstIp(req)}`).digest('hex');const allowed=await dbRpc('service_consume_api_rate_limit',{p_key_hash:hash,p_scope:'authenticated-api',p_limit:240,p_window_seconds:60});if(allowed!==true)throw new HttpError(429,'Too many requests. Please try again shortly.','rate_limit_exceeded');}

export async function requireUser(req){const token=bearerToken(req);let user;try{user=await supabaseRequest('/auth/v1/user',{token});}catch(error){if(error.status===401||error.status===403)throw new HttpError(401,'Please sign in again.','authentication_required');throw error;}if(!user?.id)throw new HttpError(401,'Please sign in again.','authentication_required');const sessionId=jwtSessionId(token);if(!sessionId)throw new HttpError(401,'Please sign in again.','active_session_required');const active=await dbRpc('service_auth_session_active',{p_user_id:user.id,p_session_id:sessionId});if(active!==true)throw new HttpError(401,'This session is no longer active. Please sign in again.','session_revoked');await enforceAuthenticatedRateLimit(req,user.id);return{user,token,sessionId};}

export function requireMfaToken(token){const payload=jwtPayload(token);if(payload?.aal!=='aal2')throw new HttpError(403,'Two-factor authentication is required for lender administration.','mfa_required');return payload;}

function queryString(params={}){const query=new URLSearchParams();Object.entries(params).forEach(([key,value])=>{if(value!==undefined&&value!==null)query.set(key,String(value));});return query.toString();}
export function dbSelect(table,params={}){const qs=queryString(params);return supabaseRequest(`/rest/v1/${table}${qs?`?${qs}`:''}`);}
export function dbInsert(table,body){return supabaseRequest(`/rest/v1/${table}`,{method:'POST',body,prefer:'return=representation'});}
export function dbUpdate(table,filters,body){const qs=queryString(filters);return supabaseRequest(`/rest/v1/${table}?${qs}`,{method:'PATCH',body,prefer:'return=representation'});}
export function dbRpc(name,body){return supabaseRequest(`/rest/v1/rpc/${name}`,{method:'POST',body});}

export const STAFF_ROLES=Object.freeze(['owner','administrator','branch_manager','loan_officer','collections_agent','finance','auditor']);
const PERMISSIONS=Object.freeze({owner:new Set(['*']),administrator:new Set(['view_operations','manage_staff','manage_settings','manage_integrations','manage_product','manage_clients','review_applications','create_loans','verify_documents','manage_loans','manage_collections','record_payments','manage_payouts','manage_financial_adjustments','manage_tasks','communicate','support_view','run_risk_checks','view_reports','view_audit']),branch_manager:new Set(['view_operations','manage_clients','review_applications','create_loans','verify_documents','manage_loans','manage_collections','record_payments','manage_tasks','communicate','support_view','run_risk_checks','view_reports']),loan_officer:new Set(['view_operations','manage_clients','review_applications','create_loans','verify_documents','manage_tasks','communicate','run_risk_checks','view_reports']),collections_agent:new Set(['view_operations','manage_collections','manage_tasks','communicate','view_reports']),finance:new Set(['view_operations','record_payments','manage_payouts','manage_financial_adjustments','communicate','view_reports']),auditor:new Set(['view_operations','view_reports','view_audit'])});
const LEGACY_ROLE_MATCH=Object.freeze({owner:new Set(['owner']),manager:new Set(['administrator']),underwriter:new Set(['branch_manager','loan_officer']),collections:new Set(['branch_manager','collections_agent']),support:new Set(['branch_manager','loan_officer']),viewer:new Set(['auditor'])});
export function staffCan(staffOrRole,permission){const role=typeof staffOrRole==='string'?staffOrRole:staffOrRole?.role;const allowed=PERMISSIONS[role];return Boolean(allowed&&(allowed.has('*')||allowed.has(permission)));}
function matchesRequestedRole(actualRole,requestedRole){if(actualRole===requestedRole)return true;return LEGACY_ROLE_MATCH[requestedRole]?.has(actualRole)||false;}
async function activeStaff(userId){const rows=await dbSelect('staff_members',{select:'user_id,display_name,role,status,lender_branch_id',user_id:`eq.${userId}`,status:'eq.active',limit:1});return rows?.[0]||null;}
export async function requireStaff(userId,roles=['owner','administrator','branch_manager','collections_agent']){const staff=await activeStaff(userId),requested=Array.isArray(roles)?roles:[roles];if(!staff||!requested.some(role=>matchesRequestedRole(staff.role,role)))throw new HttpError(403,'You do not have permission to perform this staff action.','staff_permission_required');return staff;}
export async function requireStaffPermission(userId,permission){const staff=await activeStaff(userId);if(!staff||!staffCan(staff,permission))throw new HttpError(403,'You do not have permission to perform this staff action.','staff_permission_required');return staff;}
export async function requireStaffSession(req,roles=['owner','administrator','branch_manager','collections_agent']){const session=await requireUser(req);requireMfaToken(session.token);const staff=await requireStaff(session.user.id,roles);return{...session,staff};}
export async function requireStaffPermissionSession(req,permission){const session=await requireUser(req);requireMfaToken(session.token);const staff=await requireStaffPermission(session.user.id,permission);return{...session,staff};}
export async function logCommunication({userId,loanId,subject,message,createdBy=null,status='sent'}){await dbInsert('communication_log',{user_id:userId,loan_id:loanId,channel:'email',direction:'outbound',subject,message,status,created_by:createdBy});}
