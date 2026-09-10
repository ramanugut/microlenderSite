window.KREDRUN_SUPABASE = {
  url: 'https://tfvfwrugdvjpgzoitwtp.supabase.co',
  publishableKey: 'sb_publishable_rxEjj5gJJIgpHFj07u3IcQ_zDOLT7jR'
};

if (document.body?.classList.contains('admin-page')) {
  const fallback = document.createElement('span');
  fallback.dataset.firstName = '';
  fallback.hidden = true;
  fallback.setAttribute('aria-hidden', 'true');
  fallback.dataset.adminStartupFallback = '';
  document.body.append(fallback);
}

async function kredrunRecoverPendingStaffMfa(client) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (sessionError || !token) throw new Error('Please sign in again.');

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch('/api/mfa-enrollment-recovery', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.message || 'Could not restart two-factor authentication setup.');
  }
  return payload;
}

function kredrunCaptureMfaEnrollment(result) {
  const totp = result?.data?.totp;
  if (!totp) return result;

  const qr = String(totp.qr_code || '').trim();
  if (qr) window.__kredrunLatestMfaQrPayload = qr;

  const uri = String(totp.uri || '').trim();
  if (/^otpauth:\/\/totp\//i.test(uri)) {
    window.__kredrunLatestMfaOtpAuthUri = uri;
  }

  // Keep Supabase's response untouched. Its documented qr_code value is already
  // suitable for an <img>; rewriting the SVG/data URL can corrupt the QR matrix.
  return result;
}

function kredrunPatchMfaEnrollmentRecovery(client) {
  if (!document.body?.classList.contains('admin-page') || !client?.auth?.mfa) return client;
  const mfa = client.auth.mfa;
  if (mfa.__kredrunPendingEnrollmentRecovery) return client;

  const normalEnroll = mfa.enroll.bind(mfa);
  mfa.enroll = async options => {
    const isStaffTotp = options?.factorType === 'totp' && options?.friendlyName === 'KredRun lender admin';
    if (!isStaffTotp) return normalEnroll(options);

    const firstAttempt = kredrunCaptureMfaEnrollment(await normalEnroll(options));
    if (!firstAttempt?.error) return firstAttempt;

    try {
      await kredrunRecoverPendingStaffMfa(client);
    } catch (recoveryError) {
      console.warn('KredRun MFA enrollment recovery failed.', recoveryError);
      return firstAttempt;
    }

    return kredrunCaptureMfaEnrollment(await normalEnroll(options));
  };

  Object.defineProperty(mfa, '__kredrunPendingEnrollmentRecovery', {
    value: true,
    configurable: false,
    enumerable: false
  });
  return client;
}

function kredrunQrImageSource(value) {
  const qr = String(value || '').trim();
  if (!qr) return { src: '', revoke: null };

  if (qr.startsWith('<svg')) {
    const objectUrl = URL.createObjectURL(new Blob([qr], { type: 'image/svg+xml' }));
    return { src: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
  }

  if (/^data:image\//i.test(qr)) return { src: qr, revoke: null };
  return { src: '', revoke: null };
}

function kredrunEnhanceMfaSetup() {
  const gate = document.querySelector('[data-kredrun-mfa-gate]');
  if (!gate || gate.dataset.kredrunQrEnhanced === 'true') return;

  const card = gate.querySelector('[data-kredrun-mfa-card]');
  const secret = card?.querySelector('[data-kredrun-mfa-secret]');
  const qrPayload = String(window.__kredrunLatestMfaQrPayload || '');
  const uri = String(window.__kredrunLatestMfaOtpAuthUri || '');
  if (!card || !secret || !qrPayload) return;

  const { src, revoke } = kredrunQrImageSource(qrPayload);
  if (!src) return;

  // Remove the malformed SVG / failed image created by the legacy innerHTML path.
  card.querySelectorAll(':scope > img[alt="Authenticator QR code"], :scope > svg').forEach(node => node.remove());

  const qrImage = document.createElement('img');
  qrImage.dataset.kredrunMfaQr = '';
  qrImage.alt = 'Authenticator QR code';
  qrImage.decoding = 'sync';
  qrImage.loading = 'eager';
  qrImage.src = src;
  if (revoke) qrImage.addEventListener('load', revoke, { once: true });
  secret.insertAdjacentElement('beforebegin', qrImage);

  if (/^otpauth:\/\/totp\//i.test(uri)) {
    const open = document.createElement('a');
    open.dataset.kredrunMfaOpen = '';
    open.href = uri;
    open.textContent = 'Open in authenticator';
    open.setAttribute('aria-label', 'Open this KredRun MFA setup in an authenticator app');
    secret.insertAdjacentElement('afterend', open);
  }

  gate.dataset.kredrunQrEnhanced = 'true';
}

if (document.body?.classList.contains('admin-page')) {
  const mfaObserver = new MutationObserver(kredrunEnhanceMfaSetup);
  const startMfaObserver = () => {
    if (!document.documentElement) return;
    mfaObserver.observe(document.documentElement, { childList: true, subtree: true });
    kredrunEnhanceMfaSetup();
  };
  if (document.documentElement) startMfaObserver();
  else window.addEventListener('DOMContentLoaded', startMfaObserver, { once: true });
}

if (document.body?.classList.contains('admin-page') && window.supabase?.createClient && !window.__kredrunMfaCreateClientPatched) {
  window.__kredrunMfaCreateClientPatched = true;
  const normalCreateClient = window.supabase.createClient.bind(window.supabase);
  window.supabase.createClient = (...args) => kredrunPatchMfaEnrollmentRecovery(normalCreateClient(...args));
}

function loadScriptOnce(flag,src){if(window[flag])return null;window[flag]=true;const script=document.createElement('script');script.src=src;script.async=false;script.defer=true;document.body.append(script);return script;}
function loadStyleOnce(flag,href){if(window[flag])return null;window[flag]=true;const style=document.createElement('link');style.rel='stylesheet';style.href=href;document.head.append(style);return style;}
function kredrunLoadProviderExtensions() {
  if (!window.kredrunSupabase) return;
  if (document.body?.classList.contains('admin-page')) {
    loadStyleOnce('__kredrunMfaQrScanFixStyle','assets/css/mfa-qr-scan-fix.css?v=20260907-2');
    loadScriptOnce('__kredrunAdminPostMfaBootRequested','assets/js/admin-post-mfa-boot.js?v=20260907-1');
    loadStyleOnce('__kredrunComplianceStyleRequested','assets/css/admin-compliance.css?v=20260906-1');
    loadScriptOnce('__kredrunComplianceSettingsRequested','assets/js/admin-compliance-settings.js?v=20260906-1');
    loadScriptOnce('__kredrunComplianceCompatRequested','assets/js/admin-compliance-compat.js?v=20260906-1');
    loadScriptOnce('__kredrunComplianceWorkflowRequested','assets/js/admin-compliance.js?v=20260906-1');
    loadScriptOnce('__kredrunCreditBureauAdminRequested','assets/js/admin-credit-bureau.js?v=20260905-3');
    loadStyleOnce('__kredrunNetcashReadinessStyleRequested','assets/css/admin-netcash-readiness.css?v=20260905-3');
    loadScriptOnce('__kredrunNetcashReadinessRequested','assets/js/admin-netcash-readiness.js?v=20260905-3');
    loadStyleOnce('__kredrunServicingStyleRequested','assets/css/admin-servicing-extension.css?v=20260905-1');
    loadScriptOnce('__kredrunAdminServicingRequested','assets/js/admin-servicing-extension.js?v=20260905-1');
    loadScriptOnce('__kredrunAdminLifecycleKickRequested','assets/js/admin-lifecycle-kick.js?v=20260905-1');
    loadScriptOnce('__kredrunAdminCommunicationsDocumentsRequested','assets/js/admin-communications-documents.js?v=20260905-1');
    loadScriptOnce('__kredrunAdminPermissionsAuditRequested','assets/js/admin-permissions-audit.js?v=20260905-2');
    loadScriptOnce('__kredrunAdminPermissionUiFixesRequested','assets/js/admin-permission-ui-fixes.js?v=20260905-1');
    loadStyleOnce('__kredrunAdminReportsStyleRequested','assets/css/admin-reports.css?v=20260905-1');
    loadScriptOnce('__kredrunAdminReportsRequested','assets/js/admin-reports.js?v=20260905-1');
    loadScriptOnce('__kredrunAdminReportsCompatRequested','assets/js/admin-reports-compat.js?v=20260905-1');
    loadStyleOnce('__kredrunAdminSecurityHealthStyleRequested','assets/css/admin-security-health.css?v=20260905-1');
    loadScriptOnce('__kredrunAdminSecurityHealthRequested','assets/js/admin-security-health.js?v=20260905-1');
  }
  if (document.body?.classList.contains('application-page')) loadScriptOnce('__kredrunCreditBureauConsentRequested','assets/js/credit-bureau-consent.js?v=20260905-3');
  if (document.body?.classList.contains('account-page')) {
    loadScriptOnce('__kredrunSettlementLettersRequested','assets/js/account-settlement-letters.js?v=20260905-1');
    loadScriptOnce('__kredrunAccountLifecycleKickRequested','assets/js/account-lifecycle-kick.js?v=20260905-1');
  }
  if (document.body?.matches('.admin-page,.account-page,.application-page')) loadScriptOnce('__kredrunSessionSecurityRequested','assets/js/session-security.js?v=20260905-1');
}
window.addEventListener('kredrun:supabase-ready', kredrunLoadProviderExtensions);
window.addEventListener('load', kredrunLoadProviderExtensions);
if (document.readyState === 'complete') setTimeout(kredrunLoadProviderExtensions, 0);
