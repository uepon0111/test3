'use strict';

/* ============================================================
   PLAYER SCREEN  —  プレイヤー画面
   ============================================================ */

const PlayerScreen = (() => {

  let trackListVS = null;  // VirtualList
  let sortable     = null; // SortableJS (not used for tracks; kept for future)
  let pendingFiles = [];   // staging files for upload

  /* ============================================================
     PLAYER WIDGET UI  (both panel + overlay + mini player)
     ============================================================ */

  const PlayerWidgetUI = {
    /* track info を全プレイヤー要素に反映 */
    updateTrack() {
      const track = AppState.currentTrackId ? AppState.getTrack(AppState.currentTrackId) : null;
      const title  = track?.title  || '曲を選択してください';
      const artist = track ? getArtistNames(track) : '—';
      const thumb  = track?.thumbnail || null;

      // Main panel
      _setPlayerField('pw-title',  title);
      _setPlayerField('pw-artist', artist);
      _setThumb('pw-thumb', 'pw-thumb-default', thumb);

      // Overlay
      _setPlayerField('po-title',  title);
      _setPlayerField('po-artist', artist);
      _setThumb('po-thumb', 'po-thumb-default', thumb);

      // Mini player
      _setPlayerField('mp-title',  title);
      _setPlayerField('mp-artist', artist);
      _setThumb('mp-thumb', 'mp-thumb-default', thumb);

      // Also refresh any playing indicator in the track list
      _refreshPlayingItem();
    },

    updatePlayState() {
      const playing = AppState.isPlaying;
      const icon    = playing ? 'pause' : 'play';
      _setCtrlIcon('pw-play', icon);
      _setCtrlIcon('po-play', icon);
      _setCtrlIcon('mp-play', icon);
    },

    updateProgress() {
      const cur = AppState.currentTime;
      const dur = AppState.duration;
      const pct = dur > 0 ? (cur / dur) * 100 : 0;

      _setProgress('pw-progress-fill', 'pw-cur-time', 'pw-tot-time', pct, cur, dur);
      _setProgress('po-progress-fill', 'po-cur-time', 'po-tot-time', pct, cur, dur);
    },

    updateShuffle() {
      const v = AppState.shuffle;
      el('pw-shuffle')?.classList.toggle('active', v);
      el('po-shuffle')?.classList.toggle('active', v);
    },

    updateRepeat() {
      const r = AppState.repeat;
      const icon = r === 'one' ? 'repeat-1' : 'repeat';
      _setCtrlIcon('pw-repeat', icon);
      _setCtrlIcon('po-repeat', icon);
      el('pw-repeat')?.classList.toggle('active', r !== 'none');
      el('po-repeat')?.classList.toggle('active', r !== 'none');
    },

    updateSpeed() {
      const v = AppState.playbackRate;
      const label = `${v.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0')}×`;
      ['pw', 'po'].forEach(prefix => {
        const cur = el(`${prefix}-speed-current`);
        if (cur) cur.textContent = label;
        document.querySelectorAll(`#${prefix}-speed-panel .speed-option`).forEach(b => {
          b.classList.toggle('active', parseFloat(b.dataset.speed) === v);
        });
      });
    },

    updateVolume() {
      const v = AppState.volume;
      const pw = el('pw-volume'); if (pw) pw.value = v;
      const po = el('po-volume'); if (po) po.value = v;
    },
  };

  function _setPlayerField(id, text) {
    const e = el(id);
    if (!e) return;
    e.textContent = text;
    e.title = text;
  }
  function _setThumb(imgId, defId, src) {
    const img = el(imgId), def = el(defId);
    if (!img || !def) return;
    if (src) { img.src = src; img.style.display = 'block'; def.style.display = 'none'; }
    else      { img.src = ''; img.style.display = 'none';  def.style.display = 'flex'; }
  }
  function _setCtrlIcon(btnId, iconName) {
    setIcon(el(btnId), iconName);
  }
  function _setProgress(fillId, curId, totId, pct, cur, dur) {
    const fill = el(fillId);
    if (fill) fill.style.width = `${pct}%`;
    const curEl = el(curId); if (curEl) curEl.textContent = formatTime(cur);
    const totEl = el(totId); if (totEl) totEl.textContent = formatTime(dur);
  }
  function _refreshPlayingItem() {
    document.querySelectorAll('.track-item').forEach(item => {
      const id = item.dataset.trackId;
      item.classList.toggle('playing', id === AppState.currentTrackId);
    });
  }

  /* ── Progress bar seek (pointer events) ── */
  function _bindProgressBar(barId, isFill) {
    const bar = el(barId);
    if (!bar) return;
    const fill = bar.querySelector('.pw-progress-fill');
    let dragging = false;
    function calc(e) {
      const r = bar.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      return clamp((x / r.width) * 100, 0, 100);
    }
    function applyVisual(pct) {
      if (fill) fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    bar.addEventListener('pointerdown', e => {
      dragging = true;
      bar.classList.add('seeking');
      try { bar.setPointerCapture(e.pointerId); } catch {}
      const pct = calc(e);
      applyVisual(pct);
      AudioEngine.seek(pct);
    });
    bar.addEventListener('pointermove', e => {
      if (!dragging) return;
      const pct = calc(e);
      applyVisual(pct);
      AudioEngine.seek(pct);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('seeking');
    }
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  /* ── Speed select dropdown ── */
  function _bindSpeedSelect(prefix) {
    const wrap    = el(`${prefix}-speed-wrap`);
    const trigger = el(`${prefix}-speed-trigger`);
    const panel   = el(`${prefix}-speed-panel`);
    if (!wrap || !trigger || !panel) return;

    function open() {
      panel.classList.remove('hidden');
      trigger.setAttribute('aria-expanded', 'true');
    }
    function close() {
      panel.classList.add('hidden');
      trigger.setAttribute('aria-expanded', 'false');
    }
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      panel.classList.contains('hidden') ? open() : close();
    });
    panel.querySelectorAll('.speed-option').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        AudioEngine.setSpeed(parseFloat(btn.dataset.speed));
        PlayerWidgetUI.updateSpeed();
        close();
      });
    });
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
    });
  }

  /* ============================================================
     PLAYER WIDGET: binding controls
     ============================================================ */

  function _bindPlayerControls() {
    // Main panel
    el('pw-play')?.addEventListener('click', () => AudioEngine.togglePlay());
    el('pw-prev')?.addEventListener('click', () => AudioEngine.prev());
    el('pw-next')?.addEventListener('click', () => AudioEngine.next());
    el('pw-shuffle')?.addEventListener('click', () => {
      AudioEngine.setShuffle(!AppState.shuffle);
      PlayerWidgetUI.updateShuffle();
    });
    el('pw-repeat')?.addEventListener('click', () => {
      const next = AppState.repeat === 'none' ? 'all' : AppState.repeat === 'all' ? 'one' : 'none';
      AudioEngine.setRepeat(next);
      PlayerWidgetUI.updateRepeat();
    });
    el('pw-volume')?.addEventListener('input', e => AudioEngine.setVolume(parseFloat(e.target.value)));
    _bindProgressBar('pw-progress');
    _bindSpeedSelect('pw');

    // Overlay
    el('po-play')?.addEventListener('click', () => AudioEngine.togglePlay());
    el('po-prev')?.addEventListener('click', () => AudioEngine.prev());
    el('po-next')?.addEventListener('click', () => AudioEngine.next());
    el('po-shuffle')?.addEventListener('click', () => {
      AudioEngine.setShuffle(!AppState.shuffle);
      PlayerWidgetUI.updateShuffle();
    });
    el('po-repeat')?.addEventListener('click', () => {
      const next = AppState.repeat === 'none' ? 'all' : AppState.repeat === 'all' ? 'one' : 'none';
      AudioEngine.setRepeat(next);
      PlayerWidgetUI.updateRepeat();
    });
    el('po-volume')?.addEventListener('input', e => AudioEngine.setVolume(parseFloat(e.target.value)));
    _bindProgressBar('po-progress');
    _bindSpeedSelect('po');

    // Mini player controls
    el('mp-play')?.addEventListener('click', e => { e.stopPropagation(); AudioEngine.togglePlay(); });
    el('mp-prev')?.addEventListener('click', e => { e.stopPropagation(); AudioEngine.prev(); });
    el('mp-next')?.addEventListener('click', e => { e.stopPropagation(); AudioEngine.next(); });

    // Mini player → open overlay
    el('mini-player-click')?.addEventListener('click', () => _openOverlay());
    el('btn-close-overlay')?.addEventListener('click', () => _closeOverlay());
    el('po-backdrop')?.addEventListener('click', () => _closeOverlay());
  }

  function _openOverlay() {
    const ov = el('player-overlay');
    if (!ov) return;
    ov.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }
  function _closeOverlay() {
    const ov = el('player-overlay');
    if (!ov) return;
    ov.classList.remove('visible');
    document.body.style.overflow = '';
  }

  /* ============================================================
     PLAYLIST TABS (7)
     ============================================================ */

  function renderPlaylistTabs() {
    const wrap = el('playlist-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    AppState.playlists.forEach(pl => {
      const tab = document.createElement('button');
      tab.className = `playlist-tab${pl.id === AppState.currentPlaylistId ? ' active' : ''}`;
      tab.dataset.plId = pl.id;
      tab.title = pl.name;

      const name = document.createElement('span');
      name.textContent = pl.name;
      tab.appendChild(name);

      // Context menu for non-default playlists
      if (!pl.isDefault) {
        const menuBtn = document.createElement('button');
        menuBtn.className = 'playlist-tab-menu-btn';
        menuBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
        menuBtn.addEventListener('click', e => {
          e.stopPropagation();
          const r = menuBtn.getBoundingClientRect();
          CtxMenu.open([
            { label: '名前を変更', icon: 'pencil', action: () => _editPlaylist(pl.id) },
            { separator: true },
            { label: '削除', icon: 'trash-2', danger: true, action: () => _deletePlaylist(pl.id) },
          ], r.left, r.bottom + 4);
        });
        tab.appendChild(menuBtn);
      }

      tab.addEventListener('click', () => selectPlaylist(pl.id));
      wrap.appendChild(tab);
    });
    lucide.createIcons({ elements: [wrap] });
  }

  function selectPlaylist(id) {
    AppState.setCurrentPlaylist(id);
    renderPlaylistTabs();
    trackListVS?.scrollToTop();
    refreshTrackList();
    // reset manual sort position
    el('player-sort-by').value = AppState.playerSortBy;
  }

  async function _editPlaylist(id) {
    const pl = AppState.getPlaylist(id);
    if (!pl) return;
    el('playlist-modal-title').textContent = '再生リストを編集';
    el('playlist-edit-id').value = id;
    el('playlist-name-input').value = pl.name;
    openModal('modal-playlist');
    setTimeout(() => el('playlist-name-input').focus(), 50);
  }

  async function _deletePlaylist(id) {
    const pl = AppState.getPlaylist(id);
    if (!pl) return;
    const ok = await Confirm.open(`「${pl.name}」を削除しますか？\n曲は削除されません。`, '再生リストを削除');
    if (!ok) return;
    AppState.removePlaylist(id);
    await Storage.deletePlaylist(id);
    renderPlaylistTabs();
    refreshTrackList();
    Toast.info('再生リストを削除しました');
  }

  /* ── Playlist modal save ── */
  function _bindPlaylistModal() {
    bindModalCloseByClass('js-close-playlist', 'modal-playlist');
    el('btn-save-playlist')?.addEventListener('click', async () => {
      const name = el('playlist-name-input')?.value.trim();
      if (!name) { Toast.error('リスト名を入力してください'); return; }
      const id = el('playlist-edit-id')?.value;
      if (id) {
        AppState.updatePlaylist({ id, name });
        await Storage.savePlaylist(AppState.getPlaylist(id));
        Toast.success('再生リスト名を変更しました');
      } else {
        const pl = { id: generateId(), name, isDefault: false, trackIds: [], createdAt: Date.now() };
        AppState.addPlaylist(pl);
        await Storage.savePlaylist(pl);
        Toast.success('再生リストを作成しました');
      }
      closeModal('modal-playlist');
      renderPlaylistTabs();
    });
    el('btn-new-playlist')?.addEventListener('click', () => {
      el('playlist-modal-title').textContent = '再生リストを作成';
      el('playlist-edit-id').value = '';
      el('playlist-name-input').value = '';
      openModal('modal-playlist');
      setTimeout(() => el('playlist-name-input').focus(), 50);
    });
  }

  /* ============================================================
     TRACK LIST (11)  —  VirtualList
     ============================================================ */

  function initTrackList() {
    trackListVS = new VirtualList({
      viewport:   el('track-list-viewport'),
      spacerTop:  el('tl-spacer-top'),
      content:    el('tl-content'),
      spacerBot:  el('tl-spacer-bot'),
      getItems:   () => AppState.getCurrentListTracks(),
      renderItem: renderTrackItem,
      rowHeight:  68,
    });
  }

  function refreshTrackList() {
    if (!trackListVS) return;
    const tracks = AppState.getCurrentListTracks();
    const empty  = el('track-list-empty');
    if (empty) empty.classList.toggle('hidden', tracks.length > 0);
    trackListVS.refresh();
  }

  function renderTrackItem(track, idx) {
    const wrap = document.createElement('div');
    wrap.className = `track-item${track.id === AppState.currentTrackId ? ' playing' : ''}${AppState.selectedIds.has(track.id) ? ' selected' : ''}`;
    wrap.dataset.trackId = track.id;
    wrap.style.height = '68px';

    const isManual = AppState.playerSortBy === 'manual';
    const pl = AppState.getPlaylist(AppState.currentPlaylistId);

    // Checkbox (multi-select)
    const chk = document.createElement('div');
    chk.className = `track-checkbox${AppState.selectedIds.has(track.id) ? ' checked' : ''}`;
    chk.style.display = AppState.isMultiSelect ? 'flex' : 'none';
    if (AppState.selectedIds.has(track.id)) chk.innerHTML = '<i data-lucide="check" style="width:12px;height:12px"></i>';
    chk.addEventListener('click', e => { e.stopPropagation(); _toggleSelect(track.id, chk, wrap); });
    wrap.appendChild(chk);

    // Thumbnail
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'track-thumb-wrap';
    if (track.thumbnail) {
      const img = document.createElement('img');
      img.className = 'track-thumb';
      img.src = track.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      thumbWrap.appendChild(img);
    } else {
      const def = document.createElement('div');
      def.className = 'track-thumb-default';
      def.innerHTML = '<i data-lucide="music" style="width:18px;height:18px"></i>';
      thumbWrap.appendChild(def);
    }
    // Playing indicator overlay
    if (track.id === AppState.currentTrackId && AppState.isPlaying) {
      const ind = document.createElement('div');
      ind.className = 'playing-indicator';
      ind.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(0,0,0,0.5);border-radius:3px;padding:2px;';
      ind.innerHTML = '<div class="playing-bar"></div><div class="playing-bar"></div><div class="playing-bar"></div>';
      thumbWrap.style.position = 'relative';
      thumbWrap.appendChild(ind);
    }
    wrap.appendChild(thumbWrap);

    // Track info
    const info = document.createElement('div');
    info.className = 'track-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'track-title truncate';
    titleEl.textContent = track.title || '不明のタイトル';
    const artistEl = document.createElement('div');
    artistEl.className = 'track-artist truncate';
    artistEl.textContent = getArtistNames(track);
    info.appendChild(titleEl);
    info.appendChild(artistEl);

    // Tags
    const sortedTags = [...track.tagIds]
      .map(id => getTag(id))
      .filter(Boolean)
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    if (sortedTags.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'track-tags';
      sortedTags.slice(0, 4).forEach(tag => {
        const dot = document.createElement('span');
        dot.className = 'tag-dot';
        dot.style.background = tag.color;
        dot.title = tag.name;
        tagsEl.appendChild(dot);
      });
      if (sortedTags.length > 4) {
        const more = document.createElement('span');
        more.className = 'text-xs text-muted';
        more.textContent = `+${sortedTags.length - 4}`;
        tagsEl.appendChild(more);
      }
      info.appendChild(tagsEl);
    }
    wrap.appendChild(info);

    // Duration
    const durEl = document.createElement('div');
    durEl.className = 'track-duration';
    durEl.textContent = formatTime(track.duration || 0);
    wrap.appendChild(durEl);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'track-actions';

    // Add to playlist
    const addBtn = _iconBtn('list-plus', 'リストに追加', async e => {
      e.stopPropagation();
      await openAddToPlaylistModal([track.id]);
    });
    actions.appendChild(addBtn);

    // Edit
    const editBtn = _iconBtn('pencil', '情報を編集', e => {
      e.stopPropagation();
      EditorScreen.openTrackEditModal(track.id);
    });
    actions.appendChild(editBtn);

    // Delete
    const delBtn = _iconBtn('trash-2', '削除', async e => {
      e.stopPropagation();
      await _deleteTrack(track.id);
    });
    actions.appendChild(delBtn);

    // Manual sort arrows
    if (isManual) {
      const arrows = document.createElement('div');
      arrows.className = 'order-arrows';
      const up = document.createElement('button');
      up.className = 'order-arrow';
      up.innerHTML = '<i data-lucide="chevron-up" style="width:12px;height:12px"></i>';
      up.addEventListener('click', e => { e.stopPropagation(); _moveTrack(track.id, -1); });
      const down = document.createElement('button');
      down.className = 'order-arrow';
      down.innerHTML = '<i data-lucide="chevron-down" style="width:12px;height:12px"></i>';
      down.addEventListener('click', e => { e.stopPropagation(); _moveTrack(track.id, 1); });
      arrows.appendChild(up);
      arrows.appendChild(down);
      actions.appendChild(arrows);
    }
    wrap.appendChild(actions);

    // Click → play (currently-playing row toggles play/pause instead of restarting)
    wrap.addEventListener('click', e => {
      if (AppState.isMultiSelect) { _toggleSelect(track.id, chk, wrap); return; }
      if (track.id === AppState.currentTrackId) {
        AudioEngine.togglePlay();
      } else {
        AudioEngine.play(track.id);
      }
    });

    lucide.createIcons({ elements: [wrap] });
    return wrap;
  }

  function _iconBtn(icon, title, handler) {
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.title = title;
    btn.innerHTML = `<i data-lucide="${icon}"></i>`;
    btn.addEventListener('click', handler);
    return btn;
  }

  function _toggleSelect(id, chkEl, rowEl) {
    AppState.toggleSelect(id);
    const checked = AppState.selectedIds.has(id);
    chkEl.classList.toggle('checked', checked);
    chkEl.innerHTML = checked ? '<i data-lucide="check" style="width:12px;height:12px"></i>' : '';
    rowEl.classList.toggle('selected', checked);
    lucide.createIcons({ elements: [chkEl] });
    _updateMsCount();
  }
  function _updateMsCount() {
    const n = AppState.selectedIds.size;
    const c = el('ms-count');
    if (c) c.textContent = `${n}件選択`;
  }

  async function _deleteTrack(id) {
    const track = AppState.getTrack(id);
    if (!track) return;
    const ok = await Confirm.open(`「${track.title}」を削除しますか？\nファイルおよび再生ログも削除されます。`, '曲を削除');
    if (!ok) return;
    const wasPlaying = AppState.currentTrackId === id;
    AppState.removeTrack(id);
    await Storage.deleteTrack(id);
    // DSP キャッシュ・Blob URL をページ内から解放してストレージを確実に減らす
    AudioEngine.clearTrackCache(id);
    await Storage.savePlaylists(AppState.playlists);
    refreshTrackList();
    if (wasPlaying) AudioEngine.next();
    Toast.success('削除しました');
    // ストレージ情報を更新（ブラウザの quota 会計が反映されるまで少し待つ）
    setTimeout(() => SettingsScreen.renderStorageInfo(), 800);
  }

  async function _moveTrack(trackId, dir) {
    const pl = AppState.getPlaylist(AppState.currentPlaylistId);
    if (!pl) return;
    const ids = [...pl.trackIds];
    const i = ids.indexOf(trackId);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    AppState.reorderPlaylistTracks(pl.id, ids);
    await Storage.savePlaylist(AppState.getPlaylist(pl.id));
    refreshTrackList();
  }

  /* ============================================================
     ADD TO PLAYLIST MODAL
     ============================================================ */

  async function openAddToPlaylistModal(trackIds) {
    const list = el('atp-list');
    if (!list) return;
    list.innerHTML = '';
    AppState.playlists.filter(p => !p.isDefault).forEach(pl => {
      const item = document.createElement('div');
      item.className = 'atp-item';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id   = `atp-${pl.id}`;
      const name = document.createElement('label');
      name.className = 'atp-item-name';
      name.htmlFor = `atp-${pl.id}`;
      name.textContent = pl.name;
      item.appendChild(chk);
      item.appendChild(name);
      item.addEventListener('click', () => { chk.checked = !chk.checked; });
      chk.addEventListener('click', e => e.stopPropagation());
      list.appendChild(item);
    });
    if (!AppState.playlists.filter(p => !p.isDefault).length) {
      list.innerHTML = '<p style="font-size:var(--text-sm);color:var(--color-text-3);padding:var(--sp-4)">再生リストがありません。先にリストを作成してください。</p>';
    }

    openModal('modal-atp');

    el('btn-atp-ok').onclick = async () => {
      const selected = [...list.querySelectorAll('input[type=checkbox]:checked')];
      for (const chk of selected) {
        const plId = chk.id.replace('atp-', '');
        const pl = AppState.getPlaylist(plId);
        if (!pl) continue;
        trackIds.forEach(tid => { if (!pl.trackIds.includes(tid)) pl.trackIds.push(tid); });
        await Storage.savePlaylist(pl);
      }
      closeModal('modal-atp');
      Toast.success(`${trackIds.length}件を追加しました`);
    };
  }

  /* ============================================================
     MULTI-SELECT
     ============================================================ */

  function _bindMultiSelect() {
    el('btn-multi-select')?.addEventListener('click', () => {
      const v = !AppState.isMultiSelect;
      AppState.setMultiSelect(v);
      el('btn-multi-select').classList.toggle('active', v);
      el('ms-toolbar')?.classList.toggle('hidden', !v);
      if (!v) AppState.clearSelection();
      refreshTrackList();
    });

    el('ms-select-all')?.addEventListener('click', () => {
      const ids = AppState.getCurrentListTracks().map(t => t.id);
      AppState.selectAll(ids);
      refreshTrackList();
      _updateMsCount();
    });
    el('ms-deselect')?.addEventListener('click', () => {
      AppState.clearSelection();
      refreshTrackList();
      _updateMsCount();
    });

    el('ms-add-playlist')?.addEventListener('click', async () => {
      const ids = [...AppState.selectedIds];
      if (!ids.length) { Toast.error('曲を選択してください'); return; }
      await openAddToPlaylistModal(ids);
    });

    el('ms-tag')?.addEventListener('click', async () => {
      const ids = [...AppState.selectedIds];
      if (!ids.length) { Toast.error('曲を選択してください'); return; }
      await _openAssignTagModal(ids);
    });

    el('ms-delete')?.addEventListener('click', async () => {
      const ids = [...AppState.selectedIds];
      if (!ids.length) return;
      const ok = await Confirm.open(`${ids.length}件の曲を削除しますか？`, '曲を削除');
      if (!ok) return;
      const wasPlayingId = AppState.currentTrackId;
      for (const id of ids) {
        AppState.removeTrack(id);
        await Storage.deleteTrack(id);
        // DSP キャッシュ・Blob URL を解放
        AudioEngine.clearTrackCache(id);
      }
      await Storage.savePlaylists(AppState.playlists);
      AppState.setMultiSelect(false);
      el('btn-multi-select').classList.remove('active');
      el('ms-toolbar').classList.add('hidden');
      refreshTrackList();
      // 再生中の曲が削除された場合は次の曲へ
      if (wasPlayingId && ids.includes(wasPlayingId)) {
        AudioEngine.next();
      }
      Toast.success(`${ids.length}件を削除しました`);
      setTimeout(() => SettingsScreen.renderStorageInfo(), 800);
    });
  }

  async function _openAssignTagModal(trackIds) {
    const list = el('atag-list');
    if (!list) return;
    list.innerHTML = '';
    AppState.tags.forEach(tag => {
      const item = document.createElement('div');
      item.className = 'at-item';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.id = `atag-${tag.id}`;
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tag.color;
      const name = document.createElement('label');
      name.className = 'atp-item-name';
      name.htmlFor = `atag-${tag.id}`;
      name.textContent = tag.name;
      item.appendChild(chk);
      item.appendChild(dot);
      item.appendChild(name);
      item.addEventListener('click', () => { chk.checked = !chk.checked; });
      chk.addEventListener('click', e => e.stopPropagation());
      list.appendChild(item);
    });
    if (!AppState.tags.length) {
      list.innerHTML = '<p style="font-size:var(--text-sm);color:var(--color-text-3);padding:var(--sp-4)">タグがありません。編集画面からタグを作成してください。</p>';
    }
    openModal('modal-atag');
    el('btn-atag-ok').onclick = async () => {
      const selTags = [...list.querySelectorAll('input:checked')].map(c => c.id.replace('atag-', ''));
      trackIds.forEach(tid => {
        const t = AppState.getTrack(tid);
        if (!t) return;
        selTags.forEach(tagId => { if (!t.tagIds.includes(tagId)) t.tagIds.push(tagId); });
      });
      await Storage.saveTracks(AppState.tracks);
      closeModal('modal-atag');
      refreshTrackList();
      Toast.success('タグを付与しました');
    };
  }

  /* ============================================================
     SEARCH & SORT
     ============================================================ */

  function _bindSearchSort() {
    el('player-search')?.addEventListener('input', debounce(e => {
      AppState.playerSearch = e.target.value;
      refreshTrackList();
    }, 250));

    el('player-sort-by')?.addEventListener('change', e => {
      AppState.playerSortBy = e.target.value;
      trackListVS?.scrollToTop();
      refreshTrackList();
    });

    const orderBtn = el('player-sort-order');
    orderBtn?.addEventListener('click', () => {
      AppState.playerSortOrder = AppState.playerSortOrder === 'asc' ? 'desc' : 'asc';
      orderBtn.classList.toggle('asc',  AppState.playerSortOrder === 'asc');
      orderBtn.classList.toggle('desc', AppState.playerSortOrder === 'desc');
      trackListVS?.scrollToTop();
      refreshTrackList();
    });
  }

  /* ============================================================
     FILE UPLOAD MODAL
     ============================================================ */

  function _bindUploadModal() {
    el('btn-open-upload')?.addEventListener('click', () => {
      pendingFiles = [];
      el('file-staging').innerHTML = '';
      el('upload-progress-area').classList.add('hidden');
      el('btn-upload-confirm').disabled = true;
      openModal('modal-upload');
    });

    bindModalCloseByClass('js-close-upload', 'modal-upload');

    el('btn-select-files')?.addEventListener('click', () => el('file-input').click());
    el('file-input')?.addEventListener('change', e => _addFiles([...e.target.files]));

    const zone = el('drop-zone');
    if (zone) {
      zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        _addFiles([...e.dataTransfer.files]);
      });
      zone.addEventListener('click', e => { if (e.target === zone || e.target.classList.contains('drop-text') || e.target.classList.contains('drop-icon')) el('file-input').click(); });
    }

    el('btn-upload-confirm')?.addEventListener('click', _uploadFiles);
  }

  async function _addFiles(files) {
    const audioFiles = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|aac|m4a|opus)$/i.test(f.name));
    if (!audioFiles.length) { Toast.error('音声ファイルを選択してください'); return; }

    for (const file of audioFiles) {
      if (pendingFiles.find(p => p.file.name === file.name && p.file.size === file.size)) continue;
      const entry = { file, title: file.name.replace(/\.[^.]+$/, ''), artist: '', thumbnail: null, releaseDate: null, duration: 0, id: generateId() };
      pendingFiles.push(entry);
      await _renderStageItem(entry);
    }
    el('btn-upload-confirm').disabled = pendingFiles.length === 0;
  }

  async function _renderStageItem(entry) {
    const list = el('file-staging');
    if (!list) return;

    const item = document.createElement('div');
    item.className = 'stage-item';
    item.id = `stage-${entry.id}`;

    const thumbImg = document.createElement('img');
    thumbImg.className = 'stage-thumb';
    thumbImg.alt = '';
    item.appendChild(thumbImg);

    const info = document.createElement('div');
    info.className = 'stage-info';
    const name = document.createElement('div');
    name.className = 'stage-name';
    name.textContent = entry.title;
    const sub = document.createElement('div');
    sub.className = 'stage-sub';
    sub.textContent = '読み込み中...';
    info.appendChild(name);
    info.appendChild(sub);
    item.appendChild(info);

    const remove = document.createElement('button');
    remove.className = 'stage-remove';
    remove.innerHTML = '<i data-lucide="x" style="width:14px;height:14px"></i>';
    remove.addEventListener('click', () => {
      pendingFiles = pendingFiles.filter(p => p.id !== entry.id);
      item.remove();
      el('btn-upload-confirm').disabled = pendingFiles.length === 0;
    });
    item.appendChild(remove);
    list.appendChild(item);
    lucide.createIcons({ elements: [item] });

    // Extract metadata asynchronously
    try {
      const meta = await Metadata.extract(entry.file);
      entry.title      = meta.title;
      entry.artist     = meta.artist;
      entry.thumbnail  = meta.thumbnail;
      entry.releaseDate = meta.releaseDate;
      entry.duration   = meta.duration;

      name.textContent = meta.title;
      sub.textContent  = `${meta.artist || '不明のアーティスト'}${meta.duration ? ' · ' + formatTime(meta.duration) : ''}`;
      if (meta.thumbnail) { thumbImg.src = meta.thumbnail; }
    } catch { sub.textContent = 'メタデータ読み込み失敗'; }
  }

  async function _uploadFiles() {
    if (!pendingFiles.length) return;
    const area = el('upload-progress-area');
    area.classList.remove('hidden');
    el('btn-upload-confirm').disabled = true;

    const total = pendingFiles.length;
    let done = 0;

    for (const entry of pendingFiles) {
      el('upload-prog-text').textContent = `追加中... (${done + 1}/${total})`;
      el('upload-prog-pct').textContent  = `${Math.round(((done + 1) / total) * 100)}%`;
      el('upload-prog-bar').style.width  = `${((done + 1) / total) * 100}%`;

      try {
        // Get or create artist
        let artistIds = [];
        if (entry.artist) {
          let artist = AppState.artists.find(a => a.name.toLowerCase() === entry.artist.toLowerCase());
          if (!artist) {
            artist = { id: generateId(), name: entry.artist, icon: null, createdAt: Date.now() };
            AppState.addArtist(artist);
            await Storage.saveArtist(artist);
          }
          artistIds = [artist.id];
        }

        const track = {
          id: entry.id, title: entry.title, artistIds, tagIds: [],
          releaseDate: entry.releaseDate, thumbnail: entry.thumbnail,
          duration: entry.duration, addedAt: Date.now(), manualOrder: AppState.tracks.length,
        };
        AppState.addTrack(track);
        await Storage.saveTrack(track);

        // Save audio file
        const buf = await fileToArrayBuffer(entry.file);
        await Storage.saveAudioFile(track.id, buf);

      } catch(e) { console.error('Upload error:', e); Toast.error(`「${entry.title}」の追加に失敗しました`); }

      done++;
    }

    // Persist playlists (all tracks playlist was updated)
    await Storage.savePlaylists(AppState.playlists);

    closeModal('modal-upload');
    pendingFiles = [];
    el('file-input').value = '';
    refreshTrackList();
    renderPlaylistTabs();
    Toast.success(`${done}件の曲を追加しました`);
  }

  /* ============================================================
     EventBus subscriptions
     ============================================================ */

  function _bindEvents() {
    EventBus.on('track:change',      () => { PlayerWidgetUI.updateTrack(); refreshTrackList(); });
    EventBus.on('playback:update',   () => {
      PlayerWidgetUI.updatePlayState();
      PlayerWidgetUI.updateShuffle();
      PlayerWidgetUI.updateRepeat();
      PlayerWidgetUI.updateSpeed();
      PlayerWidgetUI.updateVolume();
    });
    EventBus.on('playback:progress', () => PlayerWidgetUI.updateProgress());
    EventBus.on('data:tracks',       () => { refreshTrackList(); });
    EventBus.on('data:playlists',    () => { renderPlaylistTabs(); refreshTrackList(); });
    EventBus.on('data:tags',         () => refreshTrackList());
    EventBus.on('data:artists',      () => refreshTrackList());
    EventBus.on('select:update',     () => _updateMsCount());
  }

  /* ============================================================
     INIT
     ============================================================ */

  function init() {
    _bindPlayerControls();
    _bindPlaylistModal();
    _bindSearchSort();
    _bindMultiSelect();
    _bindUploadModal();
    bindModalCloseByClass('js-close-atp',  'modal-atp');
    bindModalCloseByClass('js-close-atag', 'modal-atag');
    initTrackList();
    _bindEvents();
  }

  return {
    init,
    refreshTrackList,
    renderPlaylistTabs,
    openAddToPlaylistModal,
    PlayerWidgetUI,
  };
})();
