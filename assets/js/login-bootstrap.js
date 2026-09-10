(() => {
  const root = document.querySelector('[data-login-identity-auth]');
  if (!root) return;

  // Pin the SDK so a future CDN release cannot unexpectedly change the login page.
  const REMOTE_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.113.0/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2.113.0/dist/umd/supabase.js'
  ];
  const isSdkReady = () => typeof window.supabase?.createClient === 'function';
  let pendingId = root.querySelector('input[name="idNumber"]')?.value || '';

  const renderWaiting = (message, failed = false) => {
    const currentId = root.querySelector('input[name="idNumber"]')?.value;
    if (currentId != null) pendingId = currentId;

    root.innerHTML = `
      <form class="login-waiting-form" data-login-waiting-form>
        <div class="auth-field">
          <label>South African ID number</label>
          <input name="idNumber" inputmode="numeric" autocomplete="off" maxlength="13" pattern="[0-9]{13}" placeholder="13 digits" required autofocus>
        </div>
        <button class="btn btn-primary btn-wide" type="submit" disabled aria-disabled="true">${failed ? 'Login unavailable' : 'Getting login ready…'}</button>
      </form>
      ${failed
        ? `<div class="auth-feedback show error" role="alert">${message}<br><button class="auth-link" type="button" data-login-retry>Retry</button></div>`
        : `<div class="login-boot-state" role="status" aria-live="polite"><span class="login-boot-dot" aria-hidden="true"></span><span>${message}</span></div>`}
    `;

    const input = root.querySelector('input[name="idNumber"]');
    if (input) {
      input.value = pendingId;
      input.addEventListener('input', () => { pendingId = input.value; });
    }
    root.querySelector('[data-login-waiting-form]')?.addEventListener('submit', event => event.preventDefault());
    root.querySelector('[data-login-retry]')?.addEventListener('click', start);
  };

  const loadScript = (src, timeout = 18000) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (!ok) script.remove();
      ok ? resolve() : reject(error || new Error(`Could not load ${src}`));
    };
    const timer = window.setTimeout(() => finish(false, new Error(`Timed out loading ${src}`)), timeout);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => finish(isSdkReady(), new Error(`Invalid Supabase SDK from ${src}`));
    script.onerror = () => finish(false, new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });

  const loadLocal = (src, timeout = 12000) => new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-login-loaded="${src}"]`)) return resolve();
    const script = document.createElement('script');
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.onload = script.onerror = null;
      delete script.dataset.loginPending;
      if (!ok) script.remove();
      else script.dataset.loginLoaded = src;
      ok ? resolve() : reject(error || new Error(`Could not load ${src}`));
    };
    const timer = window.setTimeout(() => finish(false, new Error(`Timed out loading ${src}`)), timeout);
    script.src = src;
    script.async = false;
    script.dataset.loginPending = src;
    script.onload = () => finish(true);
    script.onerror = () => finish(false, new Error(`Could not load ${src}`));
    document.body.appendChild(script);
  });

  const resetIncompleteLocalScripts = () => {
    if (window.kredrunSupabase && window.KredRunAuth) return;
    document.querySelectorAll('script[data-login-loaded]').forEach(script => script.remove());
  };

  let running = false;
  async function start() {
    if (running) return;
    running = true;
    renderWaiting('Securing your login…');

    try {
      if (!isSdkReady()) {
        for (const source of REMOTE_SOURCES) {
          try {
            await loadScript(source);
            if (isSdkReady()) break;
          } catch (_) {}
        }
      }
      if (!isSdkReady()) throw new Error('Supabase client unavailable');

      resetIncompleteLocalScripts();
      await loadLocal('assets/js/auth-client.js?v=20260902-1');
      if (!window.kredrunSupabase || !window.KredRunAuth) throw new Error('Authentication client did not initialise');

      await loadLocal('assets/js/login-session-guard.js?v=20260902-1');
      await loadLocal('assets/js/auth.js?v=20260902-1');
      if (!root.querySelector('[data-id-form]')) throw new Error('Login form did not initialise');

      const readyInput = root.querySelector('input[name="idNumber"]');
      if (readyInput && pendingId) readyInput.value = pendingId;
      await loadLocal('assets/js/registration-email.js?v=20260902-1');
    } catch (error) {
      console.error('KredRun login bootstrap failed.', error);
      renderWaiting('We could not prepare the login. Check your connection and try again.', true);
    } finally {
      running = false;
    }
  }

  start();
})();
