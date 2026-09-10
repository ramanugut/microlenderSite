/*
 * KredRun white-label brand bridge
 * ------------------------------------------------------------
 * Reads the lender brand from assets/js/tenant-config.js and exposes a
 * stable window.KREDRUN_BRAND object used by Website, Client Portal and Admin.
 */
(() => {
  const DEFAULT_BRAND = {
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
  };

  const tenantBrand = window.KREDRUN_TENANT?.brand || {};
  const BRAND = {
    ...DEFAULT_BRAND,
    ...tenantBrand,
    wordmark: { ...DEFAULT_BRAND.wordmark, ...(tenantBrand.wordmark || {}) },
    colors: { ...DEFAULT_BRAND.colors, ...(tenantBrand.colors || {}) }
  };

  const rgb = hex => {
    const clean = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(clean)) return '';
    return `${parseInt(clean.slice(0, 2), 16)}, ${parseInt(clean.slice(2, 4), 16)}, ${parseInt(clean.slice(4, 6), 16)}`;
  };

  const root = document.documentElement;
  const c = BRAND.colors;
  const tokens = {
    '--brand-primary': c.primary,
    '--brand-primary-strong': c.primaryStrong,
    '--brand-secondary': c.secondary,
    '--brand-accent': c.accent,
    '--brand-accent-strong': c.accentStrong,
    '--brand-navy': c.navy,
    '--brand-ink': c.ink,
    '--brand-background': c.background,
    '--brand-muted': c.muted,
    '--brand-line': c.line,
    '--brand-danger': c.danger,
    '--brand-warning': c.warning,
    '--brand-success': c.success,
    '--brand-primary-rgb': rgb(c.primary),
    '--brand-accent-rgb': rgb(c.accent),
    '--brand-navy-rgb': rgb(c.navy)
  };

  Object.entries(tokens).forEach(([key, value]) => value && root.style.setProperty(key, value));
  root.dataset.brand = BRAND.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  root.dataset.deliveryMode = window.KREDRUN_TENANT?.deliveryMode || 'bundled';
  root.dataset.websiteTemplate = window.KREDRUN_TENANT?.website?.templateId || 'clean-credit';

  if (BRAND.faviconUrl) {
    let icon = document.querySelector('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.appendChild(icon);
    }
    icon.href = BRAND.faviconUrl;
  }

  window.KREDRUN_BRAND = Object.freeze(BRAND);
})();
