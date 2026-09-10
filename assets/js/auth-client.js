(() => {
  if (window.kredrunSupabase) return;

  const config = window.KREDRUN_SUPABASE;
  if (!window.supabase || !config?.url || !config?.publishableKey) {
    console.error('KredRun authentication is not configured.');
    return;
  }

  const REQUEST_TIMEOUT_MS = 20000;
  const boundedFetch = (input, init = {}) => {
    const controller = new AbortController();
    const upstream = init.signal;
    const relayAbort = () => controller.abort(upstream?.reason);
    if (upstream) {
      if (upstream.aborted) relayAbort();
      else upstream.addEventListener('abort', relayAbort, { once: true });
    }
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      window.clearTimeout(timer);
      upstream?.removeEventListener?.('abort', relayAbort);
    });
  };

  const client = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    global: { fetch: boundedFetch }
  });

  const isInternalEmail = value => /^kr-[a-f0-9]+@login\.invalid$/i.test(String(value || '').trim());
  const cleanContactEmail = value => {
    const email = String(value || '').trim().toLowerCase();
    return /^\S+@\S+\.\S+$/.test(email) && !isInternalEmail(email) ? email : '';
  };
  const readLoanPlan = () => {
    try { return JSON.parse(localStorage.getItem('kredrun-loan-plan') || 'null'); }
    catch (_) { return null; }
  };

  // Older phone-first accounts used an internal placeholder email. Never expose that value to customer-facing code.
  const rawGetUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = async (...args) => {
    const result = await rawGetUser(...args);
    const user = result?.data?.user;
    if (user && isInternalEmail(user.email)) result.data.user = { ...user, email: null };
    return result;
  };

  // Attach calculator data and the real customer email whenever application/profile data is saved.
  const rawFrom = client.from.bind(client);
  client.from = relation => {
    const builder = rawFrom(relation);

    if (relation === 'loan_applications' && typeof builder.insert === 'function') {
      const rawInsert = builder.insert.bind(builder);
      builder.insert = (values, options) => {
        const collectionDate = readLoanPlan()?.collectionDate || null;
        const email = cleanContactEmail(document.querySelector('#loanApplication [name="email"]')?.value);
        const patch = row => row && typeof row === 'object' && !Array.isArray(row)
          ? { ...row, preferred_collection_date: collectionDate || row.preferred_collection_date || null, email: email || (isInternalEmail(row.email) ? null : row.email) }
          : row;
        const payload = Array.isArray(values) ? values.map(patch) : patch(values);
        return rawInsert(payload, options);
      };
    }

    if (relation === 'customer_profiles' && typeof builder.upsert === 'function') {
      const rawUpsert = builder.upsert.bind(builder);
      builder.upsert = (values, options) => {
        const email = cleanContactEmail(document.querySelector('#loanApplication [name="email"]')?.value);
        const patch = row => row && typeof row === 'object' && !Array.isArray(row) && email ? { ...row, email } : row;
        const payload = Array.isArray(values) ? values.map(patch) : patch(values);
        return rawUpsert(payload, options);
      };
    }

    return builder;
  };

  const safeNext = (value, fallback = 'account.html') => {
    if (!value) return fallback;
    try {
      const parsed = new URL(value, window.location.origin);
      if (parsed.origin !== window.location.origin) return fallback;
      const file = parsed.pathname.split('/').pop() || fallback;
      if (!/^[a-z0-9._-]+\.html$/i.test(file)) return fallback;
      return `${file}${parsed.search}${parsed.hash}`;
    } catch (_) { return fallback; }
  };

  const validSaId = value => {
    const id = String(value || '').replace(/\D/g, '');
    if (!/^\d{13}$/.test(id)) return false;
    let odd = 0;
    for (let i = 0; i < 12; i += 2) odd += Number(id[i]);
    const evens = id.slice(1, 12).split('').filter((_, i) => i % 2 === 0).join('');
    const even = [...String(Number(evens || 0) * 2)].reduce((sum, d) => sum + Number(d), 0);
    return ((10 - ((odd + even) % 10)) % 10) === Number(id[12]);
  };

  const identityRequest = async (payload, token = '') => {
    const headers = { 'Content-Type': 'application/json', apikey: config.publishableKey };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await boundedFetch(`${config.url}/functions/v1/identity-auth`, {
        method: 'POST', headers, body: JSON.stringify(payload)
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The request took too long. Please try again.');
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'We could not complete that request.');
    return data;
  };

  const completePendingProfile = async () => {
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    try { return await identityRequest({ action: 'complete_profile' }, token); }
    catch (_) { return null; }
  };

  let cachedAccessToken = '';
  let cachedUserPromise = null;
  const getCurrentUser = async () => {
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token || '';
    if (!accessToken) {
      cachedAccessToken = '';
      cachedUserPromise = null;
      return null;
    }
    if (accessToken !== cachedAccessToken || !cachedUserPromise) {
      cachedAccessToken = accessToken;
      cachedUserPromise = client.auth.getUser()
        .then(({ data: userData, error }) => error ? null : (userData?.user || null))
        .catch(() => null);
    }
    return cachedUserPromise;
  };

  window.kredrunSupabase = client;
  window.KredRunAuth = {
    client, safeNext, validSaId, identityRequest, completePendingProfile, isInternalEmail,
    getUser: getCurrentUser,
    async requireUser(next = 'account.html') {
      const user = await this.getUser();
      if (!user) {
        window.location.href = `login.html?next=${encodeURIComponent(safeNext(next))}`;
        return null;
      }
      return user;
    }
  };

  const gate = document.querySelector('[data-auth-gate]');
  if (gate) {
    gate.innerHTML = '<strong>Continue to your application</strong><span>Your session has ended.</span><div class="auth-gate-actions"><a class="btn btn-primary" href="login.html?next=apply.html">Continue</a></div>';
  }

  const setupSmartApplication = async () => {
    if (!document.body.classList.contains('application-page') || document.body.classList.contains('received-body')) return;

    document.body.classList.add('smart-application', 'auth-checking');

    const plan = readLoanPlan();
    if (!plan?.amount || !plan?.collectionDate) {
      location.replace('index.html#loan-calculator');
      return;
    }

    const nativeScrollTo = window.scrollTo.bind(window);
    window.scrollTo = (first, second) => {
      if (typeof first === 'object' && first?.behavior === 'smooth') return;
      return nativeScrollTo(first, second);
    };

    const user = await getCurrentUser();
    if (!user) {
      const next = `${location.pathname.split('/').pop() || 'apply.html'}${location.search}${location.hash}`;
      location.replace(`login.html?next=${encodeURIComponent(safeNext(next, 'apply.html'))}`);
      return;
    }

    document.body.classList.remove('auth-checking');

    const money = value => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(Number(value || 0)).replace('ZAR', 'R').trim();
    const dateText = value => {
      if (!value) return '';
      const date = new Date(`${value}T00:00:00`);
      return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month:'short', year:'numeric' }).format(date);
    };

    const addPlanChip = () => {
      if (document.querySelector('[data-smart-plan-chip]')) return;
      const progressCard = document.querySelector('.progress-card');
      if (!progressCard) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'smart-plan-chip';
      chip.dataset.smartPlanChip = '';
      chip.innerHTML = `<span>Loan</span><strong>${money(plan.amount)} · ${dateText(plan.collectionDate)}</strong><em>Change</em>`;
      chip.addEventListener('click', () => { window.location.href = 'index.html#loan-calculator'; });
      progressCard.appendChild(chip);
    };

    const syncReviewCollectionDate = () => {
      const review = document.querySelector('#reviewSummary');
      if (!review) return;
      const loanSection = review.querySelector('.review-section');
      if (!loanSection) return;
      const items = [...loanSection.querySelectorAll('.review-item')];
      const termItem = items.find(item => item.querySelector('span')?.textContent?.trim() === 'Term' || item.querySelector('span')?.textContent?.trim() === 'Collection date');
      if (!termItem) return;
      const label = termItem.querySelector('span');
      const value = termItem.querySelector('strong');
      const nextLabel = 'Collection date';
      const nextValue = dateText(plan.collectionDate);
      // Only touch the DOM when the value actually changed. Rewriting observed text here
      // used to retrigger this MutationObserver forever and could freeze the browser.
      if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
      if (value && value.textContent !== nextValue) value.textContent = nextValue;
    };

    const review = document.querySelector('#reviewSummary');
    if (review) {
      new MutationObserver(syncReviewCollectionDate).observe(review, { childList: true, subtree: true });
      syncReviewCollectionDate();
    }

    const collapseIdentity = () => {
      const section = document.querySelector('#loanApplication [data-step="2"]');
      if (!section || section.querySelector('[data-smart-identity]')) return false;
      const fields = ['firstName', 'lastName', 'idNumber', 'mobile'].map(name => document.querySelector(`#loanApplication [name="${name}"]`));
      if (fields.some(field => !field || !String(field.value || '').trim())) return false;

      const [firstName, lastName, idNumber, mobile] = fields.map(field => String(field.value || '').trim());
      const grid = section.querySelector('.form-grid');
      if (!grid) return false;

      const summary = document.createElement('div');
      summary.className = 'smart-identity-summary';
      summary.dataset.smartIdentity = '';
      summary.innerHTML = `<div><span>Your details</span><strong>${firstName} ${lastName}</strong><small>ID •••••••••${idNumber.slice(-4)} · ${mobile}</small></div><button type="button">Change</button>`;
      summary.querySelector('button').addEventListener('click', () => {
        section.classList.toggle('show-identity-fields');
        summary.querySelector('button').textContent = section.classList.contains('show-identity-fields') ? 'Done' : 'Change';
      });
      grid.parentNode.insertBefore(summary, grid);
      fields.forEach(field => field.closest('.field')?.classList.add('smart-identity-field'));
      section.classList.add('identity-collapsed');
      section.querySelectorAll('[data-profile-prefill]').forEach(note => { note.hidden = true; });
      return true;
    };

    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      addPlanChip();
      const collapsed = collapseIdentity();
      syncReviewCollectionDate();
      if (tries > 20 || collapsed) window.clearInterval(timer);
    }, 180);

    window.setTimeout(() => {
      const firstStep = document.querySelector('#loanApplication [data-step="1"]');
      const next = document.querySelector('#loanApplication [data-next]');
      if (firstStep?.classList.contains('active') && next) next.click();
    }, 220);
  };

  setupSmartApplication();
})();