(() => {
  'use strict';

  const CLOSED_INSTALMENT_STATUSES = new Set(['paid', 'waived']);
  const PAYABLE_LOAN_STATUSES = new Set(['active', 'overdue']);
  const CLOSED_LOAN_STATUSES = new Set(['paid', 'cancelled', 'written_off']);
  const DECIDED_APPLICATION_STATUSES = new Set(['approved', 'declined', 'cancelled']);
  const REVIEWABLE_APPLICATION_STATUSES = new Set(['received', 'under_review']);
  const PAYOUT_MARKABLE_STATUSES = new Set(['ready', 'pending']);

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function instalmentRemaining(schedule) {
    if (!schedule) return 0;
    return roundMoney(Math.max(0, Number(schedule.amount_due || 0) - Number(schedule.amount_paid || 0)));
  }

  function loanOutstanding(loan) {
    return roundMoney(Number(loan?.outstanding_balance || 0));
  }

  function isInstalmentSettled(schedule) {
    if (!schedule) return true;
    if (CLOSED_INSTALMENT_STATUSES.has(schedule.status)) return true;
    return instalmentRemaining(schedule) <= 0;
  }

  function isCollectableSchedule(schedule, loan) {
    return isLoanPayable(loan) && !isInstalmentSettled(schedule);
  }

  function isLoanPayable(loan) {
    if (!loan) return false;
    if (!PAYABLE_LOAN_STATUSES.has(loan.status)) return false;
    if (loan.payout_status !== 'paid') return false;
    return loanOutstanding(loan) > 0;
  }

  function canRecordInstalmentPayment(schedule, loan) {
    return isCollectableSchedule(schedule, loan);
  }

  function canSendInstalmentRequest(schedule, loan) {
    return isCollectableSchedule(schedule, loan);
  }

  function canSendSettlementRequest(loan) {
    return isLoanPayable(loan);
  }

  function canAddLoanCharge(loan) {
    if (!loan) return false;
    if (CLOSED_LOAN_STATUSES.has(loan.status)) return false;
    return loanOutstanding(loan) > 0 || PAYABLE_LOAN_STATUSES.has(loan.status);
  }

  function canMarkPayoutPaid(loan) {
    if (!loan) return false;
    return PAYABLE_LOAN_STATUSES.has(loan.status)
      && loanOutstanding(loan) > 0
      && PAYOUT_MARKABLE_STATUSES.has(loan.payout_status);
  }

  function clientHasActiveLoan(loans, userId) {
    return (loans || []).some(loan =>
      loan.user_id === userId
      && PAYABLE_LOAN_STATUSES.has(loan.status)
      && loanOutstanding(loan) > 0
    );
  }

  function clientHasPendingApplication(applications, userId) {
    return (applications || []).some(app =>
      app.user_id === userId && REVIEWABLE_APPLICATION_STATUSES.has(app.status)
    );
  }

  function canCreateLoanForClient(userId, loans = []) {
    return !clientHasActiveLoan(loans, userId);
  }

  function canCreateLoanFromApplication(application, existingLoans = []) {
    if (!application) return false;
    if (clientHasActiveLoan(existingLoans, application.user_id)) return false;
    if (DECIDED_APPLICATION_STATUSES.has(application.status) && application.status !== 'approved') return false;
    if (application.status === 'approved') {
      if (existingLoans.some(loan => loan.application_id === application.id)) return false;
    }
    return REVIEWABLE_APPLICATION_STATUSES.has(application.status) || application.status === 'approved';
  }

  function canDeclineApplication(application) {
    return application && REVIEWABLE_APPLICATION_STATUSES.has(application.status);
  }

  function canStartApplicationReview(application) {
    return application?.status === 'received';
  }

  function canCreateManualApplication(applications, userId) {
    return !clientHasPendingApplication(applications, userId);
  }

  function canVerifyDocument(document) {
    return document?.verification_status === 'pending';
  }

  function canRejectDocument(document) {
    return document?.verification_status === 'pending';
  }

  function canChangeLoanStatus(loan, nextStatus) {
    if (!loan || !nextStatus || loan.status === nextStatus) return false;
    if (CLOSED_LOAN_STATUSES.has(loan.status)) return false;
    const balance = loanOutstanding(loan);
    if (nextStatus === 'paid' && balance > 0) return false;
    if (['active', 'overdue'].includes(nextStatus) && balance <= 0) return false;
    if (loan.status === 'paid' && ['active', 'overdue'].includes(nextStatus)) return false;
    return true;
  }

  function collectableDueTotal(schedules, loans, filter) {
    return (schedules || []).filter(schedule => {
      const loan = (loans || []).find(item => item.id === schedule.loan_id);
      return isCollectableSchedule(schedule, loan) && (!filter || filter(schedule, loan));
    }).reduce((sum, schedule) => sum + instalmentRemaining(schedule), 0);
  }

  function guardMessage(rule) {
    return ({
      instalment_settled: 'This instalment is already paid or waived.',
      loan_not_payable: 'This loan is closed, unpaid-out or has no outstanding balance.',
      loan_closed: 'This loan is closed and cannot be changed this way.',
      application_decided: 'This application has already been decided.',
      application_pending: 'This client already has an application awaiting review.',
      loan_already_linked: 'A loan already exists for this application.',
      active_loan_exists: 'This client already has an active loan with an outstanding balance.',
      payout_recorded: 'Payout has already been recorded.',
      payout_not_ready: 'This loan is not ready for payout recording.',
      invalid_status_change: 'This status change is not allowed for the current loan balance.',
      document_not_pending: 'Only pending documents can be reviewed.'
    })[rule] || 'This action is not allowed.';
  }

  window.KredRunBusinessRules = {
    CLOSED_INSTALMENT_STATUSES,
    PAYABLE_LOAN_STATUSES,
    CLOSED_LOAN_STATUSES,
    instalmentRemaining,
    loanOutstanding,
    isInstalmentSettled,
    isCollectableSchedule,
    isLoanPayable,
    canRecordInstalmentPayment,
    canSendInstalmentRequest,
    canSendSettlementRequest,
    canAddLoanCharge,
    canMarkPayoutPaid,
    canCreateLoanForClient,
    canCreateLoanFromApplication,
    canCreateManualApplication,
    canDeclineApplication,
    canStartApplicationReview,
    canVerifyDocument,
    canRejectDocument,
    canChangeLoanStatus,
    collectableDueTotal,
    clientHasActiveLoan,
    clientHasPendingApplication,
    guardMessage
  };
})();

(() => {
  if (!document.body?.classList.contains('admin-page')) return;

  if (!document.querySelector('style[data-kredrun-unified-settings-style]')) {
    const style=document.createElement('style');
    style.dataset.kredrunUnifiedSettingsStyle='';
    style.textContent='[data-view="settings"] [data-debit-flow-tab]{display:none!important}';
    document.head.append(style);
  }

  if (!window.__kredrunAdminPostMfaBootLoaded && !document.querySelector('script[data-kredrun-corrected-admin-boot]')) {
    const boot=document.createElement('script');
    boot.src='assets/js/admin-post-mfa-boot.js?v=20260908-3';
    boot.defer=true;
    boot.dataset.kredrunCorrectedAdminBoot='';
    document.head.append(boot);
  }

  if (!document.querySelector('script[data-kredrun-settings-controller]')) {
    const script=document.createElement('script');
    script.src='assets/js/admin-settings-controller.js?v=20260908-3';
    script.defer=true;
    script.dataset.kredrunSettingsController='';
    // The legacy admin-payments loader checks this marker before loading admin-settings.js.
    // Mark the unified controller as the one settings owner so two renderers can never fight.
    script.dataset.adminSettingsLoader='';
    document.head.append(script);
  }
})();