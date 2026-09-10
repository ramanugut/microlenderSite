(() => {
  'use strict';
  if (window.__kredrunCreditBureauConsentLoaded) return;
  window.__kredrunCreditBureauConsentLoaded = true;

  const form = document.querySelector('#loanApplication');
  if (!form) return;
  const client = window.kredrunSupabase;
  const consentBox = form.querySelector('.consent-box');
  if (!client || !consentBox) return;

  const DRAFT_KEY = 'kredrun-application-draft-v2';
  function removeConsentFromDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object' || !Object.prototype.hasOwnProperty.call(draft,'bureauConsent')) return;
      delete draft.bureauConsent;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (_) {}
  }
  removeConsentFromDraft();

  const marketing = form.elements.marketingConsent?.closest('label');
  const row = document.createElement('label');
  row.className = 'check-row';
  row.dataset.bureauConsentRow = '';
  row.innerHTML = '<input type="checkbox" name="bureauConsent" value="yes" required><span>I consent to the lender obtaining and using my credit-bureau information from a registered credit bureau to assess this application, including my credit profile, repayment history and credit score where applicable.</span>';
  if (marketing) consentBox.insertBefore(row, marketing);
  else consentBox.append(row);

  const alertBox = form.querySelector('[data-form-alert]');
  const submitButton = form.querySelector('[data-submit]') || form.querySelector('button[type="submit"]');
  let consentRecordedForSubmission = false;
  let recording = false;

  function showError(message) {
    if (alertBox) {
      alertBox.textContent = message;
      alertBox.className = 'form-alert show error';
      alertBox.scrollIntoView({ behavior:'smooth', block:'nearest' });
    } else {
      window.alert(message);
    }
  }

  // The main application draft serializer sees dynamically added fields. Remove
  // this specific consent again after draft saves so each application requires
  // a fresh, active consent decision by the applicant.
  form.addEventListener('input', () => setTimeout(removeConsentFromDraft, 500));
  form.addEventListener('change', () => setTimeout(removeConsentFromDraft, 500));

  form.addEventListener('submit', async event => {
    if (consentRecordedForSubmission) {
      consentRecordedForSubmission = false;
      removeConsentFromDraft();
      return;
    }
    if (recording) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const checkbox = form.elements.bureauConsent;
    if (!checkbox?.checked) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    recording = true;
    if (submitButton) submitButton.disabled = true;

    try {
      const { data, error: userError } = await client.auth.getUser();
      if (userError) throw userError;
      const user = data?.user;
      if (!user?.id) throw new Error('Please sign in again before submitting your application.');

      const { error } = await client.from('credit_bureau_consents').insert({
        user_id: user.id,
        consent_version: 'credit-bureau-v1',
        source: 'online_application'
      });
      if (error) throw error;

      consentRecordedForSubmission = true;
      recording = false;
      removeConsentFromDraft();
      if (submitButton) submitButton.disabled = false;
      if (typeof form.requestSubmit === 'function') form.requestSubmit(submitButton || undefined);
      else form.submit();
    } catch (error) {
      recording = false;
      if (submitButton) submitButton.disabled = false;
      showError(error?.message || 'We could not record your credit-bureau consent. Please try again.');
    }
  }, true);
})();
