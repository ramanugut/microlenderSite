(() => {
  const body = document.body;
  if (!body?.classList.contains('account-page')) return;

  const greeting = document.querySelector('[data-account-greeting]');
  const applications = document.querySelector('[data-overview-applications]');
  const loans = document.querySelector('[data-overview-loans]');
  const payment = document.querySelector('[data-overview-payment]');
  const applicationList = document.querySelector('[data-applications-list]');
  const loanList = document.querySelector('[data-loans-list]');

  const text = element => String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  const baseDataReady = () => {
    const name = text(greeting);
    const applicationSummary = text(applications);
    const loanSummary = text(loans);
    const paymentSummary = text(payment);
    const listsReady = !applicationList?.querySelector('.portal-loading') && !loanList?.querySelector('.portal-loading');
    const applicationStatusReady = Boolean(applicationSummary) && !/^\d+$/.test(applicationSummary) && !/loading/i.test(applicationSummary);

    return Boolean(name && name.toLowerCase() !== 'there')
      && applicationStatusReady
      && Boolean(loanSummary)
      && Boolean(paymentSummary) && !/loading/i.test(paymentSummary)
      && listsReady;
  };

  const reveal = () => {
    if (!body.classList.contains('account-booting')) return;
    body.classList.remove('account-booting');
    body.classList.add('account-ready');
    document.querySelector('[data-account-boot]')?.setAttribute('aria-hidden', 'true');
  };

  const started = performance.now();
  const check = () => {
    if (baseDataReady()) return reveal();
    if (performance.now() - started > 8000) return reveal();
    window.setTimeout(check, 60);
  };

  check();
})();
