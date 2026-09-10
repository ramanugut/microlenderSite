import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { dbSelect, supabaseRequest } from './supabase-rest.js';

function encryptionKey() {
  const secret = String(process.env.PROVIDER_CREDENTIALS_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!secret) throw new HttpError(503, 'Provider credential encryption is not configured.', 'configuration_error');
  return crypto.createHash('sha256').update(`kredrun-provider-credentials-v1:${secret}`).digest();
}

function encrypt(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    encrypted_payload: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: cipher.getAuthTag().toString('base64'),
    key_version: 1,
    updated_at: new Date().toISOString()
  };
}

function decrypt(row) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_payload, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(clear);
  } catch {
    throw new HttpError(500, 'Stored provider credentials could not be decrypted.', 'provider_credentials_error');
  }
}

async function loadCredentials(table) {
  const rows = await dbSelect(table, { select: '*', id: 'eq.true', limit: 1 });
  return rows?.[0] ? decrypt(rows[0]) : null;
}

async function saveCredentials(table, credentials) {
  const encrypted = encrypt(credentials);
  const result = await supabaseRequest(`/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    body: { id: true, ...encrypted },
    prefer: 'resolution=merge-duplicates,return=representation'
  });
  return result?.[0] || null;
}

async function clearCredentials(table) {
  await supabaseRequest(`/rest/v1/${table}?id=eq.true`, { method: 'DELETE', prefer: 'return=minimal' });
}

export async function loadNetcashCredentials() {
  const credentials = await loadCredentials('netcash_credentials');
  if (!credentials) return null;
  const riskServiceKey = credentials.riskServiceKey || credentials.riskReportsServiceKey || '';
  return { ...credentials, riskServiceKey, riskReportsServiceKey:riskServiceKey };
}

export function saveNetcashCredentials(credentials) {
  const riskServiceKey = credentials?.riskServiceKey || credentials?.riskReportsServiceKey || '';
  return saveCredentials('netcash_credentials', { ...credentials, riskServiceKey, riskReportsServiceKey:riskServiceKey });
}

export function clearNetcashCredentials() { return clearCredentials('netcash_credentials'); }
export function loadCreditBureauCredentials() { return loadCredentials('credit_bureau_credentials'); }
export function saveCreditBureauCredentials(credentials) { return saveCredentials('credit_bureau_credentials', credentials); }
export function clearCreditBureauCredentials() { return clearCredentials('credit_bureau_credentials'); }
export function loadCustomPaymentProviderCredentials() { return loadCredentials('custom_payment_provider_credentials'); }
export function saveCustomPaymentProviderCredentials(credentials) { return saveCredentials('custom_payment_provider_credentials', credentials); }
export function clearCustomPaymentProviderCredentials() { return clearCredentials('custom_payment_provider_credentials'); }

export function maskedSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}
