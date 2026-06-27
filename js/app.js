/**
 * app.js — アプリケーション エントリポイント
 */
const App = (() => {
  let _vs     = null;
  let _mode   = 'ap';
  let _sort   = 'name';
  let _asc    = true;
  let _disp   = 'all'; // 'all' | 'best'
  let _allResults = [];

  const _filters = {
    search: '', difficulties: [], level: '', missMin: '', missMax: '',
    achievedAP: false, achievedFC: false,
  };

  /* ── Init ───────────────────────────────────────────── */
  async function init() {
    try {
      await DB.open();
    } catch(e) {
      console.error('DB open failed:', e);
    }

    // Handle OAuth callback
    if (new URLSearchParams(location.search).has('code')) {
      try {
        await Auth.handleCallback();
        Notification.toast('Google アカウントと連携しました', 'success');
      } catch(e) {
        Notification.toast('ログイン失敗: ' + (e.message || e), 'error');
      }
    }

    // Trash auto-clean (non-blocking)
    Trash.runAutoDelete().catch(()=>{});

    // Pre-fetch music data (non-blocking)
    MusicAPI.getAll().catch(()=>{});

    // Load persisted mode
    _mode = (await DB.getSetting('mode').catch(()=>null)) || 'ap';

    // Show app
    document.getElementById('loading-screen')?.classList.add('hidden');
    document.getElementById('main-app')?.classList.remove('hidden');

    // Init virtual scroll
    const cont = document.getElementById('virtual-scroll-container');
    if (cont) {
      _vs = new VirtualScroll(cont, {
        cardHeight: 230,
        gapY: 12,
        gapX: 12,
        renderItem: (item) => UI.renderCard(item, _mode),
      });
    }

    // Init modules
    Upload.initEvents();
    Settings.initDeviceModalEvents();
    bindGlobalEvents();

    // Sync mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === _mode)
    );

    await refreshGallery().catch(()=>{});
  }

  /* ── Gallery ────────────────────────────────────────── */
  async function refreshGallery() {
    _allResults = await DB.getAllResults();
    applyAndRender();
  }

  function applyAndRender() {
    let items = SortFilter.filterResults(_allResults, _filters, _mode, _disp);
    items = SortFilter.sortResults(items, _sort, _asc, _mode);

    const empty = document.getElementById('empty-state');
    const cont  = document.getElementById('virtual-scroll-container');
    empty?.classList.toggle('hidden', items.length > 0);
    cont?.classList.toggle('hidden',  items.length === 0);

    if (_vs) _vs.setItems(items);
  }

  function setMode(m) {
    _mode = m;
    DB.setSetting('mode', m);
    document.querySelectorAll('.mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === m)
    );
    // Update mode label in sidebar
    document.querySelectorAll('.miss-mode-label').forEach(el => {
      const labels = { ap:'AP基準', 'ap-tournament':'大会基準', fc:'FC基準' };
      el.textContent = labels[m] || 'AP基準';
    });
    applyAndRender();
  }

  /* ── Events ─────────────────────────────────────────── */
  function bindGlobalEvents() {

    /* Mode buttons */
    document.querySelectorAll('.mode-btn').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode))
    );

    /* Sort buttons */
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_sort === btn.dataset.sort) {
          _asc = !_asc;
        } else {
          _sort = btn.dataset.sort;
          _asc  = true;
        }
        document.querySelectorAll('.sort-btn').forEach(b => {
          const active = b === btn;
          b.classList.toggle('active', active);
          const ico = b.querySelector('.sort-icon');
          if (ico) ico.textContent = active
            ? (_asc ? 'arrow_upward' : 'arrow_downward')
            : 'arrow_upward';
        });
        applyAndRender();
      });
    });

    /* Difficulty chips */
    document.querySelectorAll('.diff-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        _filters.difficulties = Array.from(
          document.querySelectorAll('.diff-chip.selected')
        ).map(c => c.dataset.diff);
        applyAndRender();
      });
    });

    /* Search */
    const si = document.getElementById('search-input');
    si?.addEventListener('input', e => { _filters.search = e.target.value; applyAndRender(); });
    document.getElementById('search-clear')?.addEventListener('click', () => {
      if (si) si.value = '';
      _filters.search = '';
      applyAndRender();
    });
    document.getElementById('search-toggle')?.addEventListener('click', () => {
      const sb = document.getElementById('search-bar');
      if (!sb) return;
      const open = sb.classList.toggle('search-open');
      if (open) si?.focus();
    });

    /* Filter checkboxes */
    document.getElementById('filter-ap')?.addEventListener('change', e => {
      _filters.achievedAP = e.target.checked; applyAndRender();
    });
    document.getElementById('filter-fc')?.addEventListener('change', e => {
      _filters.achievedFC = e.target.checked; applyAndRender();
    });

    /* Level / miss range */
    document.getElementById('filter-level')?.addEventListener('input', e => {
      _filters.level = e.target.value; applyAndRender();
    });
    document.getElementById('miss-min')?.addEventListener('input', e => {
      _filters.missMin = e.target.value; applyAndRender();
    });
    document.getElementById('miss-max')?.addEventListener('input', e => {
      _filters.missMax = e.target.value; applyAndRender();
    });

    /* Display mode (all / best) */
    document.querySelectorAll('[name="display-mode"]').forEach(r =>
      r.addEventListener('change', e => { _disp = e.target.value; applyAndRender(); })
    );

    /* Navigation */
    document.querySelectorAll('.nav-item').forEach(item =>
      item.addEventListener('click', e => {
        e.preventDefault();
        const page = item.dataset.page;
        UI.showPage(page);
        if (page === 'trash')    renderTrash();
        if (page === 'settings') Settings.init();
        if (window.innerWidth < 1024) UI.toggleSidebar(false);
      })
    );
    document.getElementById('settings-btn')?.addEventListener('click', () => {
      UI.showPage('settings');
      Settings.init();
    });

    /* Sidebar */
    document.getElementById('menu-toggle')?.addEventListener('click', () => UI.toggleSidebar());
    document.getElementById('sidebar-overlay')?.addEventListener('click', () => UI.toggleSidebar(false));

    /* Upload */
    document.getElementById('upload-btn')?.addEventListener('click', () => Upload.open());

    /* Detail modal close */
    const dModal = document.getElementById('detail-modal');
    dModal?.querySelector('.modal-close')?.addEventListener('click', () => dModal.classList.add('hidden'));
    dModal?.querySelector('.modal-overlay')?.addEventListener('click', () => dModal.classList.add('hidden'));

    /* Edit modal save + close */
    document.getElementById('edit-save-btn')?.addEventListener('click', saveEdit);
    const eModal = document.getElementById('edit-modal');
    eModal?.querySelectorAll('.modal-close, .modal-overlay, [data-dismiss]').forEach(el =>
      el.addEventListener('click', () => eModal.classList.add('hidden'))
    );

    /* Device modal close */
    const devModal = document.getElementById('device-modal');
    devModal?.querySelectorAll('.modal-close, .modal-overlay, [data-dismiss]').forEach(el =>
      el.addEventListener('click', () => devModal.classList.add('hidden'))
    );

    /* PB notification close */
    document.getElementById('pb-close')?.addEventListener('click', () => {
      document.getElementById('pb-notification')?.classList.add('hidden');
    });

    /* Confirm dialog overlay */
    document.querySelector('#confirm-dialog .modal-overlay')?.addEventListener('click', () => {
      document.getElementById('confirm-cancel')?.click();
    });

    /* Filter reset */
    document.getElementById('filter-reset-btn')?.addEventListener('click', () => {
      _filters.search = ''; _filters.difficulties = [];
      _filters.level = ''; _filters.missMin = ''; _filters.missMax = '';
      _filters.achievedAP = false; _filters.achievedFC = false;
      _disp = 'all';

      if (document.getElementById('search-input')) document.getElementById('search-input').value = '';
      if (document.getElementById('filter-level'))  document.getElementById('filter-level').value  = '';
      if (document.getElementById('miss-min'))      document.getElementById('miss-min').value      = '';
      if (document.getElementById('miss-max'))      document.getElementById('miss-max').value      = '';
      document.getElementById('filter-ap')?.removeAttribute('checked');
      document.getElementById('filter-ap') && (document.getElementById('filter-ap').checked = false);
      document.getElementById('filter-fc') && (document.getElementById('filter-fc').checked = false);
      document.querySelectorAll('.diff-chip').forEach(c => c.classList.remove('selected'));
      document.querySelector('[name="display-mode"][value="all"]') &&
        (document.querySelector('[name="display-mode"][value="all"]').checked = true);
      applyAndRender();
    });
  }

  /* ── Edit save ──────────────────────────────────────── */
  async function saveEdit() {
    const form = document.getElementById('edit-form');
    if (!form) return;
    const data = {};
    form.querySelectorAll('[name]').forEach(el => { data[el.name] = el.value; });

    const entry = await DB.getResult(data.id);
    if (!entry) return;

    Object.assign(entry, {
      title:          data.title,
      pronunciation:  data.pronunciation,
      difficulty:     data.difficulty,
      level:          parseInt(data.level)   || 0,
      perfect:        parseInt(data.perfect) || 0,
      great:          parseInt(data.great)   || 0,
      good:           parseInt(data.good)    || 0,
      bad:            parseInt(data.bad)     || 0,
      miss:           parseInt(data.miss)    || 0,
      combo:          parseInt(data.combo)   || 0,
      updatedAt:      new Date().toISOString(),
    });

    await DB.updateResult(entry);
    document.getElementById('edit-modal')?.classList.add('hidden');
    await refreshGallery();
    Notification.toast('情報を更新しました', 'success');
  }

  /* ── Trash page ─────────────────────────────────────── */
  async function renderTrash() {
    const grid    = document.getElementById('trash-grid');
    const emptyEl = document.getElementById('trash-empty');
    if (!grid) return;

    const items = await DB.getAllTrash();
    emptyEl?.classList.toggle('hidden', items.length > 0);

    if (items.length === 0) { grid.innerHTML = ''; return; }

    grid.innerHTML = items.map(item => {
      const diff  = CONFIG.DIFFICULTIES[(item.difficulty||'').toUpperCase()] || {color:'#AAAACC',name:'?'};
      const tc    = UI.getDiffTextColor(diff.color);
      const days  = Trash.daysRemaining(item.deletedAt);
      return `
        <div class="trash-card" data-id="${item.id}">
          <div class="trash-img-col">
            ${item.imageData
              ? `<img class="trash-img" src="${item.imageData}" alt="${UI.escHtml(item.title)}">`
              : `<div class="trash-img-placeholder"><span class="material-symbols-outlined">image_not_supported</span></div>`}
          </div>
          <div class="trash-info">
            <span class="diff-badge" style="background:${diff.color};color:${tc}">${diff.name}</span>
            <h4 class="trash-title">${UI.escHtml(item.title||'不明')}</h4>
            <p class="trash-days-left">あと <strong>${days}</strong> 日で完全削除</p>
            <div class="trash-actions">
              <button class="btn btn-sm btn-outline trash-restore" data-id="${item.id}">
                <span class="material-symbols-outlined">restore_from_trash</span>復元
              </button>
              <button class="btn btn-sm btn-danger trash-delete" data-id="${item.id}">
                <span class="material-symbols-outlined">delete_forever</span>完全削除
              </button>
            </div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.trash-restore').forEach(btn =>
      btn.addEventListener('click', async () => {
        await Trash.restore(btn.dataset.id);
        await renderTrash();
        await refreshGallery();
        Notification.toast('復元しました', 'success');
      })
    );

    grid.querySelectorAll('.trash-delete').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!await UI.confirm('完全に削除しますか？\nこの操作は取り消せません。', '完全削除の確認', true)) return;
        await Trash.permanentlyDelete(btn.dataset.id);
        await renderTrash();
        Notification.toast('完全削除しました', 'info');
      })
    );

    // Empty trash button
    const emptyBtn = document.getElementById('empty-trash-btn');
    const newBtn   = emptyBtn?.cloneNode(true);
    if (emptyBtn && newBtn) {
      emptyBtn.replaceWith(newBtn);
      newBtn.addEventListener('click', async () => {
        if (!await UI.confirm('ゴミ箱を空にしますか？\n全ての画像が完全削除されます。', 'ゴミ箱を空にする', true)) return;
        await Trash.emptyTrash();
        await renderTrash();
        Notification.toast('ゴミ箱を空にしました', 'info');
      });
    }
  }

  return { init, refreshGallery, renderTrash, setMode };
})();

document.addEventListener('DOMContentLoaded', App.init);
