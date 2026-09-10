(() => {
  const root = document.querySelector('[data-login-identity-auth]');
  const auth = window.KredRunAuth;
  const client = window.kredrunSupabase;
  if (!root || !auth || !client) return;

  const form = root.querySelector('[data-new-form]');
  if (!form || form.elements.email) return;

  const phoneField = form.elements.phone?.closest('.auth-field');
  const emailField = document.createElement('div');
  emailField.className = 'auth-field';
  emailField.innerHTML = '<label>Email address</label><input name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@example.com" required>';
  phoneField?.insertAdjacentElement('afterend', emailField);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const feedback = root.querySelector('[data-feedback]');
    const button = form.querySelector('button[type="submit"]');
    const show = message => {
      if (!feedback) return;
      feedback.textContent = message;
      feedback.className = `auth-feedback${message ? ' show error' : ''}`;
    };

    const idNumber = String(root.querySelector('[data-id-form] input[name="idNumber"]')?.value || '').replace(/\D/g, '');
    const firstName = form.elements.firstName.value.trim();
    const lastName = form.elements.lastName.value.trim();
    const phone = form.elements.phone.value.trim();
    const email = form.elements.email.value.trim().toLowerCase();
    const password = form.elements.password.value;

    if (!auth.validSaId(idNumber)) return show('Enter a valid South African ID number.');
    if (firstName.length < 2) return show('Enter your first name.');
    if (lastName.length < 2) return show('Enter your surname.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return show('Enter a valid email address.');
    if (password.length < 8) return show('Use at least 8 characters for your password.');

    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Continuing…';
    show('');

    try {
      const data = await auth.identityRequest({ action: 'register_password', idNumber, firstName, lastName, phone, password });
      if (!data.session?.access_token || !data.session?.refresh_token) throw new Error('We could not continue. Please try again.');
      const { error } = await client.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
      if (error) throw error;
      await auth.completePendingProfile();
      const { data: userData } = await client.auth.getUser();
      if (userData?.user?.id) {
        const { error: emailSaveError } = await client.from('customer_profiles').update({ email, updated_at: new Date().toISOString() }).eq('id', userData.user.id);
        if (emailSaveError) console.warn('Account created, but the contact email could not be saved.', emailSaveError);
      }
      const params = new URLSearchParams(location.search);
      location.href = auth.safeNext(params.get('next'), 'account.html');
    } catch (error) {
      show(error.message || 'We could not create your account. Please try again.');
      button.disabled = false;
      button.textContent = original;
    }
  }, true);
})();
