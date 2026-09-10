(() => {
  const client = window.kredrunSupabase;
  const auth = window.KredRunAuth;
  const profileSchema = window.KredRunClientProfile;
  if (!client || !auth || !profileSchema) return;

  const money = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 2 });
  const dateFmt = new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  const escape = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const amount = value => money.format(Number(value || 0)).replace('ZAR', 'R').trim();
  const date = value => {
    if (!value) return '—';
    const raw = String(value);
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
    return Number.isNaN(parsed.getTime()) ? '—' : dateFmt.format(parsed);
  };
  const statusLabel = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
  const isInternalEmail = value => /^kr-[a-f0-9]+@login\.invalid$/i.test(String(value || '').trim());
  const validEmail = value => /^\S+@\S+\.\S+$/.test(String(value || '').trim()) && !isInternalEmail(value);

  const greeting = document.querySelector('[data-account-greeting]');
  const applicationList = document.querySelector('[data-applications-list]');
  const loanList = document.querySelector('[data-loans-list]');
  const overviewApplications = document.querySelector('[data-overview-applications]');
  const overviewLoans = document.querySelector('[data-overview-loans]');
  const overviewPayment = document.querySelector('[data-overview-payment]');
  const profileForm = document.querySelector('#profileForm');
  const profileMessage = document.querySelector('[data-profile-message]');
  const profileEmailField = document.querySelector('[data-profile-email-field]');
  const loanDetail = document.querySelector('[data-loan-detail]');
  const loanDetailContent = document.querySelector('[data-loan-detail-content]');
  const loanListPanel = loanDetail?.previousElementSibling || null;
  let user = null;
  let loans = [];

  const syncProfileBank = () => {
    if (!profileForm) return;
    profileForm.elements.branch_code.value = profileSchema.bankBranchCode(profileForm.elements.bank_name.value);
  };
  const syncProfileAccountHolder = () => {
    if (!profileForm) return;
    profileForm.elements.bank_account_holder.value = [profileForm.elements.first_name.value, profileForm.elements.last_name.value].map(value => value.trim()).filter(Boolean).join(' ');
  };
  profileForm?.elements.bank_name?.addEventListener('change', syncProfileBank);
  profileForm?.elements.first_name?.addEventListener('input', syncProfileAccountHolder);
  profileForm?.elements.last_name?.addEventListener('input', syncProfileAccountHolder);

  const closeLoanDetail = () => {
    if (loanDetail) loanDetail.hidden = true;
    if (loanListPanel) loanListPanel.hidden = false;
  };

  const selectTab = name => {
    document.querySelectorAll('[data-account-section]').forEach(section => { section.hidden = section.dataset.accountSection !== name; });
    document.querySelectorAll('[data-account-nav]').forEach(button => button.classList.toggle('active', button.dataset.accountNav === name));
    if (name !== 'loans') closeLoanDetail();
  };

  document.querySelectorAll('[data-account-nav]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.accountNav)));

  const renderApplications = applications => {
    if (!applications.length) {
      applicationList.innerHTML = `<div class="portal-empty"><strong>No applications yet</strong><p>Your applications will appear here after you submit them.</p><a class="btn btn-primary" href="apply.html">Start application</a></div>`;
      return;
    }
    applicationList.innerHTML = applications.map(item => {
      const timing = item.preferred_collection_date
        ? `Collection ${date(item.preferred_collection_date)}`
        : `${escape(item.loan_term_months)} month${Number(item.loan_term_months) === 1 ? '' : 's'}`;
      return `
        <article class="portal-row">
          <div><span class="portal-kicker">${escape(item.reference)}</span><strong>${amount(item.loan_amount)}</strong><small>${timing} · Applied ${date(item.created_at)}</small></div>
          <span class="status-badge status-${escape(item.status)}">${escape(statusLabel(item.status))}</span>
        </article>`;
    }).join('');
  };

  const renderLoans = rows => {
    if (!rows.length) {
      loanList.innerHTML = `<div class="portal-empty"><strong>No loans yet</strong><p>Approved loans will appear here with balances, payments, transactions and documents.</p></div>`;
      return;
    }
    loanList.innerHTML = rows.map(item => `
      <article class="portal-row loan-row">
        <div><span class="portal-kicker">${escape(item.account_number || 'Loan account')}</span><strong>${amount(item.outstanding_balance)} outstanding</strong><small>Started ${date(item.start_date)} · Due ${date(item.due_date)}</small></div>
        <div class="portal-row-actions"><span class="status-badge status-${escape(item.status)}">${escape(statusLabel(item.status))}</span><button type="button" class="text-button" data-view-loan="${escape(item.id)}">View loan</button></div>
      </article>`).join('');
  };

  async function loadLoan(id) {
    const selected = loans.find(item => item.id === id);
    if (!selected) return;
    if (loanListPanel) loanListPanel.hidden = true;
    loanDetail.hidden = false;
    loanDetailContent.innerHTML = `<div class="portal-loading">Loading loan details…</div>`;

    const [{ data: transactions, error: txError }, { data: documents, error: docError }] = await Promise.all([
      client.from('loan_transactions').select('id,transaction_date,description,amount,transaction_type').eq('user_id', user.id).eq('loan_id', id).order('transaction_date', { ascending: false }),
      client.from('loan_documents').select('id,title,document_type,storage_path,storage_bucket,created_at').eq('user_id', user.id).eq('loan_id', id).order('created_at', { ascending: false })
    ]);

    const tx = txError ? [] : (transactions || []);
    const docs = docError ? [] : (documents || []);
    loanDetailContent.innerHTML = `
      <div class="loan-detail-head">
        <div><span class="eyebrow">${escape(selected.account_number || 'Loan')}</span><h2>${amount(selected.outstanding_balance)}</h2><p>Outstanding balance</p></div>
        <span class="status-badge status-${escape(selected.status)}">${escape(statusLabel(selected.status))}</span>
      </div>
      <div class="loan-stat-grid">
        <div><span>Original amount</span><strong>${amount(selected.principal_amount)}</strong></div>
        <div><span>Term</span><strong>${escape(selected.term_months)} months</strong></div>
        <div><span>Next payment</span><strong>${selected.next_payment_amount == null ? '—' : amount(selected.next_payment_amount)}</strong><small>${date(selected.next_payment_date)}</small></div>
        <div><span>Due date</span><strong>${date(selected.due_date)}</strong></div>
      </div>
      ${['active','overdue'].includes(selected.status) && Number(selected.outstanding_balance) > 0 ? `<section class="loan-payment-actions" aria-label="Loan payment options"><button class="btn btn-primary" type="button" data-pay-loan="${escape(selected.id)}">Pay next instalment</button><button class="btn btn-outline" type="button" data-settle-loan="${escape(selected.id)}">Settle loan early</button><p>Secure Paystack checkout. Your balance updates only after Paystack confirms the payment.</p></section>` : ''}
      <section class="portal-subsection"><h3>Transactions</h3>${tx.length ? `<div class="transaction-list">${tx.map(row => `<div class="transaction-row"><div><strong>${escape(row.description)}</strong><small>${date(row.transaction_date)} · ${escape(statusLabel(row.transaction_type))}</small></div><strong>${amount(row.amount)}</strong></div>`).join('')}</div>` : '<p class="muted">No transactions yet.</p>'}</section>
      <section class="portal-subsection"><h3>Documents</h3>${docs.length ? `<div class="document-list">${docs.map(doc => `<button class="document-row" type="button" data-download-document data-bucket="${escape(doc.storage_bucket || 'loan-documents')}" data-path="${escape(doc.storage_path)}"><span><strong>${escape(doc.title)}</strong><small>${escape(statusLabel(doc.document_type))} · ${date(doc.created_at)}</small></span><b>Download</b></button>`).join('')}</div>` : '<p class="muted">No loan documents yet.</p>'}</section>`;
  }

  loanList?.addEventListener('click', event => {
    const button = event.target.closest('[data-view-loan]');
    if (button) loadLoan(button.dataset.viewLoan);
  });

  loanDetailContent?.addEventListener('click', async event => {
    const button = event.target.closest('[data-download-document]');
    if (!button) return;
    button.disabled = true;
    const { data, error } = await client.storage.from(button.dataset.bucket).createSignedUrl(button.dataset.path, 60);
    button.disabled = false;
    if (error || !data?.signedUrl) return alert('This document could not be opened right now.');
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  });

  document.querySelector('[data-close-loan]')?.addEventListener('click', closeLoanDetail);

  profileForm?.addEventListener('submit', async event => {
    event.preventDefault();
    syncProfileBank();syncProfileAccountHolder();
    const payload = profileSchema.profileFromFormData(new FormData(profileForm));
    const errors = profileSchema.validateProfile(payload);
    if (errors.length) { profileMessage.textContent = errors[0]; return; }
    profileMessage.textContent = 'Saving…';
    const { error } = await client.from('customer_profiles').upsert({id:user.id,...payload,updated_at:new Date().toISOString()});
    profileMessage.textContent = error ? (error.message || 'We could not save your details.') : 'Details saved.';
    if (!error && greeting) greeting.textContent = payload.first_name || 'there';
  });

  document.querySelectorAll('[data-sign-out]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    await client.auth.signOut();
    window.location.href = 'index.html';
  }));

  (async () => {
    user = await auth.requireUser('account.html');
    if (!user) return;

    const [{ data: profile }, { data: applications, error: appError }, { data: loanRows, error: loanError }] = await Promise.all([
      client.from('customer_profiles').select('*').eq('id', user.id).maybeSingle(),
      client.from('loan_applications').select('id,reference,created_at,status,loan_amount,loan_term_months,preferred_collection_date').eq('user_id', user.id).order('created_at', { ascending: false }),
      client.from('loans').select('id,account_number,principal_amount,outstanding_balance,term_months,status,start_date,due_date,next_payment_date,next_payment_amount,created_at').eq('user_id', user.id).order('created_at', { ascending: false })
    ]);

    const firstName = profile?.first_name || user.user_metadata?.first_name || '';
    greeting.textContent = firstName || 'there';

    if (profileForm) {
      const authEmail = validEmail(user.email) ? user.email : '';
      const profileEmail = validEmail(profile?.email) ? profile.email : '';
      const defaults={...profile,first_name:profile?.first_name||user.user_metadata?.first_name||'',last_name:profile?.last_name||user.user_metadata?.last_name||'',email:profileEmail||authEmail};
      for(const element of profileForm.elements){if(!element.name)continue;let value=defaults[element.name];if(element.name==='employment_start_month')value=String(value||'').slice(0,7);if(value===null||value===undefined)value=['dependants','housing_expense','food_expense','transport_expense','utilities_expense','insurance_expense','dependant_expense','debt_expense','other_expense'].includes(element.name)?0:'';element.value=value;}
      profileForm.elements.email.readOnly=Boolean(authEmail);
      if(profileForm.elements.employment_start_month)profileForm.elements.employment_start_month.max=new Date().toISOString().slice(0,7);
      syncProfileBank();syncProfileAccountHolder();
      if (profileEmailField) profileEmailField.hidden = false;
    }

    const apps = appError ? [] : (applications || []);
    loans = loanError ? [] : (loanRows || []);
    renderApplications(apps);
    window.__kredrunAccountApplications = apps;
    window.dispatchEvent(new CustomEvent('kredrun:account-applications', { detail: { applications: apps } }));
    renderLoans(loans);

    const activeLoans = loans.filter(item => ['active', 'overdue'].includes(item.status));
    overviewApplications.textContent = String(apps.length);
    overviewLoans.textContent = String(activeLoans.length);
    const upcoming = activeLoans.filter(item => item.next_payment_date).sort((a, b) => String(a.next_payment_date).localeCompare(String(b.next_payment_date)))[0];
    overviewPayment.innerHTML = upcoming ? `${amount(upcoming.next_payment_amount)}<small>${date(upcoming.next_payment_date)}</small>` : `—<small>No payment scheduled</small>`;
  })();
})();
