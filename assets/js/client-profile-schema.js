(() => {
  'use strict';

  const escape = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));

  const optionSets = Object.freeze({
    provinces: ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'],
    maritalStatuses: ['Single', 'Married', 'Living with partner', 'Divorced', 'Widowed'],
    employmentStatuses: ['Employed full-time', 'Employed part-time', 'Self-employed', 'Pension', 'Contract / temporary', 'Other regular income'],
    payFrequencies: ['Monthly', 'Twice a month', 'Every two weeks', 'Weekly'],
    accountTypes: ['Cheque / Current', 'Savings', 'Transmission'],
    banks: [
      { value: 'ABSA Bank', branchCode: '632005' },
      { value: 'Capitec Bank', branchCode: '470010' },
      { value: 'First National Bank', branchCode: '250655' },
      { value: 'Nedbank', branchCode: '198765' },
      { value: 'Standard Bank', branchCode: '051001' },
      { value: 'Access Bank', branchCode: '410105' },
      { value: 'African Bank Limited', branchCode: '430000' },
      { value: 'African Bank Incorp', branchCode: '431010' },
      { value: 'Bidvest Bank', branchCode: '462005' },
      { value: 'Discovery Bank', branchCode: '679000' },
      { value: 'Finbond Bank', branchCode: '589000' },
      { value: 'OM Bank Limited', branchCode: '352000' },
      { value: 'TymeBank', branchCode: '678910' }
    ]
  });

  const fieldLabels = Object.freeze({
    first_name: 'First name', last_name: 'Surname', id_number: 'ID number', mobile: 'Mobile number', email: 'Email',
    marital_status: 'Marital status', dependants: 'Dependants', province: 'Province', residential_address: 'Residential address',
    employment_status: 'Income source', income_source_name: 'Employer / income source', job_title: 'Job title / occupation',
    employment_start_month: 'Employment start month', net_monthly_income: 'Net monthly income', pay_frequency: 'Pay frequency',
    pay_day: 'Pay day', housing_expense: 'Rent / bond', food_expense: 'Groceries & household', transport_expense: 'Transport',
    utilities_expense: 'Utilities & communication', insurance_expense: 'Insurance / medical', dependant_expense: 'School / childcare / dependants',
    debt_expense: 'Existing loans / credit repayments', other_expense: 'Other regular expenses', bank_name: 'Bank',
    bank_account_type: 'Account type', bank_account_holder: 'Account holder', bank_account_number: 'Account number', branch_code: 'Branch code'
  });

  const requiredProfileKeys = Object.freeze([
    'first_name', 'last_name', 'id_number', 'mobile', 'marital_status', 'dependants', 'province', 'residential_address',
    'employment_status', 'income_source_name', 'job_title', 'employment_start_month', 'net_monthly_income', 'pay_frequency',
    'housing_expense', 'food_expense', 'transport_expense', 'utilities_expense', 'insurance_expense', 'dependant_expense',
    'debt_expense', 'other_expense', 'bank_name', 'bank_account_type', 'bank_account_holder', 'bank_account_number', 'branch_code'
  ]);

  const numericKeys = new Set([
    'dependants', 'net_monthly_income', 'pay_day', 'housing_expense', 'food_expense', 'transport_expense',
    'utilities_expense', 'insurance_expense', 'dependant_expense', 'debt_expense', 'other_expense'
  ]);

  const bankBranchCode = bankName => optionSets.banks.find(bank => bank.value === bankName)?.branchCode || '';
  const optionValue = option => typeof option === 'string' ? option : option.value;
  const optionLabel = option => typeof option === 'string' ? option : (option.label || option.value);

  function optionHtml(setName, selected = '', placeholder = 'Select') {
    const options = optionSets[setName] || [];
    return [`<option value="">${escape(placeholder)}</option>`, ...options.map(option => {
      const value = optionValue(option);
      const branch = typeof option === 'object' && option.branchCode ? ` data-branch-code="${escape(option.branchCode)}"` : '';
      return `<option value="${escape(value)}"${branch}${value === selected ? ' selected' : ''}>${escape(optionLabel(option))}</option>`;
    })].join('');
  }

  function populateSelect(select, setName, placeholder) {
    if (!select) return;
    const selected = select.value;
    select.innerHTML = optionHtml(setName, selected, placeholder || select.dataset.placeholder || 'Select');
  }

  function populateAll(root = document) {
    root.querySelectorAll('[data-profile-options]').forEach(select => populateSelect(select, select.dataset.profileOptions));
  }

  function validSaId(value) {
    const id = String(value || '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(id)) return false;
    let oddSum = 0;
    for (let index = 0; index < 12; index += 2) oddSum += Number(id[index]);
    const evenDigits = id.slice(1, 12).split('').filter((_, index) => index % 2 === 0).join('');
    const evenSum = [...String(Number(evenDigits) * 2)].reduce((sum, digit) => sum + Number(digit), 0);
    return ((10 - ((oddSum + evenSum) % 10)) % 10) === Number(id[12]);
  }

  const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  const validMobile = value => /^(?:\+27|27|0)\d{9}$/.test(String(value || '').replace(/[\s()-]/g, ''));
  const normalizeMobile = value => {
    const raw = String(value || '').replace(/[\s()-]/g, '');
    if (/^0\d{9}$/.test(raw)) return `+27${raw.slice(1)}`;
    if (/^27\d{9}$/.test(raw)) return `+${raw}`;
    return raw;
  };
  const cleanText = value => String(value ?? '').trim().replace(/\s+/g, ' ');

  function profileFromFormData(formData) {
    const payload = {};
    for (const key of Object.keys(fieldLabels)) {
      if (!formData.has(key)) continue;
      const raw = formData.get(key);
      payload[key] = numericKeys.has(key) ? (raw === '' ? null : Number(raw)) : cleanText(raw);
    }
    if (payload.id_number !== undefined) payload.id_number = String(payload.id_number).replace(/\D/g, '');
    if (payload.mobile !== undefined) payload.mobile = normalizeMobile(payload.mobile);
    if (payload.email !== undefined) payload.email = String(payload.email).trim().toLowerCase();
    if (/^\d{4}-\d{2}$/.test(payload.employment_start_month || '')) payload.employment_start_month += '-01';
    if (payload.bank_name !== undefined) payload.branch_code = bankBranchCode(payload.bank_name);
    return payload;
  }

  function validateProfile(payload, options = {}) {
    const errors = [];
    const required = options.requiredKeys || requiredProfileKeys;
    required.forEach(key => {
      const value = payload[key];
      if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) errors.push(`${fieldLabels[key] || key} is required.`);
    });
    if (payload.id_number && !validSaId(payload.id_number)) errors.push('Enter a valid South African ID number.');
    if (payload.mobile && !validMobile(payload.mobile)) errors.push('Enter a valid South African mobile number.');
    if (payload.email && !validEmail(payload.email)) errors.push('Enter a valid email address.');
    if (payload.dependants !== undefined && (!Number.isInteger(payload.dependants) || payload.dependants < 0 || payload.dependants > 20)) errors.push('Dependants must be between 0 and 20.');
    if (payload.pay_day !== null && payload.pay_day !== undefined && (!Number.isInteger(payload.pay_day) || payload.pay_day < 1 || payload.pay_day > 31)) errors.push('Pay day must be between 1 and 31.');
    for (const key of numericKeys) if (payload[key] !== null && payload[key] !== undefined && (!Number.isFinite(payload[key]) || payload[key] < 0)) errors.push(`${fieldLabels[key] || key} cannot be negative.`);
    if (payload.bank_name && !bankBranchCode(payload.bank_name)) errors.push('Select a bank from the list.');
    if (payload.bank_account_number && !/^\d{6,20}$/.test(String(payload.bank_account_number).replace(/\s/g, ''))) errors.push('Enter a valid bank account number.');
    return [...new Set(errors)];
  }

  window.KredRunClientProfile = Object.freeze({
    optionSets, fieldLabels, requiredProfileKeys, optionHtml, populateSelect, populateAll,
    bankBranchCode, profileFromFormData, validateProfile, validSaId, validEmail, validMobile,
    normalizeMobile, escape
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => populateAll());
  else populateAll();
})();
