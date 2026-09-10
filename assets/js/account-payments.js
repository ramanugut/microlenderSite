(() => {
  'use strict';
  const client = window.kredrunSupabase;
  if (!client || window.__kredrunAccountPaymentsLoaded) return;
  window.__kredrunAccountPaymentsLoaded = true;

  const money = value => `R${new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))}`;

  function settlementModal() {
    let modal = document.querySelector('[data-settlement-modal]');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'payment-modal';
    modal.dataset.settlementModal = '';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="payment-modal__backdrop" data-settlement-cancel></div>
      <section class="payment-modal__card" role="dialog" aria-modal="true" aria-labelledby="settlement-modal-title" aria-describedby="settlement-modal-copy" tabindex="-1">
        <button class="payment-modal__close" type="button" aria-label="Close settlement confirmation" data-settlement-cancel>&times;</button>
        <div class="payment-modal__icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M12 3 4.8 6.2v4.9c0 4.5 3 8.6 7.2 9.9 4.2-1.3 7.2-5.4 7.2-9.9V6.2L12 3Zm3.2 6.9-3.8 4.3a1 1 0 0 1-1.5.1l-2-1.9 1.4-1.5 1.2 1.2 3.2-3.6 1.5 1.4Z"/></svg></div>
        <p class="payment-modal__eyebrow">Early settlement</p>
        <h2 id="settlement-modal-title">Settle this loan?</h2>
        <p id="settlement-modal-copy" class="payment-modal__copy">Please review your settlement amount before continuing.</p>
        <div class="payment-modal__amount"><span>Total settlement amount</span><strong data-settlement-amount></strong></div>
        <div class="payment-modal__saving" data-settlement-saving hidden><span>You save</span><strong data-settlement-rebate></strong><small>Future interest and service fees</small></div>
        <p class="payment-modal__note">Your loan will only be settled after the selected payment provider confirms the payment.</p>
        <div class="payment-modal__actions"><button class="payment-modal__button payment-modal__button--secondary" type="button" data-settlement-cancel>Cancel</button><button class="payment-modal__button payment-modal__button--primary" type="button" data-settlement-continue>Continue</button></div>
      </section>`;
    document.body.append(modal);
    return modal;
  }

  function confirmSettlement(amount, rebate) {
    const modal = settlementModal();
    const card = modal.querySelector('.payment-modal__card');
    const continueButton = modal.querySelector('[data-settlement-continue]');
    const saving = modal.querySelector('[data-settlement-saving]');
    const focusable = [...modal.querySelectorAll('button:not([disabled])')];
    const previousFocus = document.activeElement;
    modal.querySelector('[data-settlement-amount]').textContent = money(amount);
    modal.querySelector('[data-settlement-rebate]').textContent = money(rebate);
    saving.hidden = !(rebate > 0);
    modal.hidden = false;
    document.body.classList.add('payment-modal-open');
    return new Promise(resolve => {
      const finish = confirmed => {
        modal.hidden = true; document.body.classList.remove('payment-modal-open');
        modal.removeEventListener('click', onClick); document.removeEventListener('keydown', onKeydown);
        if (!confirmed && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        resolve(confirmed);
      };
      const onClick = event => { if (event.target.closest('[data-settlement-continue]')) finish(true); else if (event.target.closest('[data-settlement-cancel]')) finish(false); };
      const onKeydown = event => {
        if (event.key === 'Escape') return finish(false);
        if (event.key !== 'Tab' || focusable.length < 2) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      modal.addEventListener('click', onClick); document.addEventListener('keydown', onKeydown);
      requestAnimationFrame(() => { card.classList.add('payment-modal__card--open'); continueButton.focus(); window.setTimeout(() => card.classList.remove('payment-modal__card--open'), 260); });
    });
  }

  function notice(message, type = 'info') {
    let region = document.querySelector('[data-payment-notice]');
    if (!region) { region = document.createElement('div'); region.dataset.paymentNotice = ''; region.className = 'payment-notice'; document.body.append(region); }
    region.className = `payment-notice ${type}`; region.textContent = message; region.hidden = false;
    window.setTimeout(() => { if (region.isConnected) region.hidden = true; }, 6500);
  }

  async function accessToken() {
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Please sign in again.');
    return token;
  }

  async function api(path, options = {}) {
    const token = await accessToken();
    const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(25000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'The payment request could not be completed.');
    return payload;
  }

  async function startPayment(button, paymentType) {
    if (button.dataset.running === 'true') return;
    button.dataset.running = 'true'; button.disabled = true;
    const original = button.textContent;
    try {
      button.textContent = paymentType === 'settlement' ? 'Calculating settlement…' : 'Preparing payment…';
      const loanId = button.dataset.payLoan || button.dataset.settleLoan;
      const query = new URLSearchParams({ loanId, paymentType });
      const quote = await api(`/api/payments/quote?${query}`);
      if (paymentType === 'settlement') {
        const rebate = Number(quote.breakdown?.future_charge_rebate || 0);
        if (!await confirmSettlement(quote.amount, rebate)) return;
      }
      button.textContent = `Starting ${quote.providerName || 'payment'}…`;
      const payment = await api('/api/payments/start', { method:'POST', body:JSON.stringify({ loanId, paymentType, scheduleId:quote.scheduleId }) });
      if (payment.interaction === 'redirect' && payment.authorizationUrl) {
        window.location.assign(payment.authorizationUrl);
        return;
      }
      notice(payment.message || `${payment.providerName || 'The payment provider'} is processing your payment request.`, 'success');
    } catch (error) {
      notice(error.message || 'The payment could not be started.', 'error');
    } finally {
      if (button.isConnected) { delete button.dataset.running; button.disabled = false; button.textContent = original; }
    }
  }

  document.addEventListener('click', event => {
    const pay = event.target.closest('[data-pay-loan]'); if (pay) return startPayment(pay, 'instalment');
    const settle = event.target.closest('[data-settle-loan]'); if (settle) return startPayment(settle, 'settlement');
  });

  (async () => {
    const params = new URLSearchParams(window.location.search);
    const paymentState = params.get('payment');
    if (paymentState === 'success') { history.replaceState(null, '', 'account.html'); notice('Payment confirmed. Your loan balance and instalment have been updated.', 'success'); return; }
    if (paymentState === 'request') { history.replaceState(null, '', 'account.html'); notice('Thank you. Your payment provider is confirming the payment and your balance will update shortly.', 'success'); return; }
    if (paymentState !== 'verify') return;
    const reference = params.get('reference') || params.get('trxref');
    const provider = params.get('provider');
    if (!reference || !provider) { history.replaceState(null, '', 'account.html'); notice('The payment provider did not return enough information to verify this payment.', 'error'); return; }
    try {
      notice('Confirming your payment…');
      const query = new URLSearchParams({ provider, reference });
      await api(`/api/payments/verify?${query}`);
      window.location.replace('account.html?payment=success');
    } catch (error) {
      history.replaceState(null, '', 'account.html');
      notice(error.message || 'The payment could not be confirmed yet.', 'error');
    }
  })();
})();
