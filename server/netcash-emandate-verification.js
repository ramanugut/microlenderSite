import { HttpError } from './http.js';
import { loadNetcashCredentials } from './provider-secrets.js';

const NIF_URL = 'https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_REFERENCE = /^[A-Za-z0-9._-]{3,50}$/;

const STATUS = Object.freeze({
  '1': 'capturing',
  '2': 'awaiting_authorisation',
  '3': 'expired',
  '4': 'failed',
  '5': 'declined',
  '6': 'accepted',
  '7': 'details_changed',
  '8': 'capturing',
  '9': 'verified',
  '10': 'unverified',
  '11': 'capturing'
});

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[character]));
}

function unxml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(source, name) {
  const match = String(source || '').match(
    new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i')
  );
  return match ? unxml(match[1].trim()) : null;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function nif(method, params, timeout = 20000) {
  const namespace = 'http://tempuri.org/NIWS_NIF/';
  const fields = Object.entries(params).map(([key, value]) => `<${key}>${xml(value)}</${key}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="${namespace}">${fields}</${method}></soap:Body></soap:Envelope>`;
  const response = await fetch(NIF_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${namespace}${method}"` },
    body: envelope,
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault[\s>]/i.test(text)) {
    throw new HttpError(502, 'Netcash mandate verification is temporarily unavailable.', 'netcash_emandate_verification_failed');
  }
  return text;
}

export function parseMandateData(payload, accountReference) {
  const reference = String(accountReference || '').trim();
  const text = String(payload || '').trim();
  if (!text || /FILE NOT READY/i.test(text)) return { ready: false, found: false, statusCode: null, status: 'pending' };
  if (/^(100|200)$/.test(text)) throw new HttpError(502, 'Netcash could not return mandate verification data.', 'netcash_emandate_verification_failed');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('###')) continue;
    const fields = line.split('\t');
    if (String(fields[1] || '').trim() !== reference) continue;
    const statusCode = String(fields[0] || '').trim();
    return { ready: true, found: true, statusCode, status: STATUS[statusCode] || 'unknown' };
  }
  return { ready: true, found: false, statusCode: null, status: 'not_found' };
}

export async function verifyNetcashEMandate(accountReference, { attempts = 6, delayMs = 650 } = {}) {
  const reference = String(accountReference || '').trim();
  if (!ACCOUNT_REFERENCE.test(reference)) throw new HttpError(400, 'The Netcash mandate reference is invalid.', 'invalid_emandate_reference');

  const credentials = await loadNetcashCredentials();
  const serviceKey = String(credentials?.debitOrderServiceKey || '').trim();
  if (!GUID.test(serviceKey)) throw new HttpError(503, 'Netcash Debit Order credentials are unavailable.', 'configuration_error');

  const requestXml = await nif('RequestMandateData', { ServiceKey: serviceKey });
  const fileToken = String(tag(requestXml, 'RequestMandateDataResult') || tag(requestXml, 'String') || '').trim();
  if (!fileToken || /^(100|200)$/.test(fileToken)) throw new HttpError(502, 'Netcash could not start mandate verification.', 'netcash_emandate_verification_failed');

  const tries = Math.max(1, Math.min(Number(attempts) || 1, 8));
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const retrieveXml = await nif('RetrieveMandateData', { ServiceKey: serviceKey, FileToken: fileToken });
    const result = tag(retrieveXml, 'RetrieveMandateDataResult') || tag(retrieveXml, 'String') || '';
    const parsed = parseMandateData(result, reference);
    if (parsed.ready) return { ...parsed, fileToken, checkedAt: new Date().toISOString() };
    if (attempt < tries) await sleep(Math.max(100, Math.min(Number(delayMs) || 650, 1500)));
  }

  // Fail closed: a callback that cannot be independently verified must not change
  // a mandate's operational state. The provider can retry, or staff can resync later.
  throw new HttpError(503, 'Netcash mandate status is not ready for verification yet.', 'netcash_emandate_status_pending');
}
