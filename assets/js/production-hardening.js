(() => {
  if (window.__kredrunProductionHardeningLoaded) return;
  window.__kredrunProductionHardeningLoaded = true;

  const PLAN_KEY = 'kredrun-loan-plan';
  const atomicApplications = new Set();
  const pendingUploads = new Map();
  const config = window.KREDRUN_SUPABASE;

  // Emergency isolation: the current admin-netcash.js contains a JavaScript parse error.
  // Do not let that optional settings extension break the lender admin shell. The provider
  // backend remains enabled; only the broken browser extension is skipped until repaired.
  if (document.head && !window.__kredrunNetcashScriptQuarantine) {
    window.__kredrunNetcashScriptQuarantine = true;
    const nativeHeadAppend = document.head.append.bind(document.head);
    document.head.append = (...nodes) => {
      const safeNodes = nodes.filter(node => {
        const src = node?.tagName === 'SCRIPT' ? String(node.src || '') : '';
        if (src.includes('/assets/js/admin-netcash.js') || src.includes('assets/js/admin-netcash.js')) {
          console.warn('KredRun: admin-netcash.js was skipped because the deployed file has a syntax error.');
          return false;
        }
        return true;
      });
      if (safeNodes.length) nativeHeadAppend(...safeNodes);
    };
  }

  const readPlan = () => {
    try { return JSON.parse(localStorage.getItem(PLAN_KEY) || 'null'); }
    catch (_) { return null; }
  };

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, rawValue) {
    if (this === localStorage && key === PLAN_KEY) {
      try {
        const previous = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
        const incoming = JSON.parse(String(rawValue));
        if (previous && incoming && previous.collectionDate && !incoming.collectionDate) {
          rawValue = JSON.stringify({
            ...previous,
            ...incoming,
            collectionDate: previous.collectionDate,
            days: incoming.days ?? previous.days,
            estimatedTotal: incoming.estimatedTotal ?? previous.estimatedTotal,
          });
        }
      } catch (_) {}
    }
    return originalSetItem.call(this, key, rawValue);
  };

  const hardenedIdentityRequest = async (payload, token = '') => {
    if (!config?.url || !config?.publishableKey) throw new Error('Login is not configured.');
    const headers = { 'Content-Type': 'application/json', apikey: config.publishableKey };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(`${config.url}/functions/v1/identity-auth-v2`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('The request took too long. Please try again.');
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'We could not complete that request.');
    return data;
  };

  const adminTarget = next => {
    try {
      const parsed = new URL(String(next || ''), window.location.origin);
      return /\/admin\.html$/i.test(parsed.pathname);
    } catch (_) { return String(next || '').split(/[?#]/)[0].endsWith('admin.html'); }
  };

  const mfaQrSource = value => {
    const qr = String(value || '').trim();
    if (qr.startsWith('data:image/')) return qr;
    if (qr.startsWith('<svg')) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`;
    return '';
  };

  const showStaffMfaGate = ({client, mode, factorId, qrCode='', secret=''}) => new Promise((resolve, reject) => {
    document.querySelector('[data-kredrun-mfa-gate]')?.remove();
    const root = document.createElement('div');
    root.dataset.kredrunMfaGate = '';
    root.setAttribute('role','dialog');
    root.setAttribute('aria-modal','true');
    root.innerHTML = `
      <style>
        [data-kredrun-mfa-gate]{position:fixed;inset:0;z-index:2147483647;background:rgba(7,18,35,.82);backdrop-filter:blur(8px);display:grid;place-items:center;padding:20px;font-family:Manrope,Arial,sans-serif}
        [data-kredrun-mfa-card]{width:min(460px,100%);background:#fff;border-radius:22px;padding:28px;box-shadow:0 30px 90px rgba(0,0,0,.35);color:#132238}
        [data-kredrun-mfa-card] h2{margin:0 0 8px;font-size:24px}[data-kredrun-mfa-card] p{margin:0 0 18px;color:#607086;line-height:1.55}
        [data-kredrun-mfa-card] img{display:block;width:210px;height:210px;margin:14px auto;border:1px solid #dbe4ef;border-radius:14px;padding:10px;background:#fff}
        [data-kredrun-mfa-secret]{display:block;word-break:break-all;background:#f4f7fb;border-radius:10px;padding:10px 12px;margin:10px 0 16px;font:600 12px/1.4 ui-monospace,monospace}
        [data-kredrun-mfa-card] input{width:100%;box-sizing:border-box;border:1px solid #cbd6e2;border-radius:12px;padding:13px 14px;font-size:18px;letter-spacing:.15em;text-align:center}
        [data-kredrun-mfa-actions]{display:flex;gap:10px;margin-top:14px}[data-kredrun-mfa-actions] button{border:0;border-radius:12px;padding:12px 16px;font-weight:700;cursor:pointer}
        [data-kredrun-mfa-submit]{flex:1;background:#0d6efd;color:#fff}[data-kredrun-mfa-signout]{background:#eef3f8;color:#27384d}
        [data-kredrun-mfa-error]{min-height:20px;margin-top:10px!important;color:#b42318!important;font-size:13px}
      </style>
      <section data-kredrun-mfa-card>
        <small style="font-weight:800;color:#0d6efd;text-transform:uppercase;letter-spacing:.08em">KredRun lender security</small>
        <h2>${mode === 'enroll' ? 'Secure your admin account' : 'Verify it’s you'}</h2>
        <p>${mode === 'enroll' ? 'Lender staff accounts require two-factor authentication. Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password or another TOTP app, then enter the 6-digit code.' : 'Enter the 6-digit code from your authenticator app to open lender administration.'}</p>
        ${mode === 'enroll' && mfaQrSource(qrCode) ? `<img alt="Authenticator QR code" src="${mfaQrSource(qrCode)}">` : ''}
        ${mode === 'enroll' && secret ? `<span data-kredrun-mfa-secret>${String(secret).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}</span>` : ''}
        <form data-kredrun-mfa-form>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required aria-label="Six digit authenticator code">
          <p data-kredrun-mfa-error></p>
          <div data-kredrun-mfa-actions><button type="button" data-kredrun-mfa-signout>Sign out</button><button type="submit" data-kredrun-mfa-submit>${mode === 'enroll' ? 'Enable MFA' : 'Verify'}</button></div>
        </form>
      </section>`;
    document.body.append(root);
    const form = root.querySelector('[data-kredrun-mfa-form]');
    const input = form.querySelector('input[name="code"]');
    const message = root.querySelector('[data-kredrun-mfa-error]');
    root.querySelector('[data-kredrun-mfa-signout]').addEventListener('click', async () => {
      await client.auth.signOut().catch(()=>{});
      window.location.replace('login.html?next=admin.html');
      reject(new Error('Signed out.'));
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const code = String(input.value || '').replace(/\D/g,'');
      if (!/^\d{6}$/.test(code)) { message.textContent='Enter the 6-digit code from your authenticator app.'; return; }
      const submit = root.querySelector('[data-kredrun-mfa-submit]');
      submit.disabled = true; message.textContent='';
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });
      if (error) { submit.disabled=false; input.select(); message.textContent='That code could not be verified. Check your authenticator and try again.'; return; }
      await client.auth.refreshSession().catch(()=>{});
      root.remove();
      resolve(true);
    });
    window.setTimeout(()=>input.focus(),50);
  });

  const requireStaffMfa = async (client, user) => {
    if (!client?.auth?.mfa || !user?.id) return;
    const { data: staff } = await client.from('staff_members').select('user_id,status').eq('user_id',user.id).eq('status','active').maybeSingle();
    if (!staff) return;

    const { data: aalData, error: aalError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) throw new Error('Could not verify lender security level. Please sign in again.');
    if (aalData?.currentLevel === 'aal2') return;

    const { data: factorData, error: factorError } = await client.auth.mfa.listFactors();
    if (factorError) throw new Error('Could not load your two-factor authentication settings.');
    const verified = (factorData?.totp || []).find(factor => factor.status === 'verified');
    if (verified) {
      await showStaffMfaGate({client,mode:'challenge',factorId:verified.id});
      return;
    }

    for (const factor of (factorData?.totp || []).filter(item => item.status !== 'verified')) {
      await client.auth.mfa.unenroll({factorId:factor.id}).catch(()=>{});
    }
    const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({factorType:'totp',friendlyName:'KredRun lender admin'});
    if (enrollError || !enrolled?.id) throw new Error('Could not start two-factor authentication setup.');
    await showStaffMfaGate({client,mode:'enroll',factorId:enrolled.id,qrCode:enrolled?.totp?.qr_code,secret:enrolled?.totp?.secret});
  };

  const hardenAuth = auth => {
    if (!auth || auth.__kredrunProductionHardened) return auth;
    auth.__kredrunProductionHardened = true;
    auth.identityRequest = hardenedIdentityRequest;
    if (typeof auth.requireUser === 'function') {
      const normalRequireUser = auth.requireUser.bind(auth);
      auth.requireUser = async (next = 'account.html') => {
        const user = await normalRequireUser(next);
        if (!user || !adminTarget(next)) return user;
        try { await requireStaffMfa(auth.client || window.kredrunSupabase, user); }
        catch (error) {
          if (String(error?.message || '') === 'Signed out.') return null;
          const loading = document.querySelector('[data-admin-loading]');
          if (loading) loading.innerHTML = `<div class="loading-mark">!</div><strong>Secure sign-in required</strong><p>${String(error?.message || 'Two-factor authentication is required to open lender administration.').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p><a href="login.html?next=admin.html">Sign in again</a>`;
          return null;
        }
        return user;
      };
    }
    return auth;
  };

  const applicationIdFromPath = path => {
    const parts = String(path || '').split('/');
    return parts.length >= 3 ? parts[1] : '';
  };

  const cleanPendingUploads = async (client, applicationId) => {
    const paths = [...(pendingUploads.get(applicationId) || [])];
    pendingUploads.delete(applicationId);
    if (!paths.length) return;
    try { await client.storage.from('application-documents').remove(paths); }
    catch (_) {}
  };

  const hardenClient = client => {
    if (!client || client.__kredrunProductionHardened) return client;
    client.__kredrunProductionHardened = true;

    const normalRpc = client.rpc.bind(client);
    client.rpc = async (name, args = {}, options) => {
      const rpcName = String(name || '').trim();
      if (!rpcName.startsWith('admin_')) return normalRpc(name, args, options);
      try {
        const { data: sessionData } = await client.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) return { data:null, error:{ message:'Please sign in again.', code:'authentication_required' } };
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 20000);
        let response;
        try {
          response = await fetch('/api/admin-rpc', {
            method:'POST',
            headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
            body:JSON.stringify({rpc:rpcName,args:args||{}}),
            signal:controller.signal
          });
        } finally { window.clearTimeout(timer); }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return { data:null, error:{ message:payload?.message || 'The lender administration action failed.', code:payload?.code || 'admin_rpc_failed', status:response.status } };
        return { data:payload?.data ?? null, error:null };
      } catch (error) {
        return { data:null, error:{ message:error?.name==='AbortError'?'The lender administration action timed out.':(error?.message || 'The lender administration action failed.'), code:error?.name==='AbortError'?'request_timeout':'admin_rpc_failed' } };
      }
    };

    const baseStorageFrom = client.storage.from.bind(client.storage);
    client.storage.from = bucketName => {
      const bucket = baseStorageFrom(bucketName);
      if (bucketName !== 'application-documents' || typeof bucket?.upload !== 'function') return bucket;
      const normalUpload = bucket.upload.bind(bucket);
      bucket.upload = async (path, file, options) => {
        const applicationId = applicationIdFromPath(path);
        const result = await normalUpload(path, file, options);
        if (!result.error && applicationId) {
          if (!pendingUploads.has(applicationId)) pendingUploads.set(applicationId, new Set());
          pendingUploads.get(applicationId).add(path);
        } else if (result.error && applicationId) {
          await cleanPendingUploads(client, applicationId);
        }
        return result;
      };
      return bucket;
    };

    const baseFrom = client.from.bind(client);
    client.from = relation => {
      const builder = baseFrom(relation);

      if (relation === 'loan_applications' && typeof builder?.insert === 'function') {
        const normalInsert = builder.insert.bind(builder);
        builder.insert = async (values, options) => {
          const rows = Array.isArray(values) ? values : [values];
          const row = rows[0];
          if (rows.length !== 1 || !row || row.source !== 'website' || row.status !== 'received') {
            return normalInsert(values, options);
          }

          const plan = readPlan();
          const payload = {
            ...row,
            preferred_collection_date: row.preferred_collection_date || plan?.collectionDate || null,
          };
          const result = await client.rpc('submit_loan_application', { p_application: payload });
          if (!result.error && payload.id) {
            atomicApplications.add(payload.id);
            pendingUploads.delete(payload.id);
          } else if (payload.id) {
            await cleanPendingUploads(client, payload.id);
          }
          return result;
        };
      }

      if (relation === 'customer_documents' && typeof builder?.insert === 'function') {
        const normalInsert = builder.insert.bind(builder);
        builder.insert = (values, options) => {
          const rows = Array.isArray(values) ? values : [values];
          if (rows.length && rows.every(row => row?.source_application_id && atomicApplications.has(row.source_application_id))) {
            return Promise.resolve({ data: rows, error: null });
          }
          return normalInsert(values, options);
        };
      }

      return builder;
    };

    return client;
  };

  let storedClient;
  Object.defineProperty(window, 'kredrunSupabase', {
    configurable: true,
    enumerable: true,
    get: () => storedClient,
    set: value => { storedClient = hardenClient(value); },
  });

  let storedAuth;
  Object.defineProperty(window, 'KredRunAuth', {
    configurable: true,
    enumerable: true,
    get: () => storedAuth,
    set: value => { storedAuth = hardenAuth(value); },
  });

  const strongPassword = value => {
    const password = String(value || '');
    return password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  };

  const passwordMessage = 'Use at least 10 characters with an uppercase letter, lowercase letter and number.';

  const strengthenPasswordFields = () => {
    const fields = document.querySelectorAll('[data-new-form] input[name="password"], #updatePasswordForm input[name="password"]');
    fields.forEach(input => {
      const pattern = '(?=.*[a-z])(?=.*[A-Z])(?=.*\\d).{10,}';
      const hintText = 'At least 10 characters, including upper/lower case and a number.';
      if (input.minLength !== 10) input.minLength = 10;
      if (input.pattern !== pattern) input.pattern = pattern;
      if (input.title !== passwordMessage) input.title = passwordMessage;
      const hint = input.closest('.auth-field')?.querySelector('small');
      if (hint && hint.textContent !== hintText) hint.textContent = hintText;
    });
    return fields.length;
  };

  const showPasswordError = form => {
    const rootFeedback = form.closest('[data-login-identity-auth]')?.querySelector('[data-feedback]');
    const pageFeedback = document.querySelector('[data-auth-feedback]');
    const feedback = rootFeedback || pageFeedback;
    if (feedback) {
      feedback.textContent = passwordMessage;
      feedback.className = 'auth-feedback show error';
    }
  };

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.matches('[data-new-form], #updatePasswordForm')) return;
    const password = form.querySelector('input[name="password"]')?.value || '';
    if (strongPassword(password)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showPasswordError(form);
    form.querySelector('input[name="password"]')?.focus();
  }, true);

  const observer = new MutationObserver(() => {
    if (strengthenPasswordFields()) observer.disconnect();
  });

  const ensureAdminStartupTargets = () => {
    if (!document.body?.classList.contains('admin-page')) return;
    if (!document.querySelector('[data-first-name]')) {
      const fallback = document.createElement('span');
      fallback.dataset.firstName = '';
      fallback.hidden = true;
      fallback.setAttribute('aria-hidden','true');
      document.body.append(fallback);
    }
  };

  const startPasswordHardening = () => {
    if (strengthenPasswordFields()) return;
    const root = document.querySelector('[data-login-identity-auth], #updatePasswordForm');
    if (root) observer.observe(root, { childList: true, subtree: true });
  };

  const start = () => {
    ensureAdminStartupTargets();
    startPasswordHardening();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
