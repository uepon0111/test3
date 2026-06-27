/**
 * notification.js — トースト通知・自己ベスト検出
 */
const Notification = (() => {
  let _container = null;

  function getContainer() {
    if (!_container) _container = document.getElementById('toast-container');
    return _container;
  }

  /** Show toast notification */
  function toast(message, type = 'info', duration = 3500) {
    const c    = getContainer();
    const el   = document.createElement('div');
    el.className = `toast toast-${type}`;

    const icons = { info: 'info', success: 'check_circle', warning: 'warning', error: 'error' };
    el.innerHTML = `
      <span class="material-symbols-outlined">${icons[type] || 'info'}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close icon-btn" aria-label="閉じる">
        <span class="material-symbols-outlined">close</span>
      </button>
    `;

    el.querySelector('.toast-close').addEventListener('click', () => dismiss(el));
    c.appendChild(el);

    // Animate in
    requestAnimationFrame(() => el.classList.add('toast-show'));

    if (duration > 0) {
      setTimeout(() => dismiss(el), duration);
    }
    return el;
  }

  function dismiss(el) {
    el.classList.remove('toast-show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }

  /** Check for personal best and show notification */
  async function checkPersonalBest(newEntry, existingResults) {
    const { computeMiss } = SortFilter;
    const newMiss = computeMiss(newEntry);

    // Find existing bests for same song + difficulty
    const sameSong = existingResults.filter(
      r => r.musicId === newEntry.musicId && r.difficulty === newEntry.difficulty && r.id !== newEntry.id
    );

    if (sameSong.length === 0) return; // No prior entries

    const improvements = [];

    const prevBestAP  = Math.min(...sameSong.map(r => computeMiss(r).missAP));
    const prevBestAPT = Math.min(...sameSong.map(r => computeMiss(r).missAPTournament));
    const prevBestFC  = Math.min(...sameSong.map(r => computeMiss(r).missFC));

    if (newMiss.missAP           < prevBestAP)  improvements.push(`AP基準 ${prevBestAP} → ${newMiss.missAP}`);
    if (newMiss.missAPTournament < prevBestAPT)  improvements.push(`大会基準 ${prevBestAPT} → ${newMiss.missAPTournament}`);
    if (newMiss.missFC           < prevBestFC)   improvements.push(`FC基準 ${prevBestFC} → ${newMiss.missFC}`);

    if (improvements.length === 0) return;

    showPBNotification(newEntry.title, newEntry.difficulty, improvements);
  }

  /** Show personal best banner */
  function showPBNotification(title, difficulty, improvements) {
    const banner  = document.getElementById('pb-notification');
    const content = document.getElementById('pb-notification-content');
    if (!banner || !content) return;

    const color = CONFIG.DIFFICULTIES[difficulty?.toUpperCase()]?.color || '#7B6CF7';
    const tc    = UI.getDiffTextColor(color);
    content.innerHTML = `
      <div class="pb-song">
        <span class="diff-badge" style="background:${color};color:${tc}">${UI.escHtml(difficulty || '')}</span>
        <strong>${UI.escHtml(title || '')}</strong>
      </div>
      <ul class="pb-improvements">
        ${improvements.map(i => `<li><span class="material-symbols-outlined">trending_down</span>${UI.escHtml(i)}</li>`).join('')}
      </ul>`;

    // Show with CSS animation (re-trigger by removing+adding hidden)
    banner.classList.add('hidden');
    banner.style.animation = 'none';
    requestAnimationFrame(() => {
      banner.style.animation = '';
      banner.classList.remove('hidden');
    });

    // Auto-dismiss after 6s with slide-out
    clearTimeout(banner._dismissTimer);
    banner._dismissTimer = setTimeout(() => {
      banner.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      banner.style.opacity    = '0';
      banner.style.transform  = 'translateX(110%)';
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.style.transition = '';
        banner.style.opacity    = '';
        banner.style.transform  = '';
      }, 380);
    }, 5800);
  }

  return { toast, checkPersonalBest };
})();
