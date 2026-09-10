(() => {
  const auth = window.KredRunAuth;
  const client = window.kredrunSupabase;
  if (!auth || !client) return;

  const params = new URLSearchParams(location.search);
  const next = auth.safeNext(params.get('next'), 'account.html');
  const root = document.querySelector('[data-login-identity-auth]');
  const pageFeedback = document.querySelector('[data-auth-feedback]');

  const setLoading = (button, loading, label) => {
    if (!button) return;
    button.disabled = loading;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.textContent = loading ? label : button.dataset.label;
  };

  const setSession = async session => {
    if (!session?.access_token || !session?.refresh_token) throw new Error('We could not continue. Please try again.');
    const { error } = await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (error) throw error;
    await auth.completePendingProfile();
    location.href = next;
  };

  if (root) {
    root.innerHTML = `
      <div class="auth-feedback" data-feedback role="status" aria-live="polite"></div>

      <section data-step="id">
        <form data-id-form>
          <div class="auth-field">
            <label>South African ID number</label>
            <input name="idNumber" inputmode="numeric" autocomplete="off" maxlength="13" pattern="[0-9]{13}" placeholder="13 digits" required autofocus>
          </div>
          <button class="btn btn-primary btn-wide" type="submit">Continue</button>
        </form>
      </section>

      <section data-step="new" hidden>
        <button class="auth-link identity-back" type="button" data-back-id>← Change ID number</button>
        <h2>Your details</h2>
        <form data-new-form>
          <div class="auth-name-grid">
            <div class="auth-field"><label>First name</label><input name="firstName" autocomplete="given-name" maxlength="80" required></div>
            <div class="auth-field"><label>Surname</label><input name="lastName" autocomplete="family-name" maxlength="80" required></div>
          </div>
          <div class="auth-field"><label>Cellphone number</label><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="082 123 4567" required></div>
          <div class="auth-field"><label>Password</label><input name="password" type="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small></div>
          <button class="btn btn-primary btn-wide" type="submit">Continue application</button>
        </form>
      </section>

      <section data-step="code" hidden>
        <button class="auth-link identity-back" type="button" data-back-id>← Change ID number</button>
        <h2>Enter the code</h2>
        <p class="auth-step-copy">Sent to <strong data-masked>your cellphone</strong>.</p>
        <form data-code-form>
          <div class="auth-field">
            <label>Verification code</label>
            <input name="token" class="identity-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="000000" required>
          </div>
          <button class="btn btn-primary btn-wide" type="submit">Continue application</button>
        </form>
        <div class="identity-code-links">
          <button class="auth-link" type="button" data-resend>Send a new code</button>
          <button class="auth-link" type="button" data-use-password>Use password instead</button>
        </div>
      </section>

      <section data-step="password" hidden>
        <button class="auth-link identity-back" type="button" data-back-id>← Change ID number</button>
        <h2>Enter your password</h2>
        <form data-password-form>
          <div class="auth-field"><label>Password</label><input name="password" type="password" autocomplete="current-password" minlength="8" required autofocus></div>
          <button class="btn btn-primary btn-wide" type="submit">Continue application</button>
        </form>
        <button class="auth-link identity-resend" type="button" data-use-code>Use a one-time code instead</button>
      </section>`;

    if (!document.querySelector('#identity-login-style')) {
      const style = document.createElement('style');
      style.id = 'identity-login-style';
      style.textContent = `
        [data-login-identity-auth] h2{margin:0 0 7px;font-size:1.35rem;letter-spacing:-.02em}
        .auth-step-copy{margin:0 0 18px;color:#6f7f89}
        .auth-name-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .identity-back{margin-bottom:16px}
        .identity-resend{display:block;margin:16px auto 0;text-align:center}
        .identity-otp{font-size:1.45rem!important;letter-spacing:.30em;text-align:center;font-weight:750}
        .identity-code-links{display:flex;justify-content:center;gap:20px;flex-wrap:wrap;margin-top:16px}
        .auth-field small{color:#778692;font-size:.78rem}
        @media(max-width:520px){.auth-name-grid{grid-template-columns:1fr}}
      `;
      document.head.appendChild(style);
    }

    const feedback = root.querySelector('[data-feedback]');
    const steps = [...root.querySelectorAll('[data-step]')];
    const idForm = root.querySelector('[data-id-form]');
    const newForm = root.querySelector('[data-new-form]');
    const codeForm = root.querySelector('[data-code-form]');
    const passwordForm = root.querySelector('[data-password-form]');
    const masked = root.querySelector('[data-masked]');
    const state = {
      idNumber: String(params.get('id') || '').replace(/\D/g, '').slice(0, 13),
      status: '',
      channel: '',
      methods: [],
      preferPassword: params.get('mode') === 'password'
    };

    const show = (message = '', type = 'error') => {
      feedback.textContent = message;
      feedback.className = `auth-feedback${message ? ` show ${type}` : ''}`;
    };

    const showStep = name => {
      steps.forEach(step => { step.hidden = step.dataset.step !== name; });
      show('');
      const target = root.querySelector(`[data-step="${name}"] input:not([type="hidden"])`);
      window.setTimeout(() => target?.focus(), 0);
    };

    const preferredMethod = () => state.methods.find(item => item.channel === 'sms') || state.methods[0] || null;

    const sendExistingOtp = async () => {
      const ordered = [...state.methods].sort((a, b) => (a.channel === 'sms' ? -1 : 1) - (b.channel === 'sms' ? -1 : 1));
      let lastError = null;
      for (const method of ordered) {
        try {
          const data = await auth.identityRequest({
            action: 'send_otp',
            idNumber: state.idNumber,
            channel: method.channel,
            redirectTo: new URL(next, location.href).toString()
          });
          state.channel = method.channel;
          masked.textContent = data.masked || method.masked || 'your contact';
          showStep('code');
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return false;
    };

    idForm.elements.idNumber.value = state.idNumber;

    idForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = idForm.querySelector('button[type="submit"]');
      const id = String(idForm.elements.idNumber.value || '').replace(/\D/g, '');
      if (!auth.validSaId(id)) return show('Enter a valid 13-digit South African ID number.');

      state.idNumber = id;
      setLoading(button, true, 'Checking…');
      try {
        const data = await auth.identityRequest({ action: 'lookup', idNumber: id });
        state.status = data.status;
        state.methods = data.methods || [];

        if (data.status === 'new') {
          showStep('new');
          return;
        }

        if (state.preferPassword || !state.methods.length) {
          showStep('password');
          return;
        }

        try {
          await sendExistingOtp();
        } catch (error) {
          showStep('password');
          show(error.message);
        }
      } catch (error) {
        show(error.message);
      } finally {
        setLoading(button, false);
      }
    });

    newForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = newForm.querySelector('button[type="submit"]');
      const firstName = newForm.elements.firstName.value.trim();
      const lastName = newForm.elements.lastName.value.trim();
      const phone = newForm.elements.phone.value.trim();
      const password = newForm.elements.password.value;
      if (firstName.length < 2) return show('Enter your first name.');
      if (lastName.length < 2) return show('Enter your surname.');
      if (password.length < 8) return show('Use at least 8 characters for your password.');

      setLoading(button, true, 'Continuing…');
      try {
        const data = await auth.identityRequest({ action: 'register_password', idNumber: state.idNumber, firstName, lastName, phone, password });
        await setSession(data.session);
      } catch (error) {
        show(error.message);
        setLoading(button, false);
      }
    });

    codeForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = codeForm.querySelector('button[type="submit"]');
      const token = String(codeForm.elements.token.value || '').replace(/\D/g, '');
      if (!/^\d{6,8}$/.test(token)) return show('Enter the code we sent you.');

      setLoading(button, true, 'Checking…');
      try {
        const data = await auth.identityRequest({ action: 'verify_otp', idNumber: state.idNumber, channel: state.channel, token });
        await setSession(data.session);
      } catch (error) {
        show(error.message);
        setLoading(button, false);
      }
    });

    root.querySelector('[data-resend]').addEventListener('click', async event => {
      const button = event.currentTarget;
      setLoading(button, true, 'Sending…');
      try {
        const data = await auth.identityRequest({
          action: 'send_otp',
          idNumber: state.idNumber,
          channel: state.channel,
          redirectTo: new URL(next, location.href).toString()
        });
        masked.textContent = data.masked || masked.textContent;
        show('A new code has been sent.', 'success');
      } catch (error) {
        show(error.message);
      } finally {
        setLoading(button, false);
      }
    });

    passwordForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = passwordForm.querySelector('button[type="submit"]');
      const password = passwordForm.elements.password.value;
      if (password.length < 8) return show('Enter your password.');
      setLoading(button, true, 'Checking…');
      try {
        const data = await auth.identityRequest({ action: 'password_login', idNumber: state.idNumber, password });
        await setSession(data.session);
      } catch (error) {
        show(error.message);
        setLoading(button, false);
      }
    });

    root.querySelector('[data-use-password]').addEventListener('click', () => showStep('password'));
    root.querySelector('[data-use-code]').addEventListener('click', async event => {
      const button = event.currentTarget;
      if (!state.methods.length) return showStep('id');
      setLoading(button, true, 'Sending…');
      try { await sendExistingOtp(); }
      catch (error) { show(error.message); }
      finally { setLoading(button, false); }
    });

    root.querySelectorAll('[data-back-id]').forEach(button => button.addEventListener('click', () => {
      state.preferPassword = false;
      showStep('id');
    }));

    showStep('id');

    (async () => {
      await auth.completePendingProfile();
      const user = await auth.getUser();
      if (user && params.get('stay') !== '1') location.href = next;
    })();
  }

  const passwordUpdate = document.querySelector('#updatePasswordForm');
  if (passwordUpdate) {
    (async () => {
      if (!(await auth.getUser())) location.href = `login.html?next=${encodeURIComponent('update-password.html')}`;
    })();

    passwordUpdate.addEventListener('submit', async event => {
      event.preventDefault();
      const button = passwordUpdate.querySelector('button[type="submit"]');
      const password = passwordUpdate.password.value;
      const confirm = passwordUpdate.confirmPassword.value;
      const showPage = (message, type = 'error') => {
        if (!pageFeedback) return;
        pageFeedback.textContent = message;
        pageFeedback.className = `auth-feedback show ${type}`;
      };
      if (password.length < 8) return showPage('Use at least 8 characters for your password.');
      if (password !== confirm) return showPage('The two passwords do not match.');
      setLoading(button, true, 'Saving…');
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        showPage(error.message);
        setLoading(button, false);
        return;
      }
      passwordUpdate.reset();
      showPage('Password saved.', 'success');
      setLoading(button, false);
      const link = document.querySelector('[data-account-after-reset]');
      if (link) link.hidden = false;
    });
  }
})();
