const CLOSED_INSTALMENT_STATUSES = new Set(['paid', 'waived']);
const PAYABLE_LOAN_STATUSES = new Set(['active', 'overdue']);
const CLOSED_LOAN_STATUSES = new Set(['paid', 'cancelled', 'written_off']);

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function instalmentRemaining(schedule) {
  if (!schedule) return 0;
  return roundMoney(Math.max(0, Number(schedule.amount_due || 0) - Number(schedule.amount_paid || 0)));
}

export function loanOutstanding(loan) {
  return roundMoney(Number(loan?.outstanding_balance || 0));
}

export function isInstalmentSettled(schedule) {
  if (!schedule) return true;
  if (CLOSED_INSTALMENT_STATUSES.has(schedule.status)) return true;
  return instalmentRemaining(schedule) <= 0;
}

export function isLoanPayable(loan) {
  if (!loan) return false;
  if (!PAYABLE_LOAN_STATUSES.has(loan.status)) return false;
  if (loan.payout_status !== 'paid') return false;
  return loanOutstanding(loan) > 0;
}

export function assertLoanPayable(loan) {
  if (!isLoanPayable(loan)) {
    const error = new Error('This loan does not have an outstanding balance.');
    error.code = 'loan_not_payable';
    error.status = 409;
    throw error;
  }
}

export function assertInstalmentCollectable(schedule, loan) {
  assertLoanPayable(loan);
  if (isInstalmentSettled(schedule)) {
    const error = new Error('This instalment is already paid or waived.');
    error.code = 'instalment_not_payable';
    error.status = 409;
    throw error;
  }
}

export function assertNoPendingPaymentRequest(existing = []) {
  if (!existing.length) return;
  const error = new Error('A payment request is already pending for this instalment.');
  error.code = 'payment_request_pending';
  error.status = 409;
  throw error;
}

export function canRecordInstalmentPayment(schedule, loan) {
  return isLoanPayable(loan) && !isInstalmentSettled(schedule);
}

export function canSendSettlementRequest(loan) {
  return isLoanPayable(loan);
}

export function assertLoanAdjustable(loan) {
  if (!loan) {
    const error = new Error('Loan not found.');
    error.code = 'loan_not_found';
    error.status = 404;
    throw error;
  }
  if (CLOSED_LOAN_STATUSES.has(loan.status)) {
    const error = new Error('Closed loans cannot be adjusted.');
    error.code = 'loan_closed';
    error.status = 409;
    throw error;
  }
}
