// Verge public preview notice. This file is included in the corresponding source.
(() => {
  const mount = () => {
    if (document.getElementById('verge-preview-notice')) return;
    const notice = document.createElement('div');
    notice.id = 'verge-preview-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = 'Preview: address queries and performance are still being qualified. Verify critical balances independently.';
    Object.assign(notice.style, {
      position: 'sticky', top: '0', zIndex: '10000',
      padding: '10px 16px', textAlign: 'center',
      background: '#603b04', color: '#fff4cf',
      font: '600 14px/1.4 system-ui, sans-serif',
    });
    document.body.insertBefore(notice, document.body.firstChild);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
