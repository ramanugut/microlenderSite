import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { dbRpc } from './supabase-rest.js';

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

export function requestId(req) {
  const candidate = firstHeader(req?.headers?.['x-request-id'] || req?.headers?.['x-vercel-id']);
  return /^[A-Za-z0-9._:/-]{3,160}$/.test(candidate) ? candidate : crypto.randomUUID();
}

export function requestIp(req) {
  const raw = firstHeader(req?.headers?.['x-vercel-forwarded-for'] || req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress);
  return raw || 'unknown';
}

function rateSecret() {
  return String(process.env.SECURITY_RATE_LIMIT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function keyHash(value) {
  const secret = rateSecret();
  if (!secret) throw new HttpError(503, 'Security rate limiting is not configured.', 'security_configuration_error');
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

export async function enforceRateLimit(req, { scope, identity = '', limit = 120, windowSeconds = 60 } = {}) {
  const cleanScope = String(scope || 'api').slice(0, 120);
  const rawKey = `${cleanScope}|${identity}|${requestIp(req)}`;
  const allowed = await dbRpc('service_consume_api_rate_limit', {
    p_key_hash: keyHash(rawKey),p_scope:cleanScope,p_limit:Math.max(1,Math.floor(Number(limit)||1)),p_window_seconds:Math.max(1,Math.floor(Number(windowSeconds)||1))
  });
  if (allowed !== true) throw new HttpError(429, 'Too many requests. Please try again shortly.', 'rate_limit_exceeded');
  return true;
}

export async function logSystemError(req, error, context = 'API request', extra = {}) {
  if (error?.__kredrunLogged) return;
  try {
    const id=requestId(req),status=Number(error?.status||500),safeCode=String(error?.code||'server_error').slice(0,120);
    const route=String(req?.url||extra.route||'').split('?')[0].slice(0,240);
    await dbRpc('service_log_system_error', {
      p_request_id:id,p_severity:status>=500?'error':'warning',p_source:String(extra.source||'api').slice(0,80),p_route:route||null,
      p_method:String(req?.method||extra.method||'').slice(0,16)||null,p_user_id:extra.userId||null,p_staff_role:extra.staffRole||null,
      p_error_code:safeCode,p_safe_message:String(context||'API request failed').slice(0,1000),
      p_metadata:{status,errorName:String(error?.name||'Error').slice(0,100),databaseCode:error?.databaseCode||null,...extra.metadata}
    });
    if (error && typeof error==='object') error.__kredrunLogged=true;
  } catch (loggingError) {
    console.error('System error logging failed', { name: loggingError?.name, code: loggingError?.code });
  }
}

export async function recordJobRun({ jobName, runKey, status, startedAt, finishedAt = null, message = null, metadata = {} }) {
  return dbRpc('service_record_job_run', {
    p_job_name:jobName,p_run_key:runKey,p_status:status,p_started_at:startedAt||new Date().toISOString(),p_finished_at:finishedAt,p_message:message,p_metadata:metadata
  });
}
