import crypto from 'node:crypto';
import { HttpError } from './http.js';

const XDS_NAMESPACE = 'http://www.web.xds.co.za/XDSConnectWS';
const XDS_ENDPOINTS = {
  uat: 'https://www.uat.xds.co.za/xdsconnect/XDSConnectWS.asmx',
  production: 'https://www.web.xds.co.za/xdsconnect/XDSconnectWS.asmx'
};

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'
  })[char]);
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

function tag(source, name) {
  const match = String(source || '').match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return match ? decodeXml(match[1].trim()) : null;
}

function firstTag(source, names) {
  for (const name of names) {
    const value = tag(source, name);
    if (value !== null && value !== '') return value;
  }
  return null;
}

function numericTag(source, names) {
  const value = firstTag(source, names);
  if (value === null) return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function booleanTag(source, names) {
  const value = firstTag(source, names);
  if (value === null) return false;
  return ['true','1','yes','y','active','under debt review'].includes(String(value).trim().toLowerCase());
}

function xdsEndpoint(config) {
  const configured = String(config?.api_base_url || '').trim();
  if (configured) return configured;
  return XDS_ENDPOINTS[config?.environment === 'production' ? 'production' : 'uat'];
}

async function xdsSoapCall(config, method, params, timeoutMs = 45000) {
  const endpoint = xdsEndpoint(config);
  const body = Object.entries(params).map(([key,value]) => `<${key}>${escapeXml(value)}</${key}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="${XDS_NAMESPACE}">${body}</${method}></soap:Body></soap:Envelope>`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${XDS_NAMESPACE}/${method}"`
    },
    body: envelope,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok || /<(?:\w+:)?Fault[\s>]/i.test(text)) {
    const message = tag(text,'faultstring') || tag(text,'Text') || `XDS returned HTTP ${response.status}.`;
    throw new HttpError(response.status >= 500 ? 502 : 400, message, 'xds_upstream_error');
  }
  const result = tag(text, `${method}Result`);
  if (result === null) throw new HttpError(502, `XDS did not return ${method}Result.`, 'xds_empty_response');
  return { result, rawSoap: text };
}

async function xdsLogin(config, credentials) {
  const username = String(credentials?.username || '').trim();
  const password = String(credentials?.password || '');
  if (!username || !password) throw new HttpError(400, 'XDS username and password are required.', 'xds_credentials_required');
  const { result } = await xdsSoapCall(config, 'Login', { strUser: username, strPwd: password }, 30000);
  const clean = String(result || '').trim();
  if (!clean || /invalid|error|failed|denied/i.test(clean)) throw new HttpError(400, 'XDS rejected the supplied credentials.', 'xds_authentication_failed');
  return clean;
}

function normalizeXdsReport(reportXml, requestReference) {
  const score = numericTag(reportXml, ['CreditScore','ConsumerCreditScore','Score','BureauScore','RiskScore']);
  const monthlyDebt = numericTag(reportXml, [
    'TotalMonthlyInstalment','TotalMonthlyInstallment','TotalMonthlyPayment','TotalMonthlyRepayment',
    'MonthlyDebt','TotalMonthlyDebt','MonthlyInstalment','MonthlyInstallment'
  ]);
  const totalDebt = numericTag(reportXml, [
    'TotalOutstandingBalance','TotalOutstanding','TotalBalance','TotalDebt','OutstandingBalance','TotalExposure'
  ]);
  const providerReference = firstTag(reportXml, ['EnquiryResultID','EnquiryID','EnquiryReference','Reference','YourReference']) || requestReference;
  const scoreBand = firstTag(reportXml, ['ScoreBand','RiskCategory','RiskBand','RiskGrade']);
  const judgmentsCount = numericTag(reportXml, ['JudgmentsCount','JudgementCount','Judgments','Judgements']);
  const defaultsCount = numericTag(reportXml, ['DefaultsCount','DefaultCount','Defaults']);
  const debtReviewFlag = booleanTag(reportXml, ['DebtReviewFlag','UnderDebtReview','DebtReviewStatus','IsUnderDebtReview']);
  const responseHash = crypto.createHash('sha256').update(reportXml).digest('hex');
  const parsed = {
    providerReference,
    creditScore: score,
    scoreBand,
    monthlyDebt,
    totalDebt,
    debtReviewFlag,
    judgmentsCount: judgmentsCount === null ? null : Math.max(0, Math.trunc(judgmentsCount)),
    defaultsCount: defaultsCount === null ? null : Math.max(0, Math.trunc(defaultsCount)),
    responseHash,
    parserWarnings: []
  };
  if (monthlyDebt === null) parsed.parserWarnings.push('The selected XDS report did not expose a recognised monthly-debt field. Review the provider report or map the lender-specific XDS product response before relying on automated debt totals.');
  if (score === null) parsed.parserWarnings.push('The selected XDS report did not expose a recognised credit-score field.');
  return parsed;
}

async function oauthToken(config, credentials) {
  const tokenUrl = String(config?.token_url || '').trim();
  const clientId = String(credentials?.clientId || '').trim();
  const clientSecret = String(credentials?.clientSecret || '').trim();
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new HttpError(400, 'The provider token URL, client ID and client secret are required.', 'bureau_oauth_configuration_required');
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (credentials.scope) body.set('scope', String(credentials.scope));
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) throw new HttpError(400, 'The credit bureau rejected the API credentials.', 'bureau_oauth_failed');
  return payload;
}

export function creditBureauProviderInfo(provider) {
  if (provider === 'xds') return {
    id: 'xds', name: 'XDS', publicDocumentation: true, enquiryReady: true,
    notes: 'Public SOAP documentation includes login, consumer matching, credit reports, credit scores and ID verification.'
  };
  if (provider === 'transunion') return {
    id: 'transunion', name: 'TransUnion South Africa', publicDocumentation: true, enquiryReady: false,
    notes: 'The South African API Marketplace is public, but the exact Consumer API entitlement and product schema must be enabled for the lender before the production enquiry adapter can be finalised.'
  };
  return {
    id: 'experian', name: 'Experian South Africa', publicDocumentation: true, enquiryReady: false,
    notes: 'Experian publishes global developer APIs and South African direct-API products, but the South African bureau product endpoint/schema must be supplied through Experian onboarding before live enquiries are enabled.'
  };
}

export async function validateCreditBureauProvider(config, credentials) {
  const provider = String(config?.provider || 'xds');
  if (provider === 'xds') {
    const ticket = await xdsLogin(config, credentials);
    return { valid: true, provider, environment: config.environment, ticketIssued: Boolean(ticket), endpoint: xdsEndpoint(config) };
  }
  const info = creditBureauProviderInfo(provider);
  if (!config?.token_url || !config?.api_base_url) {
    return { valid: false, awaitingProviderAccess: true, provider, message: info.notes };
  }
  const token = await oauthToken(config, credentials);
  return { valid: true, provider, tokenIssued: Boolean(token?.access_token), expiresIn: token?.expires_in || null };
}

export async function runCreditBureauEnquiry({ config, credentials, application, requestReference }) {
  const provider = String(config?.provider || 'xds');
  if (provider !== 'xds') {
    const info = creditBureauProviderInfo(provider);
    throw new HttpError(501, `${info.name} credentials can be stored and validated, but the lender-specific Consumer API request schema must be enabled by the bureau before enquiries are switched on.`, 'bureau_provider_enquiry_adapter_pending');
  }

  const productId = Number(config.provider_product_id);
  if (!Number.isInteger(productId) || productId <= 0) throw new HttpError(400, 'Enter the XDS Product ID supplied for this lender.', 'xds_product_id_required');
  const ticket = await xdsLogin(config, credentials);
  const params = {
    ConnectTicket: ticket,
    EnquiryReason: String(config.enquiry_reason || 'Credit application assessment'),
    consumerID: 0,
    ProductId: productId,
    IdNumber: String(application.id_number || '').trim(),
    PassportNo: '',
    FirstName: String(application.first_name || '').trim(),
    Surname: String(application.last_name || '').trim(),
    BirthDate: String(application.date_of_birth || '').slice(0,10),
    YourReference: requestReference,
    VoucherCode: String(config.voucher_code || '')
  };
  const { result } = await xdsSoapCall(config, 'ConnectGetCreditData', params, 60000);
  if (!String(result || '').trim()) throw new HttpError(502, 'XDS returned an empty credit report.', 'xds_empty_credit_report');
  const normalized = normalizeXdsReport(String(result), requestReference);
  return { provider, reportDate: new Date().toISOString().slice(0,10), ...normalized };
}
