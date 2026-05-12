/**
 * ui.js — UI rendering engine for Sonora
 *
 * Covers:
 *   - VirtualList  (virtual scroll for track lists)
 *   - Playlist panel rendering + sort + search + select mode
 *   - Log page  (overview / graph / calendar)
 *   - Edit page (track grid / tag manager)
 *   - Modal management
 *   - Toast notifications
 *   - Upload drop zone
 *   - Full-player overlay (portrait)
 *   - Mini-player visibility
 */

const UI = (() => {

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let _tracks    = [];   // all tracks from Storage
  let _tags      = [];   // all tags from Storage
  let _playlists = [];   // all playlists

  // Playlist panel
  let _currentPl      = '__all__';  // '__all__' = mylist
  let _sortKey        = 'manual';
  let _sortAsc        = true;
  let _searchQuery    = '';
  let _selectMode     = false;
  let _selectedIds    = new Set();
  let _displayTracks  = [];  // filtered + sorted for current view

  // Edit page
  let _editSortKey  = 'added';
  let _editSortAsc  = true;
  let _editSearch   = '';
  let _editCols     = 4;
  let _editTracks   = [];

  // Log page
  let _logSubTab      = 'log-overview';
  let _overviewPeriod = 'all';   // 'all' | 'year' | 'month' | 'week'
  let _graphCat     = 'total';
  let _graphPeriod  = 'month';
  let _graphRefDate = new Date();  // reference date for graph navigation
  let _calYear      = new Date().getFullYear();
  let _calMonth     = new Date().getMonth();

  // Tag modal state
  let _tagColor     = '#DBEAFE';
  let _tagTextColor = '#1D4ED8';
  let _tagEditId    = null;

  // Track edit
  let _editTrackId      = null;
  let _editThumbData    = null;   // ArrayBuffer of new thumb
  let _editThumbMime    = null;
  let _editCurrentTags  = [];    // tag id list being edited

  // Upload queue
  let _uploadQueue  = [];  // { file, title, artist, duration }

  // Pending action for confirm modal
  let _confirmCallback = null;

  // Track targeted for single actions
  let _actionTrackId = null;
  let _addToPl_trackIds = [];

  /* ─────────────────────────────────────────
     VIRTUAL LIST
  ───────────────────────────────────────── */
  class VirtualList {
    constructor(options) {
      this.outer    = options.outer;
      this.inner    = options.inner;
      this.viewport = options.viewport;
      this.itemH    = options.itemH || 58;
      this.buffer   = options.buffer || 8;  // larger buffer prevents bottom cutoff
      this.renderFn = options.renderFn;
      this._items   = [];
      this._raf     = null;

      this.outer.addEventListener('scroll', () => this._onScroll(), { passive: true });

      // Recalculate when container is resized (e.g. orientation change)
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this._onScroll());
        this._ro.observe(this.outer);
      }
    }

    setItems(items) {
      this._items = items;
      // Total height = items * itemH  (+1px prevents sub-pixel rounding gap at bottom)
      this.inner.style.height = (items.length * this.itemH + 1) + 'px';
      this._render();
    }

    _onScroll() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
    }

    _render() {
      const scrollTop = this.outer.scrollTop;
      const viewH     = this.outer.clientHeight || this.outer.offsetHeight;
      if (!viewH) return;  // container not yet laid out

      const start = Math.max(0, Math.floor(scrollTop / this.itemH) - this.buffer);
      // Always render at least to the last item visible + buffer
      const end   = Math.min(
        this._items.length,
        Math.ceil((scrollTop + viewH) / this.itemH) + this.buffer
      );

      this.viewport.style.top = (start * this.itemH) + 'px';

      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const el = this.renderFn(this._items[i], i);
        el.style.height    = this.itemH + 'px';
        el.style.overflow  = 'hidden';  // prevent content exceeding fixed row height
        frag.appendChild(el);
      }
      this.viewport.innerHTML = '';
      this.viewport.appendChild(frag);
    }

    scrollToIndex(idx) {
      this.outer.scrollTop = idx * this.itemH;
    }

    refresh() { this._render(); }
  }

  let _playlistVL = null;

  function _initVirtualList() {
    _playlistVL = new VirtualList({
      outer:    document.getElementById('pl-scroll'),
      inner:    document.getElementById('pl-inner'),
      viewport: document.getElementById('pl-viewport'),
      itemH:    58,
      buffer:   6,
      renderFn: _renderTrackItem,
    });
  }

  /* ─────────────────────────────────────────
     TRACK ITEM RENDERER
  ───────────────────────────────────────── */
  function _renderTrackItem(track, idx) {
    const div = document.createElement('div');
    const isPlaying  = Player.getCurrentTrackId() === track.id;
    const isSelected = _selectedIds.has(track.id);
    const isManual   = _sortKey === 'manual';
    const isFirst    = idx === 0;
    const isLast     = idx === _displayTracks.length - 1;

    div.className = 'track-item' +
      (isPlaying  ? ' playing'  : '') +
      (isSelected ? ' selected' : '') +
      (_selectMode ? ' select-mode' : '');
    div.dataset.id = track.id;

    // Thumbnail
    const thumbHtml = track._thumbUrl
      ? `<img src="${track._thumbUrl}" style="width:100%;height:100%;object-fit:cover">`
      : '<i class="fa-solid fa-music"></i>';

    // Tag dots
    const tagDots = (track.tags || []).map(tagId => {
      const tag = _tags.find(t => t.id === tagId);
      if (!tag) return '';
      return `<span class="tag-dot" style="background:${tag.color}" title="${_esc(tag.name)}"></span>`;
    }).join('');

    // Manual order arrows (only in manual sort mode)
    const reorderHtml = isManual ? `
      <div class="track-reorder-btns">
        <button class="track-reorder-btn" title="上へ" onclick="UI._moveTrack('${track.id}',-1,event)" ${isFirst ? 'disabled' : ''}>
          <i class="fa-solid fa-chevron-up"></i>
        </button>
        <button class="track-reorder-btn" title="下へ" onclick="UI._moveTrack('${track.id}',1,event)" ${isLast ? 'disabled' : ''}>
          <i class="fa-solid fa-chevron-down"></i>
        </button>
      </div>` : '';

    // Number / wave
    const numHtml = `
      <div class="track-num">
        <span class="track-num-txt">${idx + 1}</span>
        <div class="playing-wave">
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
          <div class="wave-bar"></div>
        </div>
      </div>`;

    // Duration
    const dur = _fmtDur(track.duration || 0);

    div.innerHTML = `
      <div class="track-checkbox ${isSelected ? 'checked' : ''}" onclick="UI._toggleSelect('${track.id}',event)"></div>
      ${reorderHtml}
      ${numHtml}
      <div class="track-thumb">${thumbHtml}</div>
      <div class="track-meta">
        <div class="track-name">${_esc(track.title)}</div>
        <div class="track-artist-row">${_esc(track.artist)}</div>
        <div class="track-tags-row">${tagDots}</div>
      </div>
      <div class="track-dur">${dur}</div>
      <div class="track-actions">
        <button class="track-act-btn" title="プレイリストに追加" onclick="UI._openAddToPl('${track.id}',event)">
          <i class="fa-solid fa-plus"></i>
        </button>
        <button class="track-act-btn" title="情報を編集" onclick="UI.openEditTrackModal('${track.id}',event)">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="track-act-btn" title="削除" onclick="UI._confirmDeleteTrack('${track.id}',event)" style="color:var(--danger)">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>`;

    // Click to play (not on action buttons)
    div.addEventListener('click', e => {
      if (e.target.closest('.track-actions') ||
          e.target.closest('.track-checkbox') ||
          e.target.closest('.track-reorder-btns')) return;
      if (_selectMode) { _toggleSelect(track.id, e); return; }
      _playTrack(track.id);
    });

    return div;
  }

  /* ─────────────────────────────────────────
     LOAD DATA & THUMBNAILS
  ───────────────────────────────────────── */
  async function loadData() {
    [_tracks, _tags, _playlists] = await Promise.all([
      Storage.getTracks(),
      Storage.getTags(),
      Storage.getPlaylists(),
    ]);
    // Attach cached thumb URLs
    await _attachThumbUrls(_tracks);
  }

  async function _attachThumbUrls(tracks) {
    await Promise.all(tracks.map(async t => {
      if (t.thumbKey) {
        t._thumbUrl = await Storage.getBlobUrl(t.thumbKey).catch(() => null);
      } else {
        t._thumbUrl = null;
      }
    }));
  }

  /* ─────────────────────────────────────────
     PLAYLIST PANEL
  ───────────────────────────────────────── */
  function renderPlaylistTabs() {
    const row = document.getElementById('pl-tabs-row');
    if (!row) return;
    const allBtn = `<button class="pl-tab ${_currentPl === '__all__' ? 'active' : ''}"
      onclick="UI.switchPlaylist('__all__')">マイリスト</button>`;
    const plBtns = _playlists.map(pl =>
      `<button class="pl-tab ${_currentPl === pl.id ? 'active' : ''}"
        onclick="UI.switchPlaylist('${pl.id}')">${_esc(pl.name)}</button>`
    ).join('');
    row.innerHTML = allBtn + plBtns;
  }

  function switchPlaylist(id) {
    _currentPl = id;
    renderPlaylistTabs();
    applySort();
  }

  function _getPlaylistTracks() {
    if (_currentPl === '__all__') return [..._tracks];
    const pl = _playlists.find(p => p.id === _currentPl);
    if (!pl) return [];
    return pl.trackIds.map(id => _tracks.find(t => t.id === id)).filter(Boolean);
  }

  function applySort() {
    let list = _getPlaylistTracks();

    // Search filter
    if (_searchQuery.trim()) {
      const q = _searchQuery.toLowerCase();
      list = list.filter(t =>
        (t.title  || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q) ||
        (t.releaseDate || '').includes(q) ||
        (t.tags || []).some(tagId => {
          const tag = _tags.find(g => g.id === tagId);
          return tag && tag.name.toLowerCase().includes(q);
        })
      );
    }

    // Sort
    const dir = _sortAsc ? 1 : -1;
    switch (_sortKey) {
      case 'manual':
        list.sort((a, b) => dir * ((a.manualOrder || 0) - (b.manualOrder || 0)));
        break;
      case 'added':
        list.sort((a, b) => dir * ((a.dateAdded || 0) - (b.dateAdded || 0)));
        break;
      case 'title':
        list.sort((a, b) => dir * (a.title || '').localeCompare(b.title || '', 'ja'));
        break;
      case 'artist':
        list.sort((a, b) => dir * (a.artist || '').localeCompare(b.artist || '', 'ja'));
        break;
      case 'date':
        list.sort((a, b) => dir * ((a.releaseDate || '') < (b.releaseDate || '') ? -1 : 1));
        break;
    }

    _displayTracks = list;
    _updateTrackCount();
    _playlistVL && _playlistVL.setItems(_displayTracks);

    // Show/hide reorder buttons based on sort mode
    const sortSel = document.getElementById('pl-sort-select');
    if (sortSel) sortSel.value = _sortKey;
  }

  function toggleSortDir() {
    _sortAsc = !_sortAsc;
    const btn = document.getElementById('pl-sort-dir');
    if (btn) {
      const icon = btn.querySelector('i');
      icon.className = _sortAsc ? 'fa-solid fa-arrow-up-a-z' : 'fa-solid fa-arrow-down-z-a';
    }
    applySort();
  }

  function _updateTrackCount() {
    const el = document.getElementById('pl-track-count');
    if (el) el.textContent = _displayTracks.length + '曲';
  }

  /* ─────────────────────────────────────────
     SEARCH
  ───────────────────────────────────────── */
  function initSearch() {
    const input = document.getElementById('pl-search-input');
    if (!input) return;
    let timer;
    input.addEventListener('input', e => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        _searchQuery = e.target.value;
        applySort();
      }, 220);
    });
  }

  /* ─────────────────────────────────────────
     SELECT MODE
  ───────────────────────────────────────── */
  function toggleSelectMode() {
    _selectMode = !_selectMode;
    _selectedIds.clear();
    const btn    = document.getElementById('select-btn');
    const bulkBar = document.getElementById('bulk-bar');
    if (btn)     btn.classList.toggle('active', _selectMode);
    if (bulkBar) bulkBar.classList.toggle('visible', _selectMode);
    _playlistVL && _playlistVL.refresh();
  }

  function _toggleSelect(id, e) {
    e && e.stopPropagation();
    if (_selectedIds.has(id)) _selectedIds.delete(id);
    else _selectedIds.add(id);
    const countEl = document.getElementById('bulk-count');
    if (countEl) countEl.textContent = _selectedIds.size + '件選択';
    _playlistVL && _playlistVL.refresh();
  }

  function bulkAddToPlaylist() {
    _addToPl_trackIds = [..._selectedIds];
    _openAddToPlModal(_addToPl_trackIds);
  }

  function bulkDelete() {
    const ids = [..._selectedIds];
    if (!ids.length) return;
    _confirmCallback = async () => {
      for (const id of ids) await App.deleteTrack(id);
      toggleSelectMode();
    };
    _showConfirm('選択した曲を削除', `選択した${ids.length}曲を削除します。この操作は取り消せません。`);
  }

  /* ─────────────────────────────────────────
     MANUAL REORDER
  ───────────────────────────────────────── */
  async function _moveTrack(id, dir, e) {
    if (e) { e.stopPropagation(); e.preventDefault(); }

    const idx = _displayTracks.findIndex(t => t.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= _displayTracks.length) return;

    // 1. Swap the two items in _displayTracks
    const tmp = _displayTracks[idx];
    _displayTracks[idx]    = _displayTracks[newIdx];
    _displayTracks[newIdx] = tmp;

    // 2. Rewrite manualOrder for ALL items to match their new positions
    _displayTracks.forEach((t, i) => { t.manualOrder = i + 1; });

    // 3. Re-render immediately with a fresh slice (immutable reference)
    _playlistVL && _playlistVL.setItems(_displayTracks.slice());
    _updateTrackCount();

    // 4. Persist to IndexedDB — update every item whose order changed
    try {
      const updates = _displayTracks.map((t, i) =>
        Storage.updateTrack(t.id, { manualOrder: i + 1 })
      );
      await Promise.all(updates);

      // Sync manualOrder back to master _tracks array
      const orderMap = Object.fromEntries(_displayTracks.map(t => [t.id, t.manualOrder]));
      _tracks.forEach(t => {
        if (orderMap[t.id] !== undefined) t.manualOrder = orderMap[t.id];
      });
    } catch (err) {
      console.warn('[UI] _moveTrack persist failed:', err);
    }
  }

  /* ─────────────────────────────────────────
     PLAY
  ───────────────────────────────────────── */
  function _playTrack(id) {
    const idx = _displayTracks.findIndex(t => t.id === id);
    if (idx < 0) return;
    const ids = _displayTracks.map(t => t.id);
    Player.setQueue(ids, idx);
  }

  function onTrackChange(trackId) {
    _playlistVL && _playlistVL.refresh();
  }

  /* ─────────────────────────────────────────
     ADD TO PLAYLIST
  ───────────────────────────────────────── */
  function _openAddToPl(trackId, e) {
    e && e.stopPropagation();
    _addToPl_trackIds = [trackId];
    _openAddToPlModal([trackId]);
  }

  function _openAddToPlModal(trackIds) {
    const list = document.getElementById('pl-pick-list');
    if (!list) return;
    if (_playlists.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px">プレイリストがありません。<br>まず「リスト作成」でプレイリストを作成してください。</p>';
    } else {
      list.innerHTML = _playlists.map(pl => `
        <div class="playlist-pick-item" onclick="UI._addTracksToPlaylist('${pl.id}')">
          <i class="fa-solid fa-list-ul"></i>
          <span class="playlist-pick-name">${_esc(pl.name)}</span>
          <span class="playlist-pick-count">${pl.trackIds.length}曲</span>
        </div>`).join('');
    }
    openModal('add-to-pl-modal');
  }

  async function _addTracksToPlaylist(plId) {
    for (const id of _addToPl_trackIds) {
      await Storage.addTrackToPlaylist(plId, id);
    }
    _playlists = await Storage.getPlaylists();
    renderPlaylistTabs();
    closeModal('add-to-pl-modal');
    toast('プレイリストに追加しました', 'success');
    Drive.triggerAutoSync();
  }

  /* ─────────────────────────────────────────
     DELETE TRACK
  ───────────────────────────────────────── */
  function _confirmDeleteTrack(id, e) {
    e && e.stopPropagation();
    _actionTrackId = id;
    const track = _tracks.find(t => t.id === id);
    const title = track ? `「${track.title}」` : 'この曲';
    _confirmCallback = () => App.deleteTrack(id);
    _showConfirm('曲を削除', `${title}を削除します。ログやDriveのデータも削除されます。この操作は取り消せません。`);
  }

  /* ─────────────────────────────────────────
     FULL PLAYER OVERLAY
  ───────────────────────────────────────── */
  function openFullPlayer() {
    document.getElementById('full-player-overlay').classList.add('open');
  }

  function closeFullPlayer() {
    document.getElementById('full-player-overlay').classList.remove('open');
  }

  /* ─────────────────────────────────────────
     PAGE SWITCHING (mini-player visibility)
  ───────────────────────────────────────── */
  function onPageSwitch(page) {
    const mp = document.getElementById('mini-player');
    if (!mp) return;
    if (window.matchMedia('(max-width:768px)').matches) {
      if (page === 'player') mp.classList.remove('page-hidden');
      else                   mp.classList.add('page-hidden');
    }
  }

  /* ─────────────────────────────────────────
     LOG PAGE
  ───────────────────────────────────────── */

  /** 概要期間フィルターの切り替え */
  function switchOverviewPeriod(btn) {
    document.getElementById('overview-period-tabs').querySelectorAll('.inner-tab')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _overviewPeriod = btn.dataset.period;
    renderLogOverview();
  }

  /** _overviewPeriod に合わせてログを絞り込む */
  function _filterLogsByOverviewPeriod(logs) {
    if (_overviewPeriod === 'all') return logs;
    const now   = new Date();
    let start;
    if (_overviewPeriod === 'week') {
      const dow = now.getDay();
      start = new Date(now); start.setDate(now.getDate() - dow); start.setHours(0,0,0,0);
    } else if (_overviewPeriod === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else { // year
      start = new Date(now.getFullYear(), 0, 1);
    }
    return logs.filter(l => l.playedAt >= start.getTime());
  }

  async function renderLogOverview() {
    const [tracks, allLogs, tags] = await Promise.all([
      Storage.getTracks(),
      Storage.getLogs(),
      Storage.getTags(),
    ]);

    const logs = _filterLogsByOverviewPeriod(allLogs);

    // Stats
    const totalSec  = logs.reduce((s, l) => s + (l.duration || 0), 0);
    const totalH    = Math.floor(totalSec / 3600);
    const totalMin  = Math.floor((totalSec % 3600) / 60);

    // Play counts / time per track and artist
    const playCounts  = {};
    const trackTime   = {};
    const artistTime  = {};
    const artistPlays = {};
    const tagTime     = {};
    logs.forEach(l => {
      playCounts[l.trackId]  = (playCounts[l.trackId]  || 0) + 1;
      trackTime[l.trackId]   = (trackTime[l.trackId]   || 0) + (l.duration || 0);
      const t = tracks.find(t2 => t2.id === l.trackId);
      if (t) {
        artistTime[t.artist]  = (artistTime[t.artist]  || 0) + (l.duration || 0);
        artistPlays[t.artist] = (artistPlays[t.artist] || 0) + 1;
        (t.tags || []).forEach(tagId => {
          tagTime[tagId] = (tagTime[tagId] || 0) + (l.duration || 0);
        });
      }
    });

    const topTrackId = Object.entries(playCounts).sort((a,b) => b[1]-a[1])[0]?.[0];
    const topTrack   = tracks.find(t => t.id === topTrackId);
    const topArtist  = Object.entries(artistTime).sort((a,b) => b[1]-a[1])[0]?.[0]
                    || Object.entries(artistPlays).sort((a,b) => b[1]-a[1])[0]?.[0]
                    || '—';
    const topTagId   = Object.entries(tagTime).sort((a,b) => b[1]-a[1])[0]?.[0];
    const topTag     = topTagId ? tags.find(g => g.id === topTagId) : null;

    const grid = document.getElementById('log-stats-grid');
    if (grid) {
      const timeDisplay = totalSec > 0
        ? `${totalH}<span class="stat-unit">時間</span>${totalMin}<span class="stat-unit">分</span>`
        : `<span style="font-size:18px;color:var(--text-muted)">記録なし</span>`;
      const topThumbHtml = topTrack?._thumbUrl
        ? `<img src="${topTrack._thumbUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`
        : '<i class="fa-solid fa-music" style="font-size:18px;opacity:0.5"></i>';
      const tagDotHtml = topTag
        ? `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${topTag.color};vertical-align:middle;margin-right:4px"></span>`
        : '';
      grid.innerHTML = `
        <div class="stat-card">
          <div class="stat-icon"><i class="fa-solid fa-clock"></i></div>
          <div class="stat-label">再生時間</div>
          <div class="stat-value">${timeDisplay}</div>
          <div class="stat-sub">${Math.floor(totalSec / 60).toLocaleString()} 分</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><i class="fa-solid fa-music"></i></div>
          <div class="stat-label">総曲数</div>
          <div class="stat-value">${tracks.length}</div>
          <div class="stat-sub">${new Set(tracks.map(t=>t.artist)).size} アーティスト</div>
        </div>
        <div class="stat-card stat-card--thumb">
          <div class="stat-thumb-wrap">${topThumbHtml}</div>
          <div class="stat-icon"><i class="fa-solid fa-fire"></i></div>
          <div class="stat-label">最多再生楽曲</div>
          <div class="stat-value" style="font-size:16px;line-height:1.3">${_esc(topTrack?.title || '—')}</div>
          <div class="stat-sub">${playCounts[topTrackId] || 0}回再生</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><i class="fa-solid fa-star"></i></div>
          <div class="stat-label">最多再生アーティスト</div>
          <div class="stat-value" style="font-size:16px;line-height:1.3">${_esc(topArtist)}</div>
          <div class="stat-sub">${_fmtSec(artistTime[topArtist]||0)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon"><i class="fa-solid fa-tag"></i></div>
          <div class="stat-label">最多再生タグ</div>
          <div class="stat-value" style="font-size:16px;line-height:1.3">${tagDotHtml}${_esc(topTag?.name || '—')}</div>
          <div class="stat-sub">${_fmtSec(tagTime[topTagId]||0)}</div>
        </div>`;
    }

    // 期間別ハイライト
    await _renderPeriodHighlights(tracks, allLogs, tags);

    // Anniversary tracks
    _renderAnniversary(tracks);
  }

  /**
   * 期間別ハイライト:
   *   直近2ヶ月を最初から表示、それ以前は「過去のハイライトを見る」ボタンで展開
   *   各月にアーティスト・楽曲・タグ の3列を表示
   */
  async function _renderPeriodHighlights(tracks, logs, tags) {
    const container = document.getElementById('log-period-highlights');
    if (!container) return;

    const now = new Date();
    // 記録のある月をすべて収集（降順）
    const monthSet = new Set();
    logs.forEach(l => {
      const d = new Date(l.playedAt);
      monthSet.add(`${d.getFullYear()}-${d.getMonth()}`);
    });
    // 最低でも直近2ヶ月分は生成（データがなくてもスキップされる）
    for (let i = 0; i < 2; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthSet.add(`${d.getFullYear()}-${d.getMonth()}`);
    }

    // ソート（降順）
    const periods = Array.from(monthSet)
      .sort((a, b) => {
        const [ay, am] = a.split('-').map(Number);
        const [by, bm] = b.split('-').map(Number);
        return (by * 12 + bm) - (ay * 12 + am);
      })
      .map(key => {
        const [y, m] = key.split('-').map(Number);
        return {
          label: `${y}年${m + 1}月`,
          start: new Date(y, m, 1).getTime(),
          end:   new Date(y, m + 1, 0, 23, 59, 59, 999).getTime(),
        };
      });

    const RECENT_COUNT = 2; // 最初から表示する月数

    const buildPeriodCard = async (period, isOld) => {
      const periodLogs = logs.filter(l => l.playedAt >= period.start && l.playedAt <= period.end);
      if (!periodLogs.length) return '';

      const pTrackTime  = {};
      const pArtistTime = {};
      const pTagTime    = {};
      periodLogs.forEach(l => {
        pTrackTime[l.trackId] = (pTrackTime[l.trackId] || 0) + (l.duration || 0);
        const t = tracks.find(t2 => t2.id === l.trackId);
        if (t) {
          pArtistTime[t.artist] = (pArtistTime[t.artist] || 0) + (l.duration || 0);
          (t.tags || []).forEach(tagId => {
            pTagTime[tagId] = (pTagTime[tagId] || 0) + (l.duration || 0);
          });
        }
      });

      const totalPeriodSec = periodLogs.reduce((s, l) => s + (l.duration || 0), 0);

      // 上位アーティスト (最大4件)
      const topArtists = Object.entries(pArtistTime).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([a])=>a);
      // 上位トラック (最大4件)
      const topTrackIds = Object.entries(pTrackTime).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([id])=>id);
      // 上位タグ (最大4件)
      const topTagIds = Object.entries(pTagTime).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([id])=>id);

      // アーティスト代表サムネ
      const getArtistThumb = (artist) => {
        const rep = Object.entries(pTrackTime)
          .filter(([id]) => tracks.find(t2=>t2.id===id)?.artist === artist)
          .sort((a,b)=>b[1]-a[1])[0];
        const t = rep ? tracks.find(t2=>t2.id===rep[0]) : null;
        return t?._thumbUrl
          ? `<img src="${t._thumbUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:4px">`
          : `<i class="fa-solid fa-music" style="font-size:14px;opacity:0.5"></i>`;
      };

      const artistRows = topArtists.map((artist, idx) => `
        <div class="period-artist-row${idx===0?' period-artist-row--top':''}">
          <div class="period-item-thumb">${getArtistThumb(artist)}</div>
          <span class="period-item-name">${_esc(artist)}</span>
          <span class="period-item-val">${_fmtSec(pArtistTime[artist]||0)}</span>
        </div>`).join('');

      const trackRows = topTrackIds.map((id, idx) => {
        const track = tracks.find(t2=>t2.id===id);
        if (!track) return '';
        const thumb = track._thumbUrl
          ? `<img src="${track._thumbUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:4px">`
          : `<i class="fa-solid fa-music" style="font-size:14px;opacity:0.5"></i>`;
        return `<div class="period-track-row${idx===0?' period-track-row--top':''}">
          <div class="period-item-thumb">${thumb}</div>
          <div class="period-track-meta">
            <div class="period-track-title">${_esc(track.title)}</div>
            <div class="period-track-artist">${_esc(track.artist)}</div>
          </div>
          <span class="period-item-val">${_fmtSec(pTrackTime[id]||0)}</span>
        </div>`;
      }).join('');

      const tagRows = topTagIds.map((tagId, idx) => {
        const tag = tags.find(g=>g.id===tagId);
        if (!tag) return '';
        return `<div class="period-tag-row${idx===0?' period-tag-row--top':''}">
          <div class="period-tag-dot-wrap">
            <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:${tag.color}"></span>
          </div>
          <span class="period-item-name">${_esc(tag.name)}</span>
          <span class="period-item-val">${_fmtSec(pTagTime[tagId]||0)}</span>
        </div>`;
      }).join('');

      const oldClass = isOld ? ' period-old' : '';
      return `
        <div class="section-card period-highlight-card${oldClass}">
          <div class="section-card-title">
            <i class="fa-solid fa-calendar-week"></i>${_esc(period.label)}
            <span class="period-total-time">${_fmtSec(totalPeriodSec)}</span>
          </div>
          <div class="period-highlight-body">
            <div class="period-col">
              <div class="period-col-label"><i class="fa-solid fa-user-music"></i>アーティスト</div>
              ${artistRows || '<span style="font-size:12px;color:var(--text-muted)">なし</span>'}
            </div>
            <div class="period-col">
              <div class="period-col-label"><i class="fa-solid fa-music"></i>楽曲</div>
              ${trackRows || '<span style="font-size:12px;color:var(--text-muted)">なし</span>'}
            </div>
            <div class="period-col">
              <div class="period-col-label"><i class="fa-solid fa-tag"></i>タグ</div>
              ${tagRows || '<span style="font-size:12px;color:var(--text-muted)">なし</span>'}
            </div>
          </div>
        </div>`;
    };

    // 直近2ヶ月 + 過去分を生成
    const recentCards = await Promise.all(periods.slice(0, RECENT_COUNT).map(p => buildPeriodCard(p, false)));
    const oldCards    = await Promise.all(periods.slice(RECENT_COUNT).map(p => buildPeriodCard(p, true)));

    const hasOld = oldCards.some(h => h.trim() !== '');
    const expandBtn = hasOld ? `
      <div class="period-expand-wrap">
        <button class="btn-period-expand" id="btn-period-expand" onclick="UI._togglePeriodExpand(this)">
          <i class="fa-solid fa-clock-rotate-left"></i>
          過去のハイライトを見る
          <i class="fa-solid fa-chevron-down expand-chevron"></i>
        </button>
      </div>` : '';

    container.innerHTML =
      (recentCards.join('') || '<p style="color:var(--text-muted);font-size:13px;padding:4px 0 12px">再生履歴がありません</p>') +
      oldCards.join('') +
      expandBtn;
  }

  function _togglePeriodExpand(btn) {
    btn.classList.toggle('expanded');
    const isExpanded = btn.classList.contains('expanded');
    btn.querySelector('.expand-chevron').style.transform = isExpanded ? 'rotate(180deg)' : '';
    const label = btn.querySelector('i:first-child');
    document.querySelectorAll('.period-old').forEach(el => {
      el.classList.toggle('period-expanded', isExpanded);
    });
    btn.childNodes.forEach(n => {
      if (n.nodeType === 3) { // text node
        n.textContent = isExpanded ? ' 閉じる ' : ' 過去のハイライトを見る ';
      }
    });
  }

  function _renderAnniversary(tracks) {
    const list = document.getElementById('log-anniv-list');
    if (!list) return;
    const today = new Date();
    const todayMMDD = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const items = [];
    tracks.forEach(t => {
      if (!t.releaseDate) return;
      const rd = new Date(t.releaseDate);
      const mmdd = `${String(rd.getMonth()+1).padStart(2,'0')}-${String(rd.getDate()).padStart(2,'0')}`;
      if (mmdd === todayMMDD && rd.getFullYear() < today.getFullYear()) {
        const years = today.getFullYear() - rd.getFullYear();
        items.push({ track: t, years });
      }
    });
    if (items.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">本日が投稿周年の楽曲はありません</p>';
      return;
    }
    list.innerHTML = items.map(({ track, years }) => {
      const tagHtml = (track.tags || []).slice(0, 2).map(id => {
        const tag = _tags.find(g => g.id === id);
        return tag ? `<span class="tag-dot" style="background:${tag.color};width:10px;height:10px" title="${_esc(tag.name)}"></span>` : '';
      }).join('');
      const thumbHtml = track._thumbUrl
        ? `<img src="${track._thumbUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">`
        : '<i class="fa-solid fa-music" style="font-size:14px;opacity:0.5"></i>';
      return `<div class="anniv-item">
        <div class="anniv-thumb">${thumbHtml}</div>
        <div class="anniv-badge">${years}周年</div>
        <div class="anniv-info">
          <div class="anniv-title">${_esc(track.title)}</div>
          <div class="anniv-sub">${_esc(track.artist)} · 投稿日: ${track.releaseDate}</div>
        </div>
        ${tagHtml}
      </div>`;
    }).join('');
  }

  async function renderLogGraph() {
    const [tracks, logs] = await Promise.all([Storage.getTracks(), Storage.getLogs()]);
    _renderBarChart(tracks, logs);
  }

  function _renderBarChart(tracks, logs) {
    const chart = document.getElementById('graph-bar-chart');
    const label = document.getElementById('graph-date-label');
    const nextBtn = document.getElementById('graph-nav-next');
    if (!chart) return;

    const ref  = new Date(_graphRefDate);
    const now  = new Date();
    let labels = [];
    let data   = [];
    let periodLabel = '';
    let isAtPresent = false;

    if (_graphPeriod === 'month') {
      const year = ref.getFullYear();
      labels = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
      data   = new Array(12).fill(0);
      logs.filter(l => new Date(l.playedAt).getFullYear() === year)
          .forEach(l => { data[new Date(l.playedAt).getMonth()] += l.duration || 0; });
      periodLabel = year + '年';
      isAtPresent = year >= now.getFullYear();

    } else if (_graphPeriod === 'week') {
      const dow = ref.getDay();
      const weekStart = new Date(ref);
      weekStart.setDate(ref.getDate() - dow);
      weekStart.setHours(0,0,0,0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      weekEnd.setHours(23,59,59,999);
      labels = ['日','月','火','水','木','金','土'];
      data   = new Array(7).fill(0);
      logs.filter(l => l.playedAt >= weekStart.getTime() && l.playedAt <= weekEnd.getTime())
          .forEach(l => { data[new Date(l.playedAt).getDay()] += l.duration || 0; });
      const fmt = d => `${d.getMonth()+1}/${d.getDate()}`;
      periodLabel = fmt(weekStart) + ' 〜 ' + fmt(weekEnd);
      const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
      isAtPresent = todayStart >= weekStart && todayStart <= weekEnd;

    } else {
      const centerY = ref.getFullYear();
      labels = Array.from({length:5}, (_,i) => String(centerY - 2 + i));
      data   = new Array(5).fill(0);
      logs.forEach(l => {
        const y = new Date(l.playedAt).getFullYear();
        const i = labels.indexOf(String(y));
        if (i >= 0) data[i] += l.duration || 0;
      });
      periodLabel = `${labels[0]}年 〜 ${labels[4]}年`;
      isAtPresent = centerY + 2 >= now.getFullYear();
    }

    if (label)   label.textContent = periodLabel;
    if (nextBtn) nextBtn.disabled  = isAtPresent;

    const max = Math.max(...data, 1);
    chart.innerHTML = data.map((v, i) => {
      const pct = Math.round((v / max) * 100);
      return `<div class="bar-col" title="${labels[i]}: ${_fmtSec(v)}">
        <div class="bar-col-bar${pct===100?' highlight':''}" style="height:${Math.max(pct,2)}%"></div>
        <div class="bar-col-label">${labels[i]}</div>
      </div>`;
    }).join('');
  }

  function graphNavPrev() {
    const ref = new Date(_graphRefDate);
    if (_graphPeriod === 'week')  ref.setDate(ref.getDate() - 7);
    if (_graphPeriod === 'month') ref.setFullYear(ref.getFullYear() - 1);
    if (_graphPeriod === 'year')  ref.setFullYear(ref.getFullYear() - 5);
    _graphRefDate = ref;
    renderLogGraph();
  }

  function graphNavNext() {
    const ref = new Date(_graphRefDate);
    const now = new Date();
    if (_graphPeriod === 'week') {
      ref.setDate(ref.getDate() + 7);
      if (ref > now) ref.setTime(now.getTime());
    }
    if (_graphPeriod === 'month') {
      ref.setFullYear(ref.getFullYear() + 1);
      if (ref.getFullYear() > now.getFullYear()) ref.setFullYear(now.getFullYear());
    }
    if (_graphPeriod === 'year') {
      ref.setFullYear(ref.getFullYear() + 5);
      if (ref.getFullYear() > now.getFullYear() + 2) ref.setFullYear(now.getFullYear());
    }
    _graphRefDate = ref;
    renderLogGraph();
  }

  function switchLogTab(btn) {
    const tabs = document.getElementById('log-tabs');
    tabs.querySelectorAll('.inner-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _logSubTab = btn.dataset.tab;
    ['log-overview','log-graph','log-calendar'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== _logSubTab);
    });
    if (_logSubTab === 'log-overview') renderLogOverview();
    if (_logSubTab === 'log-graph')    renderLogGraph();
    if (_logSubTab === 'log-calendar') renderCalendar();
  }

  function switchGraphCat(btn) {
    document.getElementById('graph-category-tabs').querySelectorAll('.inner-tab')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _graphCat = btn.dataset.cat;
    renderLogGraph();
  }

  function switchGraphPeriod(btn) {
    document.getElementById('graph-period-tabs').querySelectorAll('.inner-tab')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _graphPeriod = btn.dataset.period;
    _graphRefDate = new Date();
    renderLogGraph();
  }

  /* ─────────────────────────────────────────
     CALENDAR  ─ 投稿周年・投稿日のみ表示
  ───────────────────────────────────────── */
  async function renderCalendar() {
    const tracks = await Storage.getTracks();
    const grid   = document.getElementById('cal-grid');
    const title  = document.getElementById('cal-title');
    if (!grid || !title) return;

    title.textContent = `${_calYear}年 ${_calMonth + 1}月`;

    const today    = new Date();
    const firstDay = new Date(_calYear, _calMonth, 1).getDay();
    const daysInM  = new Date(_calYear, _calMonth + 1, 0).getDate();
    const prevDays = new Date(_calYear, _calMonth, 0).getDate();

    // Build event map (day → { type: 'release'|'anniv', tracks[] })
    const eventMap = {};
    const addEvent = (day, track, type) => {
      if (!eventMap[day]) eventMap[day] = [];
      eventMap[day].push({ track, type });
    };

    tracks.forEach(t => {
      if (!t.releaseDate) return;
      const rd = new Date(t.releaseDate);
      if (rd.getFullYear() === _calYear && rd.getMonth() === _calMonth) {
        addEvent(rd.getDate(), t, 'release');
      }
      // BUG FIX: 冗長な条件を整理。投稿年が現在の表示年より前かつ同月 = 周年
      if (rd.getFullYear() < _calYear && rd.getMonth() === _calMonth) {
        addEvent(rd.getDate(), t, 'anniv');
      }
    });

    let html = '';
    // Prev month days
    for (let i = 0; i < firstDay; i++) {
      html += `<div class="cal-day other-month">${prevDays - firstDay + i + 1}</div>`;
    }
    // Current month
    for (let d = 1; d <= daysInM; d++) {
      const isToday  = today.getFullYear() === _calYear && today.getMonth() === _calMonth && today.getDate() === d;
      const hasEvent = !!eventMap[d];
      const isAnniv  = hasEvent && eventMap[d].some(e => e.type === 'anniv');
      let cls = 'cal-day';
      if (isToday)  cls += ' today';
      else if (isAnniv) cls += ' anniv-day';
      if (hasEvent) cls += ' has-event';
      html += `<div class="${cls}" onclick="UI._calDayClick(${d})">${d}</div>`;
    }
    // Next month
    const total  = firstDay + daysInM;
    const remain = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let d = 1; d <= remain; d++) {
      html += `<div class="cal-day other-month">${d}</div>`;
    }
    grid.innerHTML = html;
    _calEventMap = eventMap;
  }

  let _calEventMap = {};

  function _calDayClick(day) {
    const events = _calEventMap[day];
    const card   = document.getElementById('cal-event-card');
    const etitle = document.getElementById('cal-event-title');
    const elist  = document.getElementById('cal-event-list');
    if (!card || !events || events.length === 0) {
      if (card) card.style.display = 'none';
      return;
    }
    card.style.display = 'block';
    etitle.innerHTML = `<i class="fa-solid fa-cake-candles"></i>${_calYear}年${_calMonth+1}月${day}日 の周年・投稿日`;
    elist.innerHTML = events.map(({ track, type }) => {
      const rd    = new Date(track.releaseDate);
      const years = _calYear - rd.getFullYear();
      const thumbHtml = track._thumbUrl
        ? `<img src="${track._thumbUrl}" style="width:100%;height:100%;object-fit:cover;">`
        : '<i class="fa-solid fa-music" style="font-size:16px;opacity:0.4"></i>';
      const badgeStyle = type === 'anniv' ? '' : 'background:var(--accent-mid);color:var(--accent);font-size:10px';
      const badgeText  = type === 'anniv' ? years + '周年' : '投稿日';
      return `<div class="cal-anniv-item">
        <div class="cal-anniv-thumb">${thumbHtml}</div>
        <div class="cal-anniv-badge${type !== 'anniv' ? ' release-badge' : ''}" style="${badgeStyle}">
          ${badgeText}
        </div>
        <div class="cal-anniv-info">
          <div class="cal-anniv-title">${_esc(track.title)}</div>
          <div class="cal-anniv-sub">${_esc(track.artist)} · ${track.releaseDate}</div>
        </div>
      </div>`;
    }).join('');
  }

  function calPrev() {
    _calMonth--;
    if (_calMonth < 0) { _calMonth = 11; _calYear--; }
    renderCalendar();
  }
  function calNext() {
    _calMonth++;
    if (_calMonth > 11) { _calMonth = 0; _calYear++; }
    renderCalendar();
  }


  function _getEditGridLayout() {
    const isPortrait = window.matchMedia('(orientation: portrait)').matches;
    return {
      mode: isPortrait ? 'portrait' : 'landscape',
      cols: isPortrait ? 2 : _editCols,
    };
  }

  function _applyEditGridLayout(grid) {
    if (!grid) return;
    const layout = _getEditGridLayout();
    grid.dataset.editMode = layout.mode;
    grid.dataset.editCols = String(layout.cols);
  }

  /* ─────────────────────────────────────────
     EDIT PAGE – TRACK GRID
  ───────────────────────────────────────── */
  async function renderEditGrid() {
    const grid = document.getElementById('edit-grid');
    if (!grid) return;
    let list = [..._tracks];

    if (_editSearch.trim()) {
      const q = _editSearch.toLowerCase();
      list = list.filter(t =>
        (t.title||'').toLowerCase().includes(q) ||
        (t.artist||'').toLowerCase().includes(q) ||
        (t.tags||[]).some(id => {
          const tag = _tags.find(g => g.id === id);
          return tag && tag.name.toLowerCase().includes(q);
        })
      );
    }
    const dir = _editSortAsc ? 1 : -1;
    switch (_editSortKey) {
      case 'manual':
        list.sort((a,b) => dir*((a.manualOrder||0)-(b.manualOrder||0))); break;
      case 'added':
        list.sort((a,b) => dir*((a.dateAdded||0)-(b.dateAdded||0))); break;
      case 'title':
        list.sort((a,b) => dir*(a.title||'').localeCompare(b.title||'','ja')); break;
      case 'artist':
        list.sort((a,b) => dir*(a.artist||'').localeCompare(b.artist||'','ja')); break;
      case 'date':
        list.sort((a,b) => dir*((a.releaseDate||'')<(b.releaseDate||'')?-1:1)); break;
    }
    _editTracks = list;

    // Portrait = always 2 columns.
    // Landscape = toggle between 4 and 6 columns.
    _applyEditGridLayout(grid);

    grid.innerHTML = list.map(t => {
      // Thumbnail wrapped in inner div for padding-top 1:1 square trick
      const thumbInner = t._thumbUrl
        ? `<img src="${t._thumbUrl}" alt="">`
        : '<i class="fa-solid fa-music"></i>';

      // Release date
      const dateHtml = t.releaseDate
        ? `<div class="edit-card-date"><i class="fa-regular fa-calendar" style="margin-right:3px;font-size:9px"></i>${_esc(t.releaseDate)}</div>`
        : '';

      // Tags: coloured dot chip (max 3, then +N)
      const tagChips = (t.tags || []).slice(0, 3).map(id => {
        const tag = _tags.find(g => g.id === id);
        if (!tag) return '';
        return `<span class="edit-tag-chip" style="background:${tag.color};color:${tag.textColor}" title="${_esc(tag.name)}">
          <span class="tag-dot" style="background:${tag.textColor};width:6px;height:6px;flex-shrink:0"></span>
          ${_esc(tag.name)}
        </span>`;
      }).join('');
      const extraTags = (t.tags || []).length > 3
        ? `<span style="font-size:10px;color:var(--text-muted)">+${(t.tags||[]).length - 3}</span>` : '';

      return `<div class="edit-card" onclick="UI.openEditTrackModal('${t.id}',event)">
        <div class="edit-card-art">
          <div class="edit-card-art-inner">${thumbInner}</div>
        </div>
        <div class="edit-card-info">
          <div class="edit-card-title" title="${_esc(t.title)}">${_esc(t.title)}</div>
          <div class="edit-card-artist" title="${_esc(t.artist)}">${_esc(t.artist)}</div>
          ${dateHtml}
          <div class="edit-card-tags">${tagChips}${extraTags}</div>
        </div>
      </div>`;
    }).join('');
  }

  function applyEditSort() {
    const sel = document.getElementById('edit-sort-select');
    if (sel) _editSortKey = sel.value;
    renderEditGrid();
  }

  function toggleEditSortDir() {
    _editSortAsc = !_editSortAsc;
    const btn = document.getElementById('edit-sort-dir');
    if (btn) {
      btn.querySelector('i').className = _editSortAsc
        ? 'fa-solid fa-arrow-up-a-z' : 'fa-solid fa-arrow-down-z-a';
    }
    renderEditGrid();
  }

  function toggleEditCols() {
    if (window.matchMedia('(orientation: portrait)').matches) return;
    _editCols = (_editCols === 4) ? 6 : 4;
    const grid = document.getElementById('edit-grid');
    _applyEditGridLayout(grid);
  }

  function initEditSearch() {
    const input = document.getElementById('edit-search');
    if (!input) return;
    let timer;
    input.addEventListener('input', e => {
      clearTimeout(timer);
      timer = setTimeout(() => { _editSearch = e.target.value; renderEditGrid(); }, 220);
    });
  }

  function switchEditTab(btn) {
    document.getElementById('edit-tabs').querySelectorAll('.inner-tab')
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    ['edit-tracks','edit-tags'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = id === tabId ? 'flex' : 'none';
    });
    if (tabId === 'edit-tags') renderTagManager();
    if (tabId === 'edit-tracks') renderEditGrid();
  }

  /* ─────────────────────────────────────────
     TAG MANAGER
  ───────────────────────────────────────── */
  async function renderTagManager() {
    _tags = await Storage.getTags();
    const list = document.getElementById('tag-manager-list');
    if (!list) return;
    if (_tags.length === 0) {
      list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-tag"></i><p>タグがありません</p></div>';
      return;
    }
    // Count tracks per tag
    const counts = {};
    _tracks.forEach(t => (t.tags || []).forEach(id => { counts[id] = (counts[id]||0)+1; }));

    list.innerHTML = _tags.map((tag, i) => `
      <div class="tag-manager-item" data-id="${tag.id}">
        <div class="tag-color-swatch" style="background:${tag.color};border:2px solid ${tag.textColor}40"></div>
        <span class="tag-item-name">${_esc(tag.name)}</span>
        <span class="tag-item-count">${counts[tag.id] || 0}曲</span>
        <div class="tag-order-btns">
          <button class="btn-icon" ${i===0?'disabled':''} onclick="UI._moveTag('${tag.id}',-1)" title="上へ">
            <i class="fa-solid fa-arrow-up"></i>
          </button>
          <button class="btn-icon" ${i===_tags.length-1?'disabled':''} onclick="UI._moveTag('${tag.id}',1)" title="下へ">
            <i class="fa-solid fa-arrow-down"></i>
          </button>
        </div>
        <button class="btn-icon" onclick="UI.openEditTagModal('${tag.id}')" title="編集">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="btn-icon" onclick="UI._confirmDeleteTag('${tag.id}')" title="削除" style="color:var(--danger)">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>`).join('');
  }

  async function _moveTag(id, dir) {
    const idx = _tags.findIndex(t => t.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= _tags.length) return;
    [_tags[idx], _tags[newIdx]] = [_tags[newIdx], _tags[idx]];
    await Storage.reorderTags(_tags.map(t => t.id));
    renderTagManager();
  }

  function _confirmDeleteTag(id) {
    const tag = _tags.find(t => t.id === id);
    _confirmCallback = () => App.deleteTag(id);
    _showConfirm('タグを削除', `タグ「${tag?.name || ''}」を削除します。曲からも削除されます。`);
  }

  /* ─────────────────────────────────────────
     MODALS – OPEN / CLOSE
  ───────────────────────────────────────── */
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  // Close overlay on backdrop click
  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('click', e => {
      if (e.target === o) o.classList.remove('open');
    });
  });

  function _showConfirm(title, msg) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-msg').textContent   = msg;
    document.getElementById('confirm-ok-btn').onclick    = () => {
      closeModal('confirm-modal');
      _confirmCallback && _confirmCallback();
    };
    openModal('confirm-modal');
  }

  /* ─────────────────────────────────────────
     UPLOAD MODAL
  ───────────────────────────────────────── */
  function openUploadModal() {
    _uploadQueue = [];
    document.getElementById('file-queue').innerHTML = '';
    document.getElementById('upload-confirm-btn').disabled = true;
    openModal('upload-modal');
  }

  function _initUploadDropZone() {
    const zone  = document.getElementById('upload-drop-zone');
    const input = document.getElementById('file-input');
    if (!zone || !input) return;

    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      _handleFiles(Array.from(e.dataTransfer.files));
    });
    input.addEventListener('change', e => {
      _handleFiles(Array.from(e.target.files));
      e.target.value = '';
    });

    // Also handle drag onto playlist panel (outside modal)
    const plPanel = document.getElementById('playlist-panel');
    if (plPanel) {
      plPanel.addEventListener('dragover', e => {
        e.preventDefault();
        plPanel.style.outline = '2px dashed var(--accent)';
      });
      plPanel.addEventListener('dragleave', () => { plPanel.style.outline = ''; });
      plPanel.addEventListener('drop', e => {
        e.preventDefault();
        plPanel.style.outline = '';
        const files = Array.from(e.dataTransfer.files)
          .filter(f => f.type.startsWith('audio/'));
        if (files.length) { openUploadModal(); _handleFiles(files); }
      });
    }
  }

  const AUDIO_EXTS = ['.mp3','.m4a','.wav','.flac','.ogg'];
  async function _handleFiles(files) {
    const audioFiles = files.filter(f =>
      f.type.startsWith('audio/') ||
      AUDIO_EXTS.some(ext => f.name.toLowerCase().endsWith(ext))
    );
    for (const file of audioFiles) {
      const meta = await Storage.readAudioMeta(file);
      _uploadQueue.push({ file, ...meta });
    }
    _renderFileQueue();
    document.getElementById('upload-confirm-btn').disabled = _uploadQueue.length === 0;
  }

  function _renderFileQueue() {
    const qEl = document.getElementById('file-queue');
    if (!qEl) return;
    // Build items (synchronous — blob URLs created inline)
    const items = _uploadQueue.map((item, i) => {
      let thumbHtml = '<i class="fa-solid fa-file-audio" style="font-size:18px;color:var(--accent);opacity:0.5"></i>';
      if (item.thumbData) {
        try {
          const blob = new Blob([item.thumbData], { type: item.thumbMime || 'image/jpeg' });
          const url  = URL.createObjectURL(blob);
          thumbHtml  = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:4px">`;
        } catch {}
      }
      return `<div class="file-queue-item">
        <div style="width:38px;height:38px;border-radius:6px;background:var(--accent-mid);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">${thumbHtml}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(item.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${_esc(item.artist || '不明なアーティスト')} · ${_fmtBytes(item.file.size)}</div>
        </div>
        <button class="file-queue-remove" onclick="UI._removeFromQueue(${i})" title="削除"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    });
    qEl.innerHTML = items.join('');
  }

  function _removeFromQueue(i) {
    _uploadQueue.splice(i, 1);
    _renderFileQueue();
    document.getElementById('upload-confirm-btn').disabled = _uploadQueue.length === 0;
  }

  function getUploadQueue() { return [..._uploadQueue]; }

  /* ─────────────────────────────────────────
     EDIT TRACK MODAL
  ───────────────────────────────────────── */
  async function openEditTrackModal(trackId, e) {
    e && e.stopPropagation();
    const track = await Storage.getTrack(trackId);
    if (!track) return;

    _editTrackId     = trackId;
    _editThumbData   = null;
    _editThumbMime   = null;
    _editCurrentTags = [...(track.tags || [])];

    document.getElementById('edit-track-id').value = trackId;
    document.getElementById('edit-title').value    = track.title   || '';
    document.getElementById('edit-artist').value   = track.artist  || '';
    document.getElementById('edit-date').value     = track.releaseDate || '';

    // Thumbnail
    const thumbBtn = document.getElementById('edit-thumb-btn');
    if (track.thumbKey) {
      const url = await Storage.getBlobUrl(track.thumbKey);
      if (url) thumbBtn.innerHTML = `<img src="${url}"><input type="file" id="thumb-input" accept="image/*" style="display:none">`;
    } else {
      thumbBtn.innerHTML = '<i class="fa-solid fa-image"></i><input type="file" id="thumb-input" accept="image/*" style="display:none">';
    }
    document.getElementById('thumb-input').addEventListener('change', _onThumbSelected);

    // Datalists
    const artists = [...new Set(_tracks.map(t => t.artist).filter(Boolean))];
    document.getElementById('artist-datalist').innerHTML =
      artists.map(a => `<option value="${_esc(a)}">`).join('');
    document.getElementById('tag-datalist').innerHTML =
      _tags.map(t => `<option value="${_esc(t.name)}">`).join('');

    _renderEditTagPills();
    openModal('edit-track-modal');
  }

  function _renderEditTagPills() {
    const container = document.getElementById('edit-tag-pills');
    if (!container) return;
    container.innerHTML = _editCurrentTags.map(id => {
      const tag = _tags.find(g => g.id === id);
      if (!tag) return '';
      return `<button class="tag-pill" style="background:${tag.color};color:${tag.textColor}"
        onclick="UI._removeTagFromEdit('${id}')">
        ${_esc(tag.name)}
        <span class="tag-pill-remove"><i class="fa-solid fa-xmark"></i></span>
      </button>`;
    }).join('');
  }

  function _removeTagFromEdit(id) {
    _editCurrentTags = _editCurrentTags.filter(t => t !== id);
    _renderEditTagPills();
  }

  function _initTagInput() {
    const input = document.getElementById('edit-tag-input');
    if (!input) return;
    input.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;

      // Try matching existing tag by name first
      const existing = _tags.find(t => t.name === val);
      if (existing) {
        if (!_editCurrentTags.includes(existing.id)) {
          _editCurrentTags.push(existing.id);
          _renderEditTagPills();
        }
        input.value = '';
        return;
      }

      // New tag — show inline color picker before creating
      _showInlineTagColorPicker(val, input);
      input.value = '';
    });
  }

  /**
   * Show a small inline color-picker popover near the tag input.
   * User picks a color then confirms to create the tag.
   */
  function _showInlineTagColorPicker(tagName, anchorEl) {
    // Remove any existing picker
    const existing = document.getElementById('inline-tag-color-picker');
    if (existing) existing.remove();

    const PRESETS = [
      { bg:'#DBEAFE', text:'#1D4ED8' },
      { bg:'#EDE9FE', text:'#7C3AED' },
      { bg:'#DCFCE7', text:'#16A34A' },
      { bg:'#FFE4E6', text:'#E11D48' },
      { bg:'#FEF3C7', text:'#D97706' },
      { bg:'#FCE7F3', text:'#BE185D' },
      { bg:'#CCFBF1', text:'#0D9488' },
      { bg:'#FEF9C3', text:'#854D0E' },
    ];

    let chosenBg   = PRESETS[0].bg;
    let chosenText = PRESETS[0].text;

    const picker = document.createElement('div');
    picker.id = 'inline-tag-color-picker';
    picker.style.cssText = [
      'position:absolute',
      'z-index:9999',
      'background:white',
      'border:1.5px solid var(--border)',
      'border-radius:var(--r-md)',
      'padding:12px',
      'box-shadow:var(--shadow-lg)',
      'width:220px',
    ].join(';');

    const dotsHtml = PRESETS.map((p, i) => `
      <button type="button" data-bg="${p.bg}" data-text="${p.text}"
        style="width:22px;height:22px;border-radius:50%;background:${p.bg};
               border:2.5px solid ${i===0?'var(--accent)':'transparent'};
               cursor:pointer;padding:0;flex-shrink:0"
        title="${p.text}"></button>`).join('');

    picker.innerHTML = `
      <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">
        タグ「${_esc(tagName)}」の色を選択
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px" id="itcp-dots">
        ${dotsHtml}
        <label style="display:flex;align-items:center;cursor:pointer" title="カスタム">
          <input type="color" id="itcp-custom" value="#3B82F6"
            style="width:22px;height:22px;border:none;border-radius:50%;cursor:pointer;padding:0">
        </label>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end">
        <button type="button" id="itcp-cancel"
          style="padding:5px 12px;border:1.5px solid var(--border);background:white;
                 border-radius:var(--r-sm);cursor:pointer;font-size:12px;color:var(--text-secondary)">
          キャンセル
        </button>
        <button type="button" id="itcp-ok"
          style="padding:5px 12px;background:var(--accent);color:white;
                 border:none;border-radius:var(--r-sm);cursor:pointer;font-size:12px">
          作成
        </button>
      </div>`;

    // Position below anchor
    document.body.appendChild(picker);
    const rect = anchorEl.getBoundingClientRect();
    picker.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    picker.style.left = Math.min(rect.left + window.scrollX,
                                  window.innerWidth - 230) + 'px';

    // Dot click
    picker.querySelectorAll('#itcp-dots button').forEach(btn => {
      btn.addEventListener('click', () => {
        picker.querySelectorAll('#itcp-dots button').forEach(b =>
          b.style.border = '2.5px solid transparent');
        btn.style.border = '2.5px solid var(--accent)';
        chosenBg   = btn.dataset.bg;
        chosenText = btn.dataset.text;
      });
    });

    // Custom color
    picker.querySelector('#itcp-custom').addEventListener('input', e => {
      const hex  = e.target.value;
      chosenBg   = hex + '33';
      chosenText = hex;
      picker.querySelectorAll('#itcp-dots button').forEach(b =>
        b.style.border = '2.5px solid transparent');
    });

    picker.querySelector('#itcp-cancel').addEventListener('click', () => picker.remove());

    picker.querySelector('#itcp-ok').addEventListener('click', async () => {
      picker.remove();
      const tag = await Storage.createTag(tagName, chosenBg, chosenText);
      _tags = await Storage.getTags();
      _editCurrentTags.push(tag.id);
      _renderEditTagPills();
      _refreshTagDatalist();
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!picker.contains(e.target) && e.target !== anchorEl) {
          picker.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 10);
  }

  function _refreshTagDatalist() {
    const dl = document.getElementById('tag-datalist');
    if (dl) dl.innerHTML = _tags.map(t => `<option value="${_esc(t.name)}">`).join('');
  }

  async function _onThumbSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    const buf  = await file.arrayBuffer();
    _editThumbData = buf;
    _editThumbMime = file.type || 'image/jpeg';
    const url  = URL.createObjectURL(file);
    const btn  = document.getElementById('edit-thumb-btn');
    const inp  = document.getElementById('thumb-input');
    btn.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
    btn.appendChild(inp); // keep input inside
  }

  async function getEditFormData() {
    return {
      id:          _editTrackId,
      title:       document.getElementById('edit-title').value.trim(),
      artist:      document.getElementById('edit-artist').value.trim(),
      releaseDate: document.getElementById('edit-date').value || null,
      tags:        [..._editCurrentTags],
      thumbData:   _editThumbData,
      thumbMime:   _editThumbMime,
    };
  }

  /* ─────────────────────────────────────────
     NEW PLAYLIST MODAL
  ───────────────────────────────────────── */
  function openNewPlaylistModal() {
    document.getElementById('new-pl-name').value = '';
    document.getElementById('new-pl-desc').value = '';
    openModal('new-playlist-modal');
  }

  function getNewPlaylistData() {
    return {
      name: document.getElementById('new-pl-name').value.trim(),
      desc: document.getElementById('new-pl-desc').value.trim(),
    };
  }

  /* ─────────────────────────────────────────
     TAG MODAL
  ───────────────────────────────────────── */
  function openNewTagModal() {
    _tagEditId    = null;
    _tagColor     = '#DBEAFE';
    _tagTextColor = '#1D4ED8';
    document.getElementById('tag-modal-title').textContent   = 'タグを作成';
    document.getElementById('tag-modal-btn-txt').textContent = '作成';
    document.getElementById('tag-name-input').value          = '';
    document.getElementById('tag-edit-id').value             = '';
    document.getElementById('tag-preview-dot').style.background = _tagColor;
    document.getElementById('tag-preview-name').textContent  = 'タグ名';
    // Reset selection
    document.querySelectorAll('.color-dot-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('.color-dot-btn')[0]?.classList.add('selected');
    openModal('tag-modal');
    // Live preview
    const nameInput = document.getElementById('tag-name-input');
    nameInput.oninput = () => {
      document.getElementById('tag-preview-name').textContent = nameInput.value || 'タグ名';
    };
  }

  async function openEditTagModal(id) {
    const tag = await Storage.getTag(id);
    if (!tag) return;
    _tagEditId    = id;
    _tagColor     = tag.color;
    _tagTextColor = tag.textColor;
    document.getElementById('tag-modal-title').textContent   = 'タグを編集';
    document.getElementById('tag-modal-btn-txt').textContent = '保存';
    document.getElementById('tag-name-input').value          = tag.name;
    document.getElementById('tag-edit-id').value             = id;
    document.getElementById('tag-preview-dot').style.background   = tag.color;
    document.getElementById('tag-preview-name').textContent  = tag.name;
    const nameInput = document.getElementById('tag-name-input');
    nameInput.oninput = () => {
      document.getElementById('tag-preview-name').textContent = nameInput.value || 'タグ名';
    };
    openModal('tag-modal');
  }

  function selectTagColor(btn) {
    document.querySelectorAll('.color-dot-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _tagColor     = btn.dataset.color;
    _tagTextColor = btn.dataset.text;
    document.getElementById('tag-preview-dot').style.background = _tagColor;
  }

  function selectCustomColor(hexColor) {
    _tagColor     = hexColor + '33'; // light bg
    _tagTextColor = hexColor;
    document.getElementById('tag-preview-dot').style.background = _tagColor;
    document.querySelectorAll('.color-dot-btn').forEach(b => b.classList.remove('selected'));
  }

  function getTagFormData() {
    return {
      id:        _tagEditId,
      name:      document.getElementById('tag-name-input').value.trim(),
      color:     _tagColor,
      textColor: _tagTextColor,
    };
  }

  /* ─────────────────────────────────────────
     TOAST
  ───────────────────────────────────────── */
  function toast(msg, type = '') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  /* ─────────────────────────────────────────
     REFRESH AFTER DATA CHANGE
  ───────────────────────────────────────── */
  async function refreshAll() {
    [_tracks, _tags, _playlists] = await Promise.all([
      Storage.getTracks(),
      Storage.getTags(),
      Storage.getPlaylists(),
    ]);
    await _attachThumbUrls(_tracks);
    renderPlaylistTabs();
    applySort();
  }

  async function refreshTags() {
    _tags = await Storage.getTags();
  }

  async function refreshPlaylists() {
    _playlists = await Storage.getPlaylists();
    renderPlaylistTabs();
  }

  /* ─────────────────────────────────────────
     UTILS
  ───────────────────────────────────────── */
  function _esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function _fmtDur(seconds) {
    if (!seconds || isNaN(seconds)) return '—';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function _fmtSec(seconds) {
    if (!seconds) return '0分';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}時間${m}分`;
    return `${m}分`;
  }

  function _fmtBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */
  function init() {
    _initVirtualList();
    _initUploadDropZone();
    initSearch();
    initEditSearch();
    _initTagInput();

    const refreshEditLayout = () => {
      const grid = document.getElementById('edit-grid');
      if (!grid) return;
      _applyEditGridLayout(grid);
      if (document.getElementById('edit-tracks')?.style.display !== 'none') {
        renderEditGrid();
      }
    };
    window.addEventListener('resize', () => {
      window.clearTimeout(init._editResizeTimer);
      init._editResizeTimer = window.setTimeout(refreshEditLayout, 120);
    }, { passive: true });
    window.addEventListener('orientationchange', () => {
      window.clearTimeout(init._editResizeTimer);
      init._editResizeTimer = window.setTimeout(refreshEditLayout, 120);
    }, { passive: true });

    // Sort select change
    const sortSel = document.getElementById('pl-sort-select');
    if (sortSel) sortSel.addEventListener('change', e => {
      _sortKey = e.target.value;
      applySort();
    });

    // Portrait header add button
    const phAdd = document.getElementById('ph-add-btn');
    if (phAdd) phAdd.onclick = () => openUploadModal();
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    init,
    loadData,
    refreshAll,
    refreshTags,
    refreshPlaylists,

    // Playlist
    renderPlaylistTabs,
    switchPlaylist,
    applySort,
    toggleSortDir,

    // Select
    toggleSelectMode,
    bulkAddToPlaylist,
    bulkDelete,

    // Manual reorder
    _moveTrack,

    // Log
    renderLogOverview,
    renderLogGraph,
    renderCalendar,
    switchLogTab,
    switchOverviewPeriod,
    switchGraphCat,
    switchGraphPeriod,
    graphNavPrev,
    graphNavNext,
    calPrev,
    calNext,
    _calDayClick,
    _togglePeriodExpand,

    // Edit
    renderEditGrid,
    applyEditSort,
    toggleEditSortDir,
    toggleEditCols,
    switchEditTab,
    renderTagManager,
    _moveTag,
    _confirmDeleteTag,

    // Modals
    openModal,
    closeModal,
    openUploadModal,
    openNewPlaylistModal,
    getNewPlaylistData,
    openEditTrackModal,
    getEditFormData,
    openNewTagModal,
    openEditTagModal,
    selectTagColor,
    selectCustomColor,
    getTagFormData,

    // Add to playlist
    _openAddToPl,
    _addTracksToPlaylist,
    _openAddToPlModal,

    // Delete
    _confirmDeleteTrack,

    // Upload
    getUploadQueue,

    // Full player
    openFullPlayer,
    closeFullPlayer,

    // Page switch
    onPageSwitch,

    // Track change callback (called by Player)
    onTrackChange,

    // Toast
    toast,

    // Expose for inline HTML
    _toggleSelect,
    _removeFromQueue,
    _removeTagFromEdit,
  };
})();
