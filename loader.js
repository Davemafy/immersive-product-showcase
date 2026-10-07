const COUNT = 78;
const status = document.getElementById('boot-status');
let loaded = 0;

try {
  const parts = await Promise.all(
    Array.from({ length: COUNT }, async (_, i) => {
      const id = String(i).padStart(3, '0');
      const response = await fetch('/engine/chunk-' + id + '.part', { cache: 'force-cache' });
      if (!response.ok) throw new Error('engine chunk ' + id + ' returned ' + response.status);
      const text = await response.text();
      loaded += 1;
      if (status) status.textContent = 'INITIALIZING WORLD ' + loaded + '/' + COUNT;
      return text;
    })
  );

  const source = parts.join('');
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  await import(moduleUrl);
  URL.revokeObjectURL(moduleUrl);
  status?.remove();
} catch (error) {
  console.error('[atlas-loader]', error);
  if (status) {
    status.classList.add('error');
    status.textContent = 'WORLD FAILED TO INITIALIZE';
  }
}
