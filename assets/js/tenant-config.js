/*
 * KredRun tenant deployment configuration
 * ------------------------------------------------------------
 * This is the ONE file we change for a lender deployment.
 *
 * deliveryMode:
 *   bundled       = KredRun core + one of our lending websites
 *   portal_only   = Admin + Client Portal; lender keeps their own website
 *
 * website.templateId selects a website pack. Website packs can have totally
 * different sections, copy and layout. The brand below still flows into the
 * Admin and Client Portal so the whole product belongs to the lender.
 */
(() => {
  window.KREDRUN_TENANT = Object.freeze({
    tenantId: 'kredrun-demo',
    deliveryMode: 'bundled',

    website: {
      templateId: 'clean-credit',
      externalUrl: '',
      applyUrl: '/apply.html',
      loginUrl: '/login.html',
      accountUrl: '/account.html'
    },

    brand: {
      name: 'KredRun',
      wordmark: { prefix: 'Kred', accent: 'Run' },
      mark: 'K',
      logoUrl: '',
      faviconUrl: '',
      tagline: 'Fast. Simple. Responsible.',
      strapline: 'Clear online credit for South Africans.',
      colors: {
        primary: '#0876d8',
        primaryStrong: '#0558ad',
        secondary: '#18b5d6',
        accent: '#56c51f',
        accentStrong: '#38a814',
        navy: '#053963',
        ink: '#0c2947',
        background: '#f3f8fc',
        muted: '#668098',
        line: '#d9e6f0',
        danger: '#c6424f',
        warning: '#d8891d',
        success: '#22955f'
      }
    }
  });
})();
