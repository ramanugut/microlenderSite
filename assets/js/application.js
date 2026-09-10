(() => {
  const form = document.querySelector('#loanApplication');
  if (!form) return;

  const steps = [...form.querySelectorAll('[data-step]')];
  const navItems = [...document.querySelectorAll('[data-step-nav]')];
  const nextBtn = form.querySelector('[data-next]');
  const prevBtn = form.querySelector('[data-prev]');
  const submitBtn = form.querySelector('[data-submit]');
  const submitLabel = form.querySelector('[data-submit-label]');
  const submitRequirements = form.querySelector('[data-submit-requirements]');
  const authGate = form.querySelector('[data-auth-gate]');
  const progressText = document.querySelector('[data-progress-text]');
  const progressBar = document.querySelector('[data-progress-bar]');
  const alertBox = form.querySelector('[data-form-alert]');
  const reviewSummary = form.querySelector('#reviewSummary');
  const amountInput = form.querySelector('#loanAmount');
  const termInput = form.querySelector('#loanTerm');
  const amountText = form.querySelector('[data-app-amount]');
  const termText = form.querySelector('[data-app-term]');
  const incomeInput = form.querySelector('#monthlyIncome');
  const incomeSummary = form.querySelector('[data-income-summary]');
  const expenseSummary = form.querySelector('[data-expense-summary]');
  const remainingSummary = form.querySelector('[data-remaining-summary]');
  const ratioSummary = form.querySelector('[data-ratio-summary]');
  const employmentStartDate = form.querySelector('#employmentStartDate');
  const employmentStatus = form.querySelector('#employmentStatus');
  const employerName = form.querySelector('#employerName');
  const employerLabel = form.querySelector('[data-employer-label]');
  const jobTitle = form.querySelector('#jobTitle');
  const jobTitleWrap = form.querySelector('[data-job-title-wrap]');
  const jobTitleLabel = form.querySelector('[data-job-title-label]');
  const employmentDurationHint = form.querySelector('[data-employment-duration]');
  const payFrequency = form.querySelector('#payFrequency');
  const payDay = form.querySelector('#payDay');
  const payDayWrap = form.querySelector('[data-pay-day-wrap]');
  const nextPayDate = form.querySelector('#nextPayDate');
  const nextPayDateWrap = form.querySelector('[data-next-pay-wrap]');
  const hasDependants = form.querySelector('#hasDependants');
  const dependants = form.querySelector('#dependants');
  const dependantsWrap = form.querySelector('[data-dependants-count]');
  const idNumber = form.querySelector('#idNumber');
  const idDerived = form.querySelector('[data-id-derived]');
  const bankSelect = form.querySelector('#bankName');
  const branchCode = form.querySelector('#branchCode');
  const accountHolder = form.querySelector('#accountHolder');
  const previousExpensesNote = form.querySelector('[data-previous-expenses]');
  const profileNotes = [...form.querySelectorAll('[data-profile-prefill]')];

  const DRAFT_KEY = 'kredrun-application-draft-v2';
  const PLAN_KEY = 'kredrun-loan-plan';
  const sensitiveFields = new Set(['idNumber','accountNumber','branchCode','accuracyConsent','processingConsent','applicationConsent','marketingConsent','website']);
  const expenseNames = ['housingExpense','foodExpense','transportExpense','utilitiesExpense','insuranceExpense','dependantExpense','debtExpense','otherExpense'];
  const allowedFileTypes = new Set(['application/pdf','image/jpeg','image/png']);
  const documentInputs = { id_document: 'idDocument', proof_of_income: 'incomeDocument', bank_statement: 'bankStatement' };
  const documentTitles = { id_document: 'Identity document', proof_of_income: 'Proof of income', bank_statement: 'Bank statement' };
  const currency = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
  const monthFormatter = new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric' });
  const dateFormatter = new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  const supabaseClient = window.kredrunSupabase;
  const auth = window.KredRunAuth;

  let currentStep = 1;
  let currentUser = null;
  let profileLoaded = false;
  let latestApplication = null;
  let idInfo = null;
  const reusableDocs = { id_document: null, proof_of_income: null, bank_statement: null };

  const money = value => currency.format(Number(value || 0)).replace('ZAR', 'R').trim();
  const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const value = name => form.elements[name]?.value || '';
  const number = name => Number(value(name) || 0);

  if (employmentStartDate) {
    const now = new Date();
    employmentStartDate.max = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function showAlert(message, type = 'error') {
    if (!message) {
      alertBox.textContent = '';
      alertBox.className = 'form-alert';
      return;
    }
    alertBox.textContent = message;
    alertBox.className = `form-alert show ${type}`;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function syncBankBranchCode() {
    const option = bankSelect?.selectedOptions?.[0];
    if (branchCode) branchCode.value = option?.dataset?.branchCode || '';
  }

  function fullName() {
    return [value('firstName').trim(), value('lastName').trim()].filter(Boolean).join(' ');
  }

  function syncAccountHolder(force = false) {
    if (!accountHolder) return;
    const name = fullName();
    if (name && (force || !accountHolder.value.trim())) accountHolder.value = name;
  }

  function luhnValidSouthAfricanId(id) {
    if (!/^\d{13}$/.test(id)) return false;
    let oddSum = 0;
    for (let i = 0; i < 12; i += 2) oddSum += Number(id[i]);
    const evenNumber = id.slice(1, 12).split('').filter((_, i) => i % 2 === 0).join('');
    const doubled = String(Number(evenNumber || 0) * 2);
    const evenSum = [...doubled].reduce((sum, d) => sum + Number(d), 0);
    const check = (10 - ((oddSum + evenSum) % 10)) % 10;
    return check === Number(id[12]);
  }

  function parseSouthAfricanId(id) {
    const clean = String(id || '').trim();
    if (!/^\d{13}$/.test(clean) || !luhnValidSouthAfricanId(clean)) return null;
    const yy = Number(clean.slice(0, 2));
    const mm = Number(clean.slice(2, 4));
    const dd = Number(clean.slice(4, 6));
    const now = new Date();
    let year = yy <= (now.getFullYear() % 100) ? 2000 + yy : 1900 + yy;
    let dob = new Date(year, mm - 1, dd);
    if (dob > now) {
      year -= 100;
      dob = new Date(year, mm - 1, dd);
    }
    if (dob.getFullYear() !== year || dob.getMonth() !== mm - 1 || dob.getDate() !== dd) return null;
    let age = now.getFullYear() - year;
    const birthdayPassed = now.getMonth() > dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
    if (!birthdayPassed) age -= 1;
    if (age < 18 || age > 110) return null;
    return { dob, age, iso: `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` };
  }

  function updateIdDerived() {
    if (!idNumber || !idDerived) return;
    idInfo = parseSouthAfricanId(idNumber.value);
    if (!idNumber.value.trim()) {
      idDerived.hidden = true;
      idDerived.textContent = '';
      return;
    }
    if (!idInfo) {
      idDerived.hidden = true;
      idDerived.textContent = '';
      return;
    }
    idDerived.hidden = false;
    idDerived.textContent = `Date of birth ${dateFormatter.format(idInfo.dob)} · Age ${idInfo.age}. Filled automatically from your SA ID.`;
  }

  function updateDependantsUI() {
    const yes = hasDependants?.value === 'yes';
    if (dependantsWrap) dependantsWrap.hidden = !yes;
    if (dependants) {
      dependants.disabled = !yes;
      dependants.required = yes;
      if (!yes) dependants.value = '0';
      else if (Number(dependants.value) < 1) dependants.value = '1';
    }
  }

  function updateEmploymentUI() {
    const status = employmentStatus?.value || '';
    const pension = status === 'Pension';
    const self = status === 'Self-employed';
    const other = status === 'Other regular income';

    if (employerLabel) employerLabel.textContent = pension ? 'Pension / income provider' : self ? 'Business / income source name' : other ? 'Income source name' : 'Employer / income source name';
    if (jobTitleLabel) jobTitleLabel.textContent = self ? 'Type of work / business activity' : 'Job title / occupation';

    const hideJob = pension || other;
    if (jobTitleWrap) jobTitleWrap.hidden = hideJob;
    if (jobTitle) {
      jobTitle.disabled = hideJob;
      jobTitle.required = !hideJob;
      if (hideJob) jobTitle.value = 'Not applicable';
      else if (jobTitle.value === 'Not applicable') jobTitle.value = '';
    }
  }

  function monthDiff(start, end = new Date()) {
    if (!start) return null;
    const [y, m] = String(start).split('-').map(Number);
    if (!y || !m) return null;
    return Math.max(0, (end.getFullYear() - y) * 12 + (end.getMonth() + 1 - m));
  }

  function updateEmploymentDuration() {
    if (!employmentDurationHint) return;
    const months = monthDiff(employmentStartDate?.value);
    if (months === null) {
      employmentDurationHint.textContent = '';
      return;
    }
    const years = Math.floor(months / 12);
    const remaining = months % 12;
    const parts = [];
    if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
    if (remaining || !years) parts.push(`${remaining} month${remaining === 1 ? '' : 's'}`);
    employmentDurationHint.textContent = `That is about ${parts.join(' ')} at this income source.`;
  }

  function lastDayOfMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  function deriveMonthlyNextPayDate() {
    if (payFrequency?.value !== 'Monthly' || !payDay?.value) return;
    const day = Math.max(1, Math.min(31, Number(payDay.value)));
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth();
    let targetDay = Math.min(day, lastDayOfMonth(year, month));
    let target = new Date(year, month, targetDay);
    target.setHours(23, 59, 59, 999);
    if (target < now) {
      month += 1;
      if (month > 11) { month = 0; year += 1; }
      targetDay = Math.min(day, lastDayOfMonth(year, month));
      target = new Date(year, month, targetDay);
    }
    nextPayDate.value = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  }

  function updatePayUI() {
    const monthly = payFrequency?.value === 'Monthly';
    if (payDayWrap) payDayWrap.hidden = !monthly;
    if (nextPayDateWrap) nextPayDateWrap.hidden = monthly;
    if (payDay) {
      payDay.disabled = !monthly;
      payDay.required = monthly;
      if (!monthly) payDay.value = '';
    }
    if (nextPayDate) {
      nextPayDate.readOnly = monthly;
      nextPayDate.required = true;
      if (monthly) deriveMonthlyNextPayDate();
    }
  }

  function updateAffordability() {
    const income = Number(incomeInput?.value || 0);
    const expenses = expenseNames.reduce((sum, name) => sum + Number(form.elements[name]?.value || 0), 0);
    const remaining = income - expenses;
    const ratio = income > 0 ? expenses / income : 0;
    if (incomeSummary) incomeSummary.textContent = money(income);
    if (expenseSummary) expenseSummary.textContent = money(expenses);
    if (remainingSummary) {
      remainingSummary.textContent = money(remaining);
      remainingSummary.style.color = remaining < 0 ? '#c83c47' : '';
    }
    if (ratioSummary) ratioSummary.textContent = income > 0 ? `${Math.round(ratio * 100)}%` : '—';
  }

  function isDocumentReusable(type, doc, approvedApplicationIds) {
    if (!doc) return false;
    const trusted = doc.verification_status === 'verified' || approvedApplicationIds.has(doc.source_application_id);
    if (!trusted) return false;
    if (type === 'id_document') return true;
    const freshnessSource = doc.coverage_end || doc.uploaded_at || doc.created_at;
    const freshnessDate = freshnessSource ? new Date(freshnessSource) : null;
    if (!freshnessDate || Number.isNaN(freshnessDate.getTime())) return false;
    const ageDays = (Date.now() - freshnessDate.getTime()) / 86400000;
    return ageDays >= -1 && ageDays <= 31;
  }

  function setReusableDocument(type, doc) {
    const inputName = documentInputs[type];
    const input = form.elements[inputName];
    const block = form.querySelector(`[data-document-block="${type}"]`);
    const reusePanel = block?.querySelector('[data-reuse-panel]');
    const reuseText = block?.querySelector('[data-reuse-text]');
    const uploadCard = block?.querySelector('.upload-card');
    reusableDocs[type] = doc || null;

    if (doc) {
      input.required = false;
      input.disabled = true;
      if (reusePanel) reusePanel.hidden = false;
      if (uploadCard) uploadCard.hidden = true;
      const when = doc.verified_at || doc.uploaded_at || doc.created_at;
      if (reuseText) reuseText.textContent = type === 'id_document'
        ? `Verified document on file${when ? ` · ${dateFormatter.format(new Date(when))}` : ''}. You do not need to upload it again.`
        : `A recently verified document is on file${when ? ` · ${dateFormatter.format(new Date(when))}` : ''}. It is still current enough for this application.`;
    } else {
      input.disabled = false;
      input.required = true;
      if (reusePanel) reusePanel.hidden = true;
      if (uploadCard) uploadCard.hidden = false;
    }
  }

  function stopReusingDocument(type) {
    setReusableDocument(type, null);
    const input = form.elements[documentInputs[type]];
    input?.focus();
    updateSubmitVisibility();
  }

  function documentComplete(type) {
    if (reusableDocs[type]) return true;
    const input = form.elements[documentInputs[type]];
    const file = input?.files?.[0];
    return Boolean(file) && allowedFileTypes.has(file.type) && file.size <= 6 * 1024 * 1024;
  }

  function fieldIsComplete(field) {
    if (!field || field.disabled || field.type === 'hidden' || !field.required) return true;
    if (field.type === 'file') return documentComplete(Object.keys(documentInputs).find(key => documentInputs[key] === field.name));
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked;
    if (!field.checkValidity()) return false;
    if (field.name === 'idNumber') return Boolean(parseSouthAfricanId(field.value));
    if (field.name === 'mobile') {
      const digits = field.value.replace(/\D/g, '');
      return digits.length >= 9 && digits.length <= 12;
    }
    return String(field.value ?? '').trim() !== '';
  }

  function applicationIsComplete() {
    if (String(form.elements.website?.value || '').trim()) return false;
    syncBankBranchCode();
    if (!branchCode?.value) return false;
    if (!Object.keys(documentInputs).every(documentComplete)) return false;
    return [...form.querySelectorAll('[required]')].every(fieldIsComplete);
  }

  function updateSubmitVisibility() {
    const onReview = currentStep === steps.length;
    const complete = onReview && Boolean(currentUser) && applicationIsComplete();
    submitBtn.hidden = !complete;
    if (submitRequirements) submitRequirements.hidden = !onReview || complete;
  }

  function fillIfBlank(name, val) {
    const field = form.elements[name];
    if (!field || val === null || val === undefined || val === '') return false;
    if (String(field.value || '').trim()) return false;
    field.value = String(val);
    return true;
  }

  function loadPreviousExpenses(source) {
    if (!source) return false;
    let loaded = false;
    const map = {
      housingExpense: 'housing_expense', foodExpense: 'food_expense', transportExpense: 'transport_expense', utilitiesExpense: 'utilities_expense',
      insuranceExpense: 'insurance_expense', dependantExpense: 'dependant_expense', debtExpense: 'debt_expense', otherExpense: 'other_expense'
    };
    Object.entries(map).forEach(([field, column]) => {
      if (source[column] !== null && source[column] !== undefined) loaded = fillIfBlank(field, source[column]) || loaded;
    });
    if (loaded && previousExpensesNote) previousExpensesNote.hidden = false;
    return loaded;
  }

  function prefillFromSource(source) {
    if (!source) return false;
    const mapping = {
      firstName: 'first_name', lastName: 'last_name', idNumber: 'id_number', mobile: 'mobile', maritalStatus: 'marital_status',
      province: 'province', address: 'residential_address', employmentStatus: 'employment_status', employerName: 'income_source_name',
      jobTitle: 'job_title', monthlyIncome: 'net_monthly_income', payFrequency: 'pay_frequency', bankName: 'bank_name', accountType: 'bank_account_type',
      accountHolder: 'bank_account_holder', accountNumber: 'bank_account_number'
    };
    let used = false;
    Object.entries(mapping).forEach(([field, column]) => { used = fillIfBlank(field, source[column]) || used; });
    if (source.employment_start_month) used = fillIfBlank('employmentStartDate', String(source.employment_start_month).slice(0, 7)) || used;
    if (source.pay_day) used = fillIfBlank('payDay', source.pay_day) || used;
    if (source.next_pay_date && source.pay_frequency !== 'Monthly') used = fillIfBlank('nextPayDate', String(source.next_pay_date).slice(0, 10)) || used;
    if (source.dependants !== null && source.dependants !== undefined && !hasDependants.value) {
      hasDependants.value = Number(source.dependants) > 0 ? 'yes' : 'no';
      if (Number(source.dependants) > 0) dependants.value = String(source.dependants);
      used = true;
    }
    loadPreviousExpenses(source);
    return used;
  }

  async function loadReusableDocuments() {
    if (!currentUser || !supabaseClient) return;
    const [{ data: docs }, { data: loans }] = await Promise.all([
      supabaseClient.from('customer_documents').select('*').eq('user_id', currentUser.id).order('uploaded_at', { ascending: false }),
      supabaseClient.from('loans').select('application_id,status').eq('user_id', currentUser.id)
    ]);
    const approvedStatuses = new Set(['approved','active','disbursed','settled','paid','paid_up','closed']);
    const approvedApplicationIds = new Set((loans || []).filter(loan => approvedStatuses.has(String(loan.status || '').toLowerCase())).map(loan => loan.application_id).filter(Boolean));

    for (const type of Object.keys(documentInputs)) {
      const candidate = (docs || []).find(doc => doc.document_type === type && isDocumentReusable(type, doc, approvedApplicationIds));
      setReusableDocument(type, candidate || null);
    }
  }

  async function refreshCurrentUser(loadProfile = true) {
    if (!supabaseClient || !auth) return null;
    currentUser = await auth.getUser();
    if (!currentUser) {
      if (authGate) authGate.hidden = false;
      updateSubmitVisibility();
      return null;
    }

    if (authGate) authGate.hidden = true;
    const emailField = form.elements.email;
    if (emailField) {
      emailField.value = currentUser.email || emailField.value;
      emailField.readOnly = Boolean(currentUser.email);
    }

    if (loadProfile && !profileLoaded) {
      profileLoaded = true;
      const [{ data: profile }, { data: applications }] = await Promise.all([
        supabaseClient.from('customer_profiles').select('*').eq('id', currentUser.id).maybeSingle(),
        supabaseClient.from('loan_applications').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(1)
      ]);
      latestApplication = applications?.[0] || null;
      let used = false;
      used = prefillFromSource(latestApplication) || used;
      used = prefillFromSource(profile) || used;
      used = fillIfBlank('firstName', currentUser.user_metadata?.first_name || '') || used;
      used = fillIfBlank('lastName', currentUser.user_metadata?.last_name || '') || used;
      if (used) profileNotes.forEach(note => { note.hidden = false; });
      await loadReusableDocuments();
      updateDependantsUI();
      updateEmploymentUI();
      updateEmploymentDuration();
      updatePayUI();
      syncBankBranchCode();
      syncAccountHolder();
      updateIdDerived();
      updateAffordability();
    }
    updateSubmitVisibility();
    return currentUser;
  }

  function setStep(step) {
    currentStep = Math.min(steps.length, Math.max(1, Number(step)));
    steps.forEach(section => section.classList.toggle('active', Number(section.dataset.step) === currentStep));
    navItems.forEach(item => {
      const number = Number(item.dataset.stepNav);
      item.classList.toggle('active', number === currentStep);
      item.classList.toggle('done', number < currentStep);
    });
    progressText.textContent = `Step ${currentStep} of ${steps.length}`;
    progressBar.style.width = `${(currentStep / steps.length) * 100}%`;
    prevBtn.disabled = currentStep === 1;
    nextBtn.hidden = currentStep === steps.length;
    submitBtn.hidden = true;
    showAlert('');
    if (currentStep === 4) updateAffordability();
    if (currentStep === 5) syncAccountHolder(true);
    if (currentStep === 6) buildReview();
    updateSubmitVisibility();
    window.scrollTo({ top: Math.max(0, document.querySelector('.application-main').offsetTop - 85), behavior: 'smooth' });
  }

  function updateLoan() {
    const amount = Number(amountInput.value);
    const term = Number(termInput.value);
    amountText.textContent = money(amount);
    termText.textContent = `${term} month${term === 1 ? '' : 's'}`;
    try { localStorage.setItem(PLAN_KEY, JSON.stringify({ amount, term })); } catch (_) {}
  }

  function validateField(field) {
    if (!field || field.disabled || field.type === 'hidden') return true;
    const wrapper = field.closest('.field');
    const error = wrapper?.querySelector('.field-error');
    let message = '';

    if (field.type === 'file') {
      const type = Object.keys(documentInputs).find(key => documentInputs[key] === field.name);
      if (reusableDocs[type]) return true;
      const file = field.files?.[0];
      if (field.required && !file) message = 'Please upload this document.';
      if (file) {
        if (!allowedFileTypes.has(file.type)) message = 'Use a PDF, JPG or PNG file.';
        if (file.size > 6 * 1024 * 1024) message = 'This file is larger than 6 MB.';
      }
    } else if (!field.checkValidity()) {
      if (field.validity.valueMissing) message = field.type === 'checkbox' ? 'Please confirm this before submitting.' : 'This field is required.';
      else if (field.validity.typeMismatch) message = 'Please enter a valid value.';
      else if (field.validity.tooShort) message = 'This value is too short.';
      else if (field.validity.rangeUnderflow) message = 'Enter a valid value.';
      else if (field.validity.rangeOverflow) message = 'Enter a valid value.';
      else message = 'Please check this field.';
    }

    if (field.name === 'idNumber' && field.value && !parseSouthAfricanId(field.value)) message = 'Enter a valid South African ID number for an applicant aged 18 or older.';
    if (field.name === 'email' && field.value && !/^\S+@\S+\.\S+$/.test(field.value.trim())) message = 'Enter a valid email address.';
    if (field.name === 'mobile' && field.value) {
      const digits = field.value.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 12) message = 'Enter a valid mobile number.';
    }

    if (wrapper) wrapper.classList.toggle('invalid', Boolean(message));
    if (error) error.textContent = message;
    if (field.type === 'file') field.closest('.upload-card')?.classList.toggle('invalid', Boolean(message));
    return !message;
  }

  function validateStep(stepNumber) {
    const section = form.querySelector(`[data-step="${stepNumber}"]`);
    const fields = [...section.querySelectorAll('input,select,textarea')].filter(el => el.name !== 'website' && !el.disabled);
    let valid = true;
    fields.forEach(field => { if (!validateField(field)) valid = false; });
    if (stepNumber === 5) {
      syncBankBranchCode();
      if (!branchCode.value) valid = false;
      Object.keys(documentInputs).forEach(type => { if (!documentComplete(type)) valid = false; });
    }
    if (!valid) {
      showAlert('Please check the highlighted information before continuing.');
      const firstInvalid = section.querySelector('.invalid input,.invalid select,.invalid textarea,input:invalid,select:invalid');
      firstInvalid?.focus({ preventScroll: true });
      firstInvalid?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return valid;
  }

  function documentReviewValue(type) {
    if (reusableDocs[type]) return 'Verified document on file';
    const field = form.elements[documentInputs[type]];
    return field?.files?.[0]?.name || 'Not selected';
  }

  const reviewSections = [
    { title: 'Loan request', step: 1, fields: [['Amount', 'loanAmount', 'money'], ['Term', 'loanTerm', 'term']] },
    { title: 'Personal details', step: 2, fields: [['Name', ['firstName','lastName'], 'join'], ['ID number', 'idNumber', 'maskId'], ['Date of birth', 'idNumber', 'dob'], ['Mobile', 'mobile'], ['Email', 'email'], ['Province', 'province'], ['Address', 'address']] },
    { title: 'Work & income', step: 3, fields: [['Income source', 'employmentStatus'], ['Employer / source', 'employerName'], ['Occupation', 'jobTitle'], ['Started', 'employmentStartDate', 'month'], ['Net monthly income', 'monthlyIncome', 'money'], ['Pay frequency', 'payFrequency'], ['Next pay date', 'nextPayDate', 'date']] },
    { title: 'Affordability', step: 4, fields: [['Rent / bond', 'housingExpense', 'money'], ['Groceries', 'foodExpense', 'money'], ['Transport', 'transportExpense', 'money'], ['Utilities', 'utilitiesExpense', 'money'], ['Insurance / medical', 'insuranceExpense', 'money'], ['Existing credit', 'debtExpense', 'money'], ['Other', 'otherExpense', 'money']] },
    { title: 'Bank & documents', step: 5, fields: [['Bank', 'bankName'], ['Account type', 'accountType'], ['Account holder', 'accountHolder'], ['Account number', 'accountNumber', 'maskAccount'], ['ID document', 'id_document', 'document'], ['Proof of income', 'proof_of_income', 'document'], ['Bank statement', 'bank_statement', 'document']] }
  ];

  function valueFor(spec, format) {
    if (Array.isArray(spec)) return spec.map(name => form.elements[name]?.value || '').filter(Boolean).join(' ');
    const field = form.elements[spec];
    const val = field?.value || '';
    if (format === 'money') return money(val);
    if (format === 'term') return `${val} month${Number(val) === 1 ? '' : 's'}`;
    if (format === 'maskId') return val ? `•••••••••${val.slice(-4)}` : '';
    if (format === 'maskAccount') return val ? `••••${val.slice(-4)}` : '';
    if (format === 'month') {
      if (!val) return '';
      const date = new Date(`${val}-01T00:00:00`);
      return Number.isNaN(date.getTime()) ? val : monthFormatter.format(date);
    }
    if (format === 'date') return val ? dateFormatter.format(new Date(`${val}T00:00:00`)) : '';
    if (format === 'dob') return idInfo ? dateFormatter.format(idInfo.dob) : '';
    if (format === 'document') return documentReviewValue(spec);
    return val;
  }

  function buildReview() {
    updateIdDerived();
    reviewSummary.innerHTML = reviewSections.map(section => {
      const items = section.fields.filter(([, field]) => field !== 'jobTitle' || !jobTitle?.disabled).map(([label, field, format]) => `<div class="review-item"><span>${escapeHTML(label)}</span><strong>${escapeHTML(valueFor(field, format) || '—')}</strong></div>`).join('');
      return `<section class="review-section"><div class="review-section-head"><strong>${escapeHTML(section.title)}</strong><button type="button" data-go-step="${section.step}">Edit</button></div><div class="review-grid">${items}</div></section>`;
    }).join('');
  }

  function saveDraft() {
    const draft = {};
    [...form.elements].forEach(field => {
      if (!field.name || field.type === 'file' || sensitiveFields.has(field.name)) return;
      if (field.type === 'checkbox' || field.type === 'radio') draft[field.name] = field.checked ? field.value : '';
      else draft[field.name] = field.value;
    });
    draft._step = Math.min(currentStep, 5);
    draft._savedAt = Date.now();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
  }

  function restoreDraft() {
    let draft = null;
    let plan = null;
    try {
      draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      plan = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    } catch (_) {}
    if (plan?.amount) amountInput.value = String(plan.amount);
    if (plan?.term) termInput.value = String(plan.term);
    if (draft && Date.now() - Number(draft._savedAt || 0) < 7 * 24 * 60 * 60 * 1000) {
      Object.entries(draft).forEach(([name, val]) => {
        if (name.startsWith('_') || sensitiveFields.has(name)) return;
        const field = form.elements[name];
        if (!field || field.type === 'file') return;
        if (field.type === 'checkbox' || field.type === 'radio') field.checked = field.value === val;
        else field.value = val;
      });
      currentStep = Math.max(1, Math.min(5, Number(draft._step || 1)));
    }
    updateDependantsUI();
    updateEmploymentUI();
    updateEmploymentDuration();
    updatePayUI();
    syncBankBranchCode();
    syncAccountHolder();
    updateIdDerived();
    updateLoan();
    updateAffordability();
    setStep(currentStep);
  }

  function fileExtension(file) {
    const fromName = String(file.name || '').split('.').pop()?.toLowerCase();
    if (['pdf','jpg','jpeg','png'].includes(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName;
    if (file.type === 'application/pdf') return 'pdf';
    if (file.type === 'image/png') return 'png';
    return 'jpg';
  }

  async function uploadDocument(applicationId, documentType, file) {
    const slug = documentType.replaceAll('_', '-');
    const path = `${currentUser.id}/${applicationId}/${slug}.${fileExtension(file)}`;
    const { error } = await supabaseClient.storage.from('application-documents').upload(path, file, { upsert: false, contentType: file.type, cacheControl: '3600' });
    if (error) throw new Error(`We could not upload your ${documentTitles[documentType].toLowerCase()}. Please try again.`);
    return path;
  }

  function createReference(applicationId) {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `KR-${day}-${applicationId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  function affordabilityNumbers() {
    const income = number('monthlyIncome');
    const expenses = expenseNames.reduce((sum, name) => sum + number(name), 0);
    return { expenses, disposable: income - expenses, ratio: income > 0 ? expenses / income : 0 };
  }

  function applicationRecord(applicationId, reference, documentPaths) {
    const affordability = affordabilityNumbers();
    const parsedId = parseSouthAfricanId(value('idNumber'));
    return {
      id: applicationId,
      user_id: currentUser.id,
      reference,
      status: 'received',
      source: 'website',
      loan_amount: number('loanAmount'),
      loan_term_months: number('loanTerm'),
      first_name: value('firstName').trim(),
      last_name: value('lastName').trim(),
      id_number: value('idNumber').trim(),
      date_of_birth: parsedId?.iso || null,
      age_at_application: parsedId?.age || null,
      mobile: value('mobile').trim(),
      email: currentUser.email?.trim().toLowerCase() || value('email').trim().toLowerCase(),
      marital_status: value('maritalStatus'),
      dependants: number('dependants'),
      province: value('province'),
      residential_address: value('address').trim(),
      employment_status: value('employmentStatus'),
      income_source_name: value('employerName').trim(),
      job_title: jobTitle?.disabled ? 'Not applicable' : value('jobTitle').trim(),
      employment_start_month: `${value('employmentStartDate')}-01`,
      net_monthly_income: number('monthlyIncome'),
      pay_frequency: value('payFrequency'),
      pay_day: value('payDay') ? number('payDay') : null,
      next_pay_date: value('nextPayDate'),
      income_source_phone: null,
      housing_expense: number('housingExpense'),
      food_expense: number('foodExpense'),
      transport_expense: number('transportExpense'),
      utilities_expense: number('utilitiesExpense'),
      insurance_expense: number('insuranceExpense'),
      dependant_expense: number('dependantExpense'),
      debt_expense: number('debtExpense'),
      other_expense: number('otherExpense'),
      total_monthly_expenses: affordability.expenses,
      disposable_income: affordability.disposable,
      expense_to_income_ratio: affordability.ratio,
      bank_name: value('bankName'),
      bank_account_type: value('accountType'),
      bank_account_holder: value('accountHolder').trim(),
      bank_account_number: value('accountNumber').trim(),
      branch_code: value('branchCode').trim(),
      id_document_path: documentPaths.id_document,
      income_document_path: documentPaths.proof_of_income,
      bank_statement_path: documentPaths.bank_statement,
      accuracy_consent: Boolean(form.elements.accuracyConsent?.checked),
      processing_consent: Boolean(form.elements.processingConsent?.checked),
      application_consent: Boolean(form.elements.applicationConsent?.checked),
      marketing_consent: Boolean(form.elements.marketingConsent?.checked)
    };
  }

  function profileRecord() {
    return {
      id: currentUser.id,
      first_name: value('firstName').trim(),
      last_name: value('lastName').trim(),
      id_number: value('idNumber').trim(),
      mobile: value('mobile').trim(),
      marital_status: value('maritalStatus'),
      dependants: number('dependants'),
      province: value('province'),
      residential_address: value('address').trim(),
      employment_status: value('employmentStatus'),
      income_source_name: value('employerName').trim(),
      job_title: jobTitle?.disabled ? 'Not applicable' : value('jobTitle').trim(),
      employment_start_month: `${value('employmentStartDate')}-01`,
      net_monthly_income: number('monthlyIncome'),
      pay_frequency: value('payFrequency'),
      pay_day: value('payDay') ? number('payDay') : null,
      income_source_phone: null,
      housing_expense: number('housingExpense'),
      food_expense: number('foodExpense'),
      transport_expense: number('transportExpense'),
      utilities_expense: number('utilitiesExpense'),
      insurance_expense: number('insuranceExpense'),
      dependant_expense: number('dependantExpense'),
      debt_expense: number('debtExpense'),
      other_expense: number('otherExpense'),
      bank_name: value('bankName'),
      bank_account_type: value('accountType'),
      bank_account_holder: value('accountHolder').trim(),
      bank_account_number: value('accountNumber').trim(),
      branch_code: value('branchCode').trim(),
      last_application_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  async function resolveDocumentPaths(applicationId) {
    const paths = {};
    const newDocuments = [];
    for (const type of Object.keys(documentInputs)) {
      if (reusableDocs[type]) {
        paths[type] = reusableDocs[type].storage_path;
        continue;
      }
      const input = form.elements[documentInputs[type]];
      const file = input.files[0];
      const path = await uploadDocument(applicationId, type, file);
      paths[type] = path;
      newDocuments.push({
        user_id: currentUser.id,
        source_application_id: applicationId,
        document_type: type,
        title: documentTitles[type],
        storage_bucket: 'application-documents',
        storage_path: path,
        verification_status: 'pending'
      });
    }
    return { paths, newDocuments };
  }

  nextBtn.addEventListener('click', async () => {
    if (!validateStep(currentStep)) return;
    if (currentStep === 1 && !(await refreshCurrentUser(true))) {
      saveDraft();
      if (authGate) {
        authGate.hidden = false;
        authGate.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    saveDraft();
    setStep(currentStep + 1);
  });

  prevBtn.addEventListener('click', () => { saveDraft(); setStep(currentStep - 1); });

  reviewSummary.addEventListener('click', event => {
    const button = event.target.closest('[data-go-step]');
    if (button) setStep(Number(button.dataset.goStep));
  });

  form.addEventListener('click', event => {
    const button = event.target.closest('[data-upload-new]');
    if (button) stopReusingDocument(button.dataset.uploadNew);
  });

  [amountInput, termInput].forEach(input => input.addEventListener('input', () => { updateLoan(); saveDraft(); updateSubmitVisibility(); }));
  incomeInput?.addEventListener('input', updateAffordability);
  form.querySelectorAll('.affordability-fields input').forEach(input => input.addEventListener('input', updateAffordability));
  bankSelect?.addEventListener('change', () => { syncBankBranchCode(); updateSubmitVisibility(); });
  idNumber?.addEventListener('input', () => { updateIdDerived(); updateSubmitVisibility(); });
  hasDependants?.addEventListener('change', () => { updateDependantsUI(); updateSubmitVisibility(); });
  employmentStatus?.addEventListener('change', () => { updateEmploymentUI(); updateSubmitVisibility(); });
  employmentStartDate?.addEventListener('change', updateEmploymentDuration);
  payFrequency?.addEventListener('change', () => { updatePayUI(); updateSubmitVisibility(); });
  payDay?.addEventListener('input', () => { deriveMonthlyNextPayDate(); updateSubmitVisibility(); });
  form.elements.firstName?.addEventListener('input', () => syncAccountHolder(true));
  form.elements.lastName?.addEventListener('input', () => syncAccountHolder(true));

  form.addEventListener('input', event => {
    const field = event.target;
    if (field.matches('input,select,textarea') && field.type !== 'file') {
      if (field.closest('.field')?.classList.contains('invalid')) validateField(field);
      window.clearTimeout(form._draftTimer);
      form._draftTimer = window.setTimeout(saveDraft, 350);
      updateSubmitVisibility();
    }
  });
  form.addEventListener('change', updateSubmitVisibility);

  form.querySelectorAll('input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      const label = form.querySelector(`[data-file-name="${input.name}"]`);
      if (label) label.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Choose file';
      input.closest('.upload-card')?.classList.toggle('has-file', Boolean(file));
      validateField(input);
      updateSubmitVisibility();
    });
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const user = await refreshCurrentUser(false);
    if (!user) {
      showAlert('Your login session has ended. Sign in again before submitting.');
      submitBtn.hidden = true;
      return;
    }

    updatePayUI();
    updateIdDerived();
    for (let step = 1; step <= steps.length; step += 1) {
      if (!validateStep(step)) { setStep(step); return; }
    }
    if (!applicationIsComplete()) {
      updateSubmitVisibility();
      showAlert('Please complete every required field, document and confirmation before submitting.');
      return;
    }

    const { data: pendingApps } = await supabaseClient
      .from('loan_applications')
      .select('id,status')
      .eq('user_id', user.id)
      .in('status', ['received', 'under_review']);
    if ((pendingApps || []).length) {
      showAlert('You already have an application awaiting review. Please wait for a decision before submitting another one.');
      return;
    }

    showAlert('');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;
    submitLabel.textContent = 'Sending application';

    try {
      const applicationId = crypto.randomUUID();
      const reference = createReference(applicationId);
      const { paths, newDocuments } = await resolveDocumentPaths(applicationId);

      const { error } = await supabaseClient.from('loan_applications').insert(applicationRecord(applicationId, reference, paths));
      if (error) throw new Error('We could not save your application right now. Please try again.');

      if (newDocuments.length) {
        const { error: docError } = await supabaseClient.from('customer_documents').insert(newDocuments);
        if (docError) console.warn('Application saved, but document tracking could not be created.', docError);
      }

      const { error: profileError } = await supabaseClient.from('customer_profiles').upsert(profileRecord());
      if (profileError) console.warn('Application saved, but profile reuse data could not be refreshed.', profileError);

      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(PLAN_KEY); } catch (_) {}
      window.location.href = `application-received.html?ref=${encodeURIComponent(reference)}`;
    } catch (error) {
      showAlert(error.message || 'We could not send your application right now. Please try again.');
      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
      submitLabel.textContent = 'Submit application';
      updateSubmitVisibility();
    }
  });

  async function init() {
    restoreDraft();
    await refreshCurrentUser(true);
    updateDependantsUI();
    updateEmploymentUI();
    updateEmploymentDuration();
    updatePayUI();
    syncBankBranchCode();
    syncAccountHolder();
    updateIdDerived();
    updateAffordability();
    updateSubmitVisibility();
  }

  init();
})();
