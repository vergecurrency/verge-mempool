// Verge public API navigation. This file is included in the corresponding source.
(() => {
  const mount = () => {
    document.getElementById('verge-preview-notice')?.remove();
    if (document.getElementById('verge-api-link')) return;
    const apiLink = document.createElement('a');
    apiLink.id = 'verge-api-link';
    apiLink.href = '/api-docs.html';
    apiLink.textContent = 'API reference';
    Object.assign(apiLink.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '10000',
      padding: '9px 13px', borderRadius: '999px', background: '#124b68',
      color: '#fff', font: '600 14px/1.4 system-ui, sans-serif',
      textDecoration: 'none', boxShadow: '0 2px 8px #0008',
    });
    document.body.appendChild(apiLink);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
