(() => {
  const panel = document.querySelector('[data-current-application]');
  if (!panel) return;

  const summary = document.querySelector('[data-overview-applications]');
  const applicationList = document.querySelector('[data-applications-list]');
  const title = panel.querySelector('[data-current-application-title]');
  const reference = panel.querySelector('[data-current-application-reference]');
  const amountEl = panel.querySelector('[data-current-application-amount]');
  const nextEl = panel.querySelector('[data-current-application-next]');
  const viewButton = panel.querySelector('[data-view-current-application]');
  const stages = [...panel.querySelectorAll('[data-app-stage]')];
  const money = value => `R ${new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 }).format(Number(value || 0))}`;

  const states = {
    received: { label: 'Waiting for review', summary: 'Waiting for review', next: 'Next: lender review', stage: 2, badge: 'Waiting for review' },
    submitted: { label: 'Waiting for review', summary: 'Waiting for review', next: 'Next: lender review', stage: 2, badge: 'Waiting for review' },
    pending: { label: 'Waiting for review', summary: 'Waiting for review', next: 'Next: lender review', stage: 2, badge: 'Waiting for review' },
    under_review: { label: 'In review', summary: 'In review', next: 'Next: decision', stage: 2, badge: 'In review' },
    reviewing: { label: 'In review', summary: 'In review', next: 'Next: decision', stage: 2, badge: 'In review' },
    needs_information: { label: 'Action needed', summary: 'Action needed', next: 'Next: provide requested info', stage: 2, badge: 'Action needed' },
    documents_requested: { label: 'Action needed', summary: 'Action needed', next: 'Next: provide requested info', stage: 2, badge: 'Action needed' },
    approved: { label: 'Approved', summary: 'Approved', next: 'Next: offer & payout', stage: 3, badge: 'Approved' },
    declined: { label: 'Decision made', summary: 'Decision made', next: 'View your decision', stage: 3, badge: 'Decision made' },
    rejected: { label: 'Decision made', summary: 'Decision made', next: 'View your decision', stage: 3, badge: 'Decision made' },
    cancelled: { label: 'Cancelled', summary: 'Cancelled', next: 'Application closed', stage: 3, badge: 'Cancelled' }
  };

  const renderStages = activeStage => {
    stages.forEach((stage, index) => {
      const stageNumber = index + 1;
      const complete = stageNumber < activeStage || (activeStage === 3 && stageNumber === 3);
      stage.classList.toggle('done', complete);
      stage.classList.toggle('active', stageNumber === activeStage && !complete);
      const icon = stage.querySelector('i');
      const nextIcon = complete ? '✓' : String(stageNumber);
      if (icon && icon.textContent !== nextIcon) icon.textContent = nextIcon;
    });
  };

  const relabelApplicationBadges = () => {
    if (!applicationList) return;
    applicationList.querySelectorAll('.status-badge').forEach(badge => {
      const className = [...badge.classList].find(name => name.startsWith('status-') && name !== 'status-badge');
      if (!className) return;
      const key = className.slice(7);
      const nextLabel = states[key]?.badge;
      if (nextLabel && badge.textContent !== nextLabel) badge.textContent = nextLabel;
    });
  };

  // account.js loads the application list asynchronously. Use a short, finite sync instead of
  // observing text mutations. A text MutationObserver here can trigger itself repeatedly and
  // lock the browser when a status badge is rewritten.
  const syncAfterAccountRender = applySummary => {
    relabelApplicationBadges();
    applySummary?.();
  };

  viewButton?.addEventListener('click', () => document.querySelector('[data-account-nav="applications"]')?.click());

  const renderApplication = application => {
    if (!application) {
      panel.hidden = true;
      const desired = 'None<small>No application waiting</small>';
      syncAfterAccountRender(() => {
        if (summary && summary.innerHTML !== desired) summary.innerHTML = desired;
      });
      return;
    }

    const key = String(application.status || 'received').toLowerCase();
    const state = states[key] || { label: 'Application received', summary: 'Application received', next: 'Check application for updates', stage: 2, badge: 'Application received' };

    panel.hidden = false;
    panel.dataset.status = key;
    title.textContent = state.label;
    reference.textContent = application.reference || '';
    amountEl.textContent = money(application.loan_amount);
    nextEl.textContent = state.next;
    renderStages(state.stage);

    const desired = `${state.summary}<small>${money(application.loan_amount)}</small>`;
    syncAfterAccountRender(() => {
      if (summary && summary.innerHTML !== desired) summary.innerHTML = desired;
    });
  };

  const useApplications = applications => renderApplication(Array.isArray(applications) ? applications[0] : null);
  if (Array.isArray(window.__kredrunAccountApplications)) {
    useApplications(window.__kredrunAccountApplications);
  } else {
    window.addEventListener('kredrun:account-applications', event => useApplications(event.detail?.applications), { once: true });
  }
})();
