(() => {
  'use strict';

  if (window.__kredrunCustomerUxLoaded) return;
  window.__kredrunCustomerUxLoaded = true;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function addStyles() {
    if ($('#kredrun-customer-ux-styles')) return;
    const style = document.createElement('style');
    style.id = 'kredrun-customer-ux-styles';
    style.textContent = `
      .profile-details-section.profile-card{border:1px solid #e1eaf2!important;border-radius:16px;padding:0!important;margin:0 0 12px!important;background:#fff;overflow:hidden}
      .profile-details-section.profile-card+.profile-details-section.profile-card{border-top:1px solid #e1eaf2!important;padding-top:0!important}
      .profile-section-title{width:100%;border:0;background:#fff;color:#183153;padding:17px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px;text-align:left;cursor:pointer;font:inherit}
      .profile-section-title:hover{background:#f8fbfd}
      .profile-section-title:focus-visible{outline:3px solid rgba(28,116,216,.25);outline-offset:-3px}
      .profile-section-title span{display:grid;gap:3px}
      .profile-section-title strong{font-size:.98rem}
      .profile-section-title small{font-size:.76rem;font-weight:600;color:#758397}
      .profile-section-title b{font-size:1.2rem;line-height:1;color:#718096;transition:transform .18s ease}
      .profile-section-title[aria-expanded="true"] b{transform:rotate(180deg)}
      .profile-section-body{padding:0 18px 18px}
      .profile-details-section.profile-card>h3{display:none}
      .portal-next-action{display:block;margin-top:5px;color:#52647a;font-size:.77rem;line-height:1.45;font-weight:600}
      .portal-next-action.is-urgent{color:#b6333d}
      .application-focus-bottom strong{line-height:1.45}
      .customer-optional-note{display:block;margin-top:5px;color:#748397;font-size:.75rem;line-height:1.4}
      @media(max-width:640px){
        .profile-section-title{padding:15px 14px}
        .profile-section-body{padding:0 14px 15px}
      }
      @media(prefers-reduced-motion:reduce){.profile-section-title b{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function makeEmailOptional(root) {
    const email = $('[name="email"]', root);
    if (!email) return;
    email.required = false;
    email.removeAttribute('aria-required');
    const label = root.querySelector(`label[for="${email.id}"]`);
    if (label) label.textContent = 'Email address (optional)';
    const field = email.closest('.field,.auth-field');
    const hint = field?.querySelector('.field-hint,.customer-optional-note');
    if (hint) {
      hint.textContent = 'Optional. Your mobile number can be used for login and account updates.';
      hint.classList.add('customer-optional-note');
    } else if (field) {
      const note = document.createElement('small');
      note.className = 'customer-optional-note';
      note.textContent = 'Optional. Your mobile number can be used for login and account updates.';
      field.append(note);
    }
  }

  function setupProfileSections() {
    const form = $('#profileForm');
    if (!form || form.dataset.uxSectionsReady === 'true') return;
    form.dataset.uxSectionsReady = 'true';
    makeEmailOptional(form);

    const sections = $$('.profile-details-section', form);
    sections.forEach((section, index) => {
      const heading = $('h3', section);
      const grid = $('.profile-grid', section);
      if (!heading || !grid) return;

      section.classList.add('profile-card');
      grid.classList.add('profile-section-body');
      grid.hidden = index !== 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-section-title';
      button.setAttribute('aria-expanded', String(index === 0));
      button.innerHTML = `<span><strong>${heading.textContent}</strong><small>${index === 0 ? 'Review or update these details' : 'Tap to review or update'}</small></span><b aria-hidden="true">⌄</b>`;
      heading.insertAdjacentElement('afterend', button);
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(open));
        grid.hidden = !open;
      });
    });

    form.addEventListener('invalid', event => {
      const section = event.target?.closest?.('.profile-details-section');
      if (!section) return;
      const button = $('.profile-section-title', section);
      const body = $('.profile-section-body', section);
      if (button && body) {
        button.setAttribute('aria-expanded', 'true');
        body.hidden = false;
      }
    }, true);
  }

  const applicationNext = {
    received: 'Next: KredRun will review your affordability and documents.',
    submitted: 'Next: KredRun will review your affordability and documents.',
    pending: 'Next: KredRun will review your affordability and documents.',
    under_review: 'Next: the decision will appear here when the review is complete.',
    reviewing: 'Next: the decision will appear here when the review is complete.',
    needs_information: 'Action needed: open Applications and provide the requested information.',
    documents_requested: 'Action needed: open Applications and provide the requested information.',
    approved: 'Next: review the credit offer and costs before accepting a loan.',
    declined: 'Decision complete. Open Applications to view the outcome.',
    rejected: 'Decision complete. Open Applications to view the outcome.',
    cancelled: 'This application is closed. No further action is needed.'
  };

  const loanNext = {
    active: 'Next: pay your next instalment by the due date.',
    overdue: 'Action needed: make a payment or contact KredRun if you need help.',
    approved: 'Next: wait for the payout status to be confirmed.',
    pending: 'Next: wait for the payout status to be confirmed.',
    disbursing: 'Next: payout is being processed.',
    paid: 'Paid in full. No further payment is due.',
    paid_up: 'Paid in full. No further payment is due.',
    settled: 'Settled. No further payment is due.',
    closed: 'This loan is closed. No further payment is due.',
    written_off: 'Contact KredRun if you need help with this account.'
  };

  function statusKey(badge) {
    const cls = [...(badge?.classList || [])].find(name => name.startsWith('status-') && name !== 'status-badge');
    return cls ? cls.slice(7).toLowerCase() : String(badge?.textContent || '').trim().toLowerCase().replace(/\s+/g, '_');
  }

  function annotatePortalRows() {
    $$('.portal-row').forEach(row => {
      if (row.querySelector('.portal-next-action')) return;
      const badge = $('.status-badge', row);
      const key = statusKey(badge);
      const map = row.classList.contains('loan-row') ? loanNext : applicationNext;
      const copy = map[key];
      if (!copy) return;
      const host = row.firstElementChild;
      if (!host) return;
      const note = document.createElement('small');
      note.className = `portal-next-action${key === 'overdue' || key === 'needs_information' || key === 'documents_requested' ? ' is-urgent' : ''}`;
      note.textContent = copy;
      host.append(note);
    });
  }

  function improveCurrentApplication() {
    const panel = $('[data-current-application]');
    const next = panel?.querySelector('[data-current-application-next]');
    if (!panel || !next) return;
    const key = String(panel.dataset.status || '').toLowerCase();
    const copy = applicationNext[key];
    if (copy && next.textContent !== copy) next.textContent = copy;
  }

  function improveLoanDetail() {
    const detail = $('[data-loan-detail-content]');
    if (!detail || detail.querySelector('[data-loan-next-action]')) return;
    const badge = $('.status-badge', detail);
    const key = statusKey(badge);
    const copy = loanNext[key];
    if (!copy) return;
    const head = $('.loan-detail-head', detail);
    if (!head) return;
    const note = document.createElement('p');
    note.dataset.loanNextAction = '';
    note.className = `portal-next-action${key === 'overdue' ? ' is-urgent' : ''}`;
    note.textContent = copy;
    head.insertAdjacentElement('afterend', note);
  }

  function observeAccount() {
    const account = $('.account-shell');
    if (!account) return;
    const refresh = () => {
      annotatePortalRows();
      improveCurrentApplication();
      improveLoanDetail();
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(account, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-status'] });
  }

  function setupApplication() {
    const form = $('#loanApplication');
    if (!form) return;
    makeEmailOptional(form);
  }

  addStyles();
  setupApplication();
  setupProfileSections();
  observeAccount();
})();
