'use strict';
/* ================================================
   Loading  –  animated progress overlay
   ================================================ */
const Loading = (() => {
  let _timer    = null;
  let _progress = 0;

  const overlay  = () => document.getElementById('loading-overlay');
  const msgEl    = () => document.getElementById('loading-msg');
  const barEl    = () => document.getElementById('loading-bar');

  function _setBar(pct) {
    barEl().style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  /* Show overlay, simulate progress up to ~88% while waiting */
  function show(msg = 'Loading...') {
    msgEl().textContent = msg;
    _progress = 0;
    _setBar(0);
    overlay().removeAttribute('hidden');

    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
      _progress += Math.random() * 14;
      if (_progress > 88) _progress = 88;
      _setBar(_progress);
    }, 180);
  }

  /* Jump to 100% then hide */
  function hide() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    _setBar(100);
    setTimeout(() => {
      overlay().setAttribute('hidden', '');
      _progress = 0;
      _setBar(0);
    }, 280);
  }

  return { show, hide };
})();
