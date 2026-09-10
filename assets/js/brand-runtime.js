/* Applies the central white-label brand config to static and generated UI. */
(() => {
  const brand = window.KREDRUN_BRAND;
  if (!brand) return;

  const setMark = node => {
    if (!node) return;
    node.dataset.brandMark = '';
    if (brand.logoUrl) {
      node.textContent = '';
      const img = document.createElement('img');
      img.src = brand.logoUrl;
      img.alt = '';
      img.decoding = 'async';
      node.appendChild(img);
    } else {
      node.textContent = brand.mark || String(brand.name || 'K').charAt(0).toUpperCase();
    }
  };

  const setWordmark = node => {
    if (!node) return;
    const prefix = brand.wordmark?.prefix || brand.name;
    const accent = brand.wordmark?.accent || '';
    node.dataset.brandWordmark = '';
    node.innerHTML = `${prefix}${accent ? `<em>${accent}</em>` : ''}`;
  };

  document.querySelectorAll('[data-brand-name]').forEach(node => { node.textContent = brand.name; });
  document.querySelectorAll('[data-brand-mark]').forEach(setMark);
  document.querySelectorAll('[data-brand-wordmark]').forEach(setWordmark);

  document.querySelectorAll('.brand').forEach(node => {
    setMark(node.querySelector('.brand-mark'));
    setWordmark(node.querySelector('span:last-child'));
    node.setAttribute('aria-label', `${brand.name} home`);
  });

  document.querySelectorAll('.admin-brand').forEach(node => {
    setMark(node.querySelector(':scope > span'));
    const label = node.querySelector('strong');
    if (label) label.textContent = brand.name;
    node.setAttribute('aria-label', `${brand.name} administration home`);
  });
  document.querySelectorAll('.loading-mark,.account-boot-mark').forEach(setMark);
  document.querySelectorAll('.mini-brand').forEach(setWordmark);

  document.querySelectorAll('.client-header > .brand').forEach(node => {
    if (!node.querySelector('.brand-mark')) node.textContent = brand.name;
  });

  const topStrip = document.querySelector('.top-strip .container');
  if (topStrip) {
    const strong = topStrip.querySelector('strong');
    const span = topStrip.querySelector('span');
    if (strong && brand.tagline) strong.textContent = brand.tagline;
    if (span && brand.strapline) span.textContent = brand.strapline;
  }

  // Allow template copy to opt in to safe brand-name replacement without tying
  // the core platform to any one landing page structure.
  document.querySelectorAll('[data-brand-replace]').forEach(node => {
    node.textContent = String(node.textContent || '').replaceAll('KredRun', brand.name);
  });
  document.querySelectorAll('.home-eyebrow').forEach(node => {
    if ((node.textContent || '').includes('KredRun')) node.textContent = node.textContent.replaceAll('KredRun', brand.name);
  });

  document.querySelectorAll('.footer-bottom span:first-child').forEach(node => {
    if (/^©/.test(node.textContent || '')) node.textContent = `© ${new Date().getFullYear()} ${brand.name}.`;
  });

  if (document.title.includes('KredRun')) document.title = document.title.replaceAll('KredRun', brand.name);
})();
