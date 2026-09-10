(() => {
  const current = document.currentScript;
  if (!current) return;

  const REMOTE_SOURCES = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.113.0/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2.113.0/dist/umd/supabase.js'
  ];
  const isSdkReady = () => typeof window.supabase?.createClient === 'function';
  const localScripts = String(current.dataset.scripts || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const pageName = current.dataset.page || 'this page';

  const loadRemote = (src, timeout = 18000) => new Promise((resolve, reject) => {
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
    const existing = [...document.scripts].find(script => script.dataset.kredrunLoaded === src);
    if (existing) return resolve();
    const script = document.createElement('script');
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script.onload = script.onerror = null;
      delete script.dataset.kredrunPending;
      if (!ok) script.remove();
      else script.dataset.kredrunLoaded = src;
      ok ? resolve() : reject(error || new Error(`Could not load ${src}`));
    };
    const timer = window.setTimeout(() => finish(false, new Error(`Timed out loading ${src}`)), timeout);
    script.src = src;
    script.async = false;
    script.dataset.kredrunPending = src;
    script.onload = () => finish(true);
    script.onerror = () => finish(false, new Error(`Could not load ${src}`));
    document.body.appendChild(script);
  });

  const setNativeLoaderVisible = visible => {
    for (const selector of ['[data-account-boot]','[data-admin-loading]','[data-client-loading]']) {
      const element = document.querySelector(selector);
      if (element) element.hidden = !visible;
    }
  };

  const removeFailure = () => document.querySelector('[data-kredrun-connection-failure]')?.remove();
  const showFailure = () => {
    removeFailure();
    setNativeLoaderVisible(false);
    const box = document.createElement('div');
    box.dataset.kredrunConnectionFailure = '';
    box.setAttribute('role', 'alert');
    box.innerHTML = `<strong>Connection problem</strong><span>We could not load ${pageName}. Check your connection and try again.</span><button type="button">Retry</button>`;
    const style = document.createElement('style');
    style.textContent = `[data-kredrun-connection-failure]{position:fixed;z-index:99999;left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,calc(100% - 32px));padding:22px;border:1px solid #d9e5ef;border-radius:18px;background:#fff;box-shadow:0 20px 60px rgba(0,33,66,.18);display:grid;gap:10px;text-align:center;font-family:inherit;color:#092b49}[data-kredrun-connection-failure] strong{font-size:1.05rem}[data-kredrun-connection-failure] span{font-size:.88rem;color:#667681;line-height:1.45}[data-kredrun-connection-failure] button{justify-self:center;border:0;border-radius:11px;padding:10px 20px;background:#176ed1;color:#fff;font:inherit;font-weight:800;cursor:pointer}`;
    box.appendChild(style);
    box.querySelector('button').addEventListener('click', start);
    document.body.appendChild(box);
  };

  let running = false;
  async function start() {
    if (running) return;
    running = true;
    removeFailure();
    setNativeLoaderVisible(true);
    try {
      if (!isSdkReady()) {
        for (const source of REMOTE_SOURCES) {
          try {
            await loadRemote(source);
            if (isSdkReady()) break;
          } catch (_) {}
        }
      }
      if (!isSdkReady()) throw new Error('Supabase client unavailable');
      for (const src of localScripts) await loadLocal(src);

      const customerUxPage = ['your application', 'your account'].includes(String(pageName).toLowerCase());
      if (customerUxPage) await loadLocal('assets/js/customer-ux.js?v=20260906-1');

      // A script tag can load successfully even when its JavaScript throws. Check
      // the expected auth globals so affected pages cannot remain on a fake loader.
      if (localScripts.some(src => /\/auth-client\.js(?:\?|$)/.test(src)) && (!window.kredrunSupabase || !window.KredRunAuth)) {
        throw new Error('Authentication client did not initialise');
      }

      window.dispatchEvent(new CustomEvent('kredrun:supabase-ready'));
    } catch (error) {
      console.error(`KredRun could not initialise ${pageName}.`, error);
      showFailure();
      window.dispatchEvent(new CustomEvent('kredrun:supabase-failed', { detail: error }));
    } finally {
      running = false;
    }
  }

  start();
})();
