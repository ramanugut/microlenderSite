(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('stay') === '1') return;
  params.set('stay', '1');
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', nextUrl);
})();
