import { HttpError } from './http.js';

const NIF_URL = 'https://ws.netcash.co.za/NIWS/NIWS_NIF.svc';

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
}
function unxml(value) {
  return String(value ?? '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}
function tag(source, name) {
  const match = String(source || '').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return match ? unxml(match[1].trim()) : null;
}
async function nifCall(method, params, timeout = 30000) {
  const action = `http://tempuri.org/NIWS_NIF/${method}`;
  const payload = Object.entries(params).map(([key,value]) => `<${key}>${xml(value)}</${key}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/">${payload}</${method}></soap:Body></soap:Envelope>`;
  const response = await fetch(NIF_URL, { method:'POST', headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${action}"`}, body:envelope, signal:AbortSignal.timeout(timeout) });
  const text = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault[\s>]/i.test(text)) {
    const reason = tag(text,'faultstring') || tag(text,'Text') || `Netcash ${method} failed.`;
    throw new HttpError(response.status >= 500 ? 502 : 400, reason, 'netcash_error');
  }
  return String(tag(text, `${method}Result`) || '').trim();
}

export async function requestMandateData(serviceKey) {
  const result = await nifCall('RequestMandateData', { ServiceKey: serviceKey });
  if (result === '100') throw new HttpError(401, 'Netcash rejected the Debit Order service key.', 'netcash_auth_failed');
  if (result === '200' || !result) throw new HttpError(502, 'Netcash could not create the mandate status file.', 'netcash_mandate_status_error');
  return result;
}

export async function retrieveMandateData(serviceKey, fileToken) {
  return nifCall('RetrieveMandateData', { ServiceKey: serviceKey, FileToken: fileToken });
}

export function parseMandateData(file) {
  const result = [];
  for (const line of String(file || '').split(/\r?\n/)) {
    if (!line || line.startsWith('###')) continue;
    const fields = line.split('\t');
    if (!/^\d+$/.test(String(fields[0] || '').trim()) || !fields[1]) continue;
    result.push({
      statusCode: String(fields[0]).trim(),
      accountReference: String(fields[1]).trim(),
      mandateName: fields[2] || null,
      amount: Number(fields[3] || 0),
      active: String(fields[18] || '') === '1',
      raw: fields
    });
  }
  return result;
}

export function mandateState(statusCode, active = false) {
  const code = String(statusCode || '');
  if (code === '6' || code === '9') return { mandateStatus:'accepted', providerStatus: active || code === '9' ? 'active' : 'pending' };
  if (code === '2') return { mandateStatus:'awaiting_authorisation', providerStatus:'pending' };
  if (['3','4','5','10'].includes(code)) return { mandateStatus: code === '5' ? 'rejected' : 'failed', providerStatus:'failed' };
  return { mandateStatus:'requested', providerStatus:'pending' };
}

export async function requestPresentationDate(serviceKey, actionDate, instruction = 'CompactTwoDay') {
  const cleanDate = String(actionDate || '').replace(/-/g,'');
  const result = await nifCall('RequestPresentationDate', {
    ServiceKey: serviceKey, Date: cleanDate, Instruction: instruction, ForwardActionDate: '0'
  });
  if (result === '100') throw new HttpError(401, 'Netcash rejected the Debit Order service key.', 'netcash_auth_failed');
  if (result === '200' || !/^\d{8}$/.test(result)) return null;
  return `${result.slice(0,4)}-${result.slice(4,6)}-${result.slice(6,8)}`;
}

export async function requestActionDate(serviceKey, actionDate, instruction = 'CompactTwoDay', forward = true) {
  const cleanDate = String(actionDate || '').replace(/-/g,'');
  const result = await nifCall('RequestActionDate', {
    ServiceKey: serviceKey, Date: cleanDate, Instruction: instruction, ForwardActionDate: forward ? '1' : '0'
  });
  if (result === '100') throw new HttpError(401, 'Netcash rejected the Debit Order service key.', 'netcash_auth_failed');
  if (result === '200' || !/^\d{8}$/.test(result)) return null;
  return `${result.slice(0,4)}-${result.slice(4,6)}-${result.slice(6,8)}`;
}

export async function checkPayNowTransaction(requestTrace) {
  const trace = String(requestTrace || '').trim();
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(trace)) throw new HttpError(400, 'Netcash transaction trace is invalid.', 'invalid_netcash_trace');
  const response = await fetch(`https://ws.netcash.co.za/PayNow/TransactionStatus/Check?RequestTrace=${encodeURIComponent(trace)}`, { signal:AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(502, 'Netcash transaction verification failed.', 'netcash_verification_failed');
  const data = await response.json().catch(() => null);
  if (!data || String(data.RequestTrace || '') !== trace) throw new HttpError(502, 'Netcash returned an invalid transaction status.', 'netcash_verification_failed');
  return data;
}
