/**
 * ui.js — UI ヘルパー：カード描画・モーダル・ページ遷移
 */
const UI = (() => {

  /* ── Confirm dialog ─────────────────────────────────── */
  function confirm(message, title = '確認', danger = false) {
    return new Promise((resolve) => {
      const dialog = document.getElementById('confirm-dialog');
      const titleEl = document.getElementById('confirm-title');
      const msgEl   = document.getElementById('confirm-message');
      const okBtn   = document.getElementById('confirm-ok');
      const cnlBtn  = document.getElementById('confirm-cancel');
      if (!dialog || !okBtn || !cnlBtn) { resolve(false); return; }
      titleEl.textContent = title;
      msgEl.textContent   = message;
      okBtn.className     = danger ? 'btn btn-danger' : 'btn btn-primary';
      dialog.classList.remove('hidden');

      function cleanup() {
        dialog.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        cnlBtn.removeEventListener('click', onCancel);
      }
      function onOk()     { cleanup(); resolve(true);  }
      function onCancel() { cleanup(); resolve(false); }
      okBtn.addEventListener('click',  onOk);
      cnlBtn.addEventListener('click', onCancel);
    });
  }

  /* ── Page navigation ────────────────────────────────── */
  function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    document.getElementById(`${pageId}-page`)?.classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach(n =>
      n.classList.toggle('active', n.dataset.page === pageId)
    );
  }

  /* ── Sidebar toggle ─────────────────────────────────── */
  function toggleSidebar(force) {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar) return;
    const isOpen  = sidebar.classList.contains('sidebar-open');
    const willOpen = force !== undefined ? force : !isOpen;
    sidebar.classList.toggle('sidebar-open', willOpen);
    overlay?.classList.toggle('hidden', !willOpen);
    document.body.classList.toggle('sidebar-is-open', willOpen);
  }

  /* ── Helpers ────────────────────────────────────────── */
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getDiffTextColor(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return (0.299*r + 0.587*g + 0.114*b) / 255 > 0.6 ? '#1A1A2E' : '#FFFFFF';
  }

  function diffBadgeHtml(difficulty) {
    const d = CONFIG.DIFFICULTIES[(difficulty||'').toUpperCase()];
    if (!d) return `<span class="diff-badge diff-unknown">${escHtml(difficulty)||'?'}</span>`;
    const tc = getDiffTextColor(d.color);
    return `<span class="diff-badge" style="background:${d.color};color:${tc}">${d.name}</span>`;
  }

  /* ── Result card ────────────────────────────────────── */
  function renderCard(entry, mode) {
    const diff = CONFIG.DIFFICULTIES[(entry.difficulty||'').toUpperCase()] || { color:'#AAAACC', name:'?' };
    const { missAP, missAPTournament, missFC, isAP, isFC } = SortFilter.computeMiss(entry);

    // Build mode-specific miss rows (primary row first, no duplication)
    let missRows;
    if (mode === 'ap') {
      missRows = [
        { key:'AP',   val: isAP ? 'AP達成'  : missAP,            cls: isAP  ? 'miss-cleared' : '' },
        { key:'大会',  val: missAPTournament,                       cls: 'miss-sub' },
        { key:'FC',   val: isFC ? 'FC達成'  : missFC,            cls: isFC  ? 'miss-sub miss-cleared' : 'miss-sub' },
      ];
    } else if (mode === 'ap-tournament') {
      const tClr = missAPTournament === 0;
      missRows = [
        { key:'大会',  val: tClr ? 'AP達成' : missAPTournament,   cls: tClr  ? 'miss-cleared' : '' },
        { key:'AP',   val: isAP ? 'AP達成'  : missAP,            cls: isAP  ? 'miss-sub miss-cleared' : 'miss-sub' },
        { key:'FC',   val: isFC ? 'FC達成'  : missFC,            cls: isFC  ? 'miss-sub miss-cleared' : 'miss-sub' },
      ];
    } else { // fc
      missRows = [
        { key:'FC',   val: isFC ? 'FC達成'  : missFC,            cls: isFC  ? 'miss-cleared' : '' },
        { key:'AP',   val: isAP ? 'AP達成'  : missAP,            cls: isAP  ? 'miss-sub miss-cleared' : 'miss-sub' },
        { key:'大会',  val: missAPTournament,                       cls: 'miss-sub' },
      ];
    }

    const el = document.createElement('div');
    el.className = 'result-card';
    el.dataset.id = entry.id;
    el.style.setProperty('--diff-color', diff.color);

    el.innerHTML = `
      <div class="card-img-col">
        ${entry.imageData
          ? `<img class="card-img" src="${entry.imageData}" alt="${escHtml(entry.title)}" loading="lazy">`
          : `<div class="card-img-placeholder"><span class="material-symbols-outlined">image_not_supported</span></div>`}
        ${isAP ? '<span class="card-ach card-ach-ap">AP</span>' : ''}
        ${(isFC && !isAP) ? '<span class="card-ach card-ach-fc">FC</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-meta">
          ${diffBadgeHtml(entry.difficulty)}
          <span class="card-level">Lv.${entry.level ?? '?'}</span>
        </div>
        <h3 class="card-title">${escHtml(entry.title) || '不明'}</h3>
        <div class="card-miss-list">
          ${missRows.map(r => `<div class="miss-item ${r.cls}">
            <span class="miss-key">${r.key}</span>
            <span class="miss-val">${r.val}</span>
          </div>`).join('')}
        </div>
        <div class="card-actions">
          <button class="card-btn" data-action="detail" title="詳細">
            <span class="material-symbols-outlined">open_in_full</span>
          </button>
          <button class="card-btn" data-action="edit" title="編集">
            <span class="material-symbols-outlined">edit</span>
          </button>
          <button class="card-btn card-btn-del" data-action="delete" title="削除">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>
      </div>`;

    el.querySelector('.card-img-col').addEventListener('click', () => openDetailModal(entry));
    el.querySelector('[data-action="detail"]').addEventListener('click', () => openDetailModal(entry));
    el.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation(); openEditModal(entry);
    });
    el.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirm(`「${entry.title}」をゴミ箱に移動しますか？`, '削除の確認', true)) {
        await Trash.moveToTrash(entry.id);
        Notification.toast('ゴミ箱に移動しました', 'info');
        if (window.App) App.refreshGallery();
      }
    });
    return el;
  }

  /* ── Detail modal ───────────────────────────────────── */
  function openDetailModal(entry) {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    const { missAP, missAPTournament, missFC, isAP, isFC } = SortFilter.computeMiss(entry);

    modal.querySelector('#detail-title').textContent = entry.title || '不明';
    const imgEl = modal.querySelector('#detail-image');
    if (imgEl) { imgEl.src = entry.imageData || ''; imgEl.alt = entry.title || ''; }

    const infoEl = modal.querySelector('.detail-info');
    if (infoEl) {
      infoEl.innerHTML = `
        <div class="detail-header-row">
          ${diffBadgeHtml(entry.difficulty)}
          <span class="detail-level">Lv.${entry.level ?? '?'}</span>
          ${isAP ? '<span class="card-ach card-ach-ap">AP達成</span>' : ''}
          ${isFC ? '<span class="card-ach card-ach-fc">FC達成</span>' : ''}
        </div>
        <h2 class="detail-song-title">${escHtml(entry.title || '不明')}</h2>
        ${entry.pronunciation ? `<p class="detail-pronunciation">${escHtml(entry.pronunciation)}</p>` : ''}
        <div class="detail-stats-grid">
          ${[['PERFECT',entry.perfect],['GREAT',entry.great],['GOOD',entry.good],
             ['BAD',entry.bad],['MISS',entry.miss],['COMBO',entry.combo]]
            .map(([k,v]) => `<div class="dstat"><span class="dstat-key">${k}</span><span class="dstat-val">${v ?? '-'}</span></div>`)
            .join('')}
        </div>
        <div class="detail-miss-section">
          <h4>ミス数</h4>
          <div class="detail-miss-row ${isAP ? 'miss-cleared' : ''}">
            <span>AP基準</span><strong>${isAP ? 'AP達成 (0)' : missAP}</strong>
          </div>
          <div class="detail-miss-row">
            <span>大会基準</span><strong>${missAPTournament}</strong>
          </div>
          <div class="detail-miss-row ${isFC ? 'miss-cleared' : ''}">
            <span>FC基準</span><strong>${isFC ? 'FC達成 (0)' : missFC}</strong>
          </div>
        </div>
        <div class="detail-meta-row">
          <span class="material-symbols-outlined">calendar_today</span>
          ${new Date(entry.addedAt).toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric'})} 追加
        </div>
        <div class="detail-footer-actions">
          <button class="btn btn-outline" id="detail-edit-btn">
            <span class="material-symbols-outlined">edit</span> 編集
          </button>
        </div>`;

      infoEl.querySelector('#detail-edit-btn')?.addEventListener('click', () => {
        modal.classList.add('hidden');
        openEditModal(entry);
      });
    }
    modal.classList.remove('hidden');
  }

  /* ── Edit modal ─────────────────────────────────────── */
  function openEditModal(entry) {
    const modal = document.getElementById('edit-modal');
    const form  = document.getElementById('edit-form');
    if (!modal || !form) return;

    form.innerHTML = `
      <input type="hidden" name="id" value="${escHtml(entry.id)}">
      <div class="form-group">
        <label class="form-label">タイトル</label>
        <input type="text" class="form-control" name="title" value="${escHtml(entry.title||'')}">
      </div>
      <div class="form-group">
        <label class="form-label">読み方（ひらがな）</label>
        <input type="text" class="form-control" name="pronunciation" value="${escHtml(entry.pronunciation||'')}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">難易度</label>
          <select class="form-control" name="difficulty">
            ${CONFIG.DIFFICULTY_ORDER.map(d =>
              `<option value="${d}" ${d === entry.difficulty ? 'selected' : ''}>${d}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">レベル</label>
          <input type="number" class="form-control" name="level" value="${entry.level ?? ''}" min="1" max="50">
        </div>
      </div>
      <p class="form-label mb-4">判定内訳</p>
      <div class="form-row form-row-5">
        ${['perfect','great','good','bad','miss'].map(k => `
          <div class="form-group">
            <label class="form-label">${k.toUpperCase()}</label>
            <input type="number" class="form-control" name="${k}" value="${entry[k] ?? 0}" min="0">
          </div>`).join('')}
      </div>
      <div class="form-group">
        <label class="form-label">COMBO</label>
        <input type="number" class="form-control" name="combo" value="${entry.combo ?? 0}" min="0">
      </div>`;

    modal.classList.remove('hidden');
  }

  return { confirm, showPage, toggleSidebar, renderCard,
           openDetailModal, openEditModal, getDiffTextColor, diffBadgeHtml, escHtml };
})();
