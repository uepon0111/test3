'use strict';

/* ============================================================
   EDITOR SCREEN  —  情報編集画面
   ============================================================ */

const EditorScreen = (() => {

  let gridVS     = null;  // VirtualGrid
  let editTagIds     = []; // editing track's tags
  let editArtistIds  = []; // editing track's artists

  /* ============================================================
     SUB-SECTION NAVIGATION  (14)(15)(16)
     ============================================================ */

  function _bindSubNav() {
    document.querySelectorAll('[data-subsec]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.subsec;
        AppState.editorSection = sec;

        document.querySelectorAll('.subnav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.editor-subsection').forEach(s => s.classList.remove('active'));
        el(`subsec-${sec}`)?.classList.add('active');

        if (sec === 'tracks')  refreshGrid();
        if (sec === 'tags')    renderTagList();
        if (sec === 'artists') renderArtistList();
      });
    });
  }

  /* ============================================================
     EDITOR TRACK GRID (21)
     ============================================================ */

  function _getCardHeight() {
    const vp   = el('editor-grid-viewport');
    if (!vp || !vp.clientWidth) return 260;
    const cols = AppState.editorColumns;
    const gap  = 12, pad = 32;
    const w    = Math.max(80, Math.floor((vp.clientWidth - pad - gap * (cols - 1)) / cols));
    return w + 82; // thumbnail + info area
  }

  function initGrid() {
    gridVS = new VirtualGrid({
      viewport:   el('editor-grid-viewport'),
      spacerTop:  el('eg-spacer-top'),
      content:    el('eg-content'),
      spacerBot:  el('eg-spacer-bot'),
      getItems:   () => AppState.getEditorTracks(),
      renderItem: renderGridCard,
      getColumns: () => AppState.editorColumns,
      cardHeight: _getCardHeight(),
    });
  }

  function refreshGrid() {
    if (!gridVS) return;
    gridVS.CARD_H = _getCardHeight();
    const tracks = AppState.getEditorTracks();
    el('editor-grid-empty')?.classList.toggle('hidden', tracks.length > 0);
    gridVS.refresh();
  }

  function renderGridCard(track, idx) {
    const card = document.createElement('div');
    card.className = 'grid-card';
    card.dataset.trackId = track.id;

    // Thumbnail
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'grid-card-thumb-wrap';
    if (track.thumbnail) {
      const img = document.createElement('img');
      img.className = 'grid-card-thumb';
      img.src = track.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      thumbWrap.appendChild(img);
    } else {
      const def = document.createElement('div');
      def.className = 'grid-card-thumb-default';
      def.innerHTML = '<i data-lucide="music"></i>';
      thumbWrap.appendChild(def);
    }
    card.appendChild(thumbWrap);

    // Info
    const info = document.createElement('div');
    info.className = 'grid-card-info';

    const title = document.createElement('div');
    title.className = 'grid-card-title truncate';
    title.textContent = track.title || '—';

    const artist = document.createElement('div');
    artist.className = 'grid-card-artist truncate';
    artist.textContent = getArtistNames(track);

    const date = document.createElement('div');
    date.className = 'grid-card-date';
    date.textContent = track.releaseDate ? formatDateDisplay(track.releaseDate) : '';

    info.appendChild(title);
    info.appendChild(artist);
    if (track.releaseDate) info.appendChild(date);

    // Tags
    const sortedTags = [...track.tagIds]
      .map(id => getTag(id)).filter(Boolean)
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    if (sortedTags.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'grid-card-tags';
      sortedTags.slice(0, 5).forEach(t => {
        const dot = document.createElement('span');
        dot.className = 'tag-dot';
        dot.style.background = t.color;
        dot.title = t.name;
        tagsEl.appendChild(dot);
      });
      info.appendChild(tagsEl);
    }
    card.appendChild(info);

    // Click → open edit modal
    card.addEventListener('click', () => openTrackEditModal(track.id));
    lucide.createIcons({ elements: [card] });
    return card;
  }

  /* ─── Columns button ─── */
  function _bindColumnToggle() {
    const btn = el('editor-cols-btn');
    const lbl = el('editor-cols-label');
    if (!btn) return;
    const isPortrait = () => window.innerWidth <= window.innerHeight;
    const cycles = () => isPortrait() ? [2, 3] : [4, 6];
    btn.addEventListener('click', () => {
      const cs = cycles();
      const idx = cs.indexOf(AppState.editorColumns);
      AppState.editorColumns = cs[(idx + 1) % cs.length];
      if (lbl) lbl.textContent = `${AppState.editorColumns}列`;
      refreshGrid();
    });
  }

  /* ─── Search & Sort ─── */
  function _bindSearchSort() {
    el('editor-search')?.addEventListener('input', debounce(e => {
      AppState.editorSearch = e.target.value;
      refreshGrid();
    }, 250));
    el('editor-sort-by')?.addEventListener('change', e => {
      AppState.editorSortBy = e.target.value;
      refreshGrid();
    });
    const ob = el('editor-sort-order');
    ob?.addEventListener('click', () => {
      AppState.editorSortOrder = AppState.editorSortOrder === 'asc' ? 'desc' : 'asc';
      ob.classList.toggle('asc',  AppState.editorSortOrder === 'asc');
      ob.classList.toggle('desc', AppState.editorSortOrder === 'desc');
      refreshGrid();
    });
  }

  /* ============================================================
     TRACK EDIT MODAL
     ============================================================ */

  function openTrackEditModal(trackId) {
    const track = AppState.getTrack(trackId);
    if (!track) return;

    el('edit-track-id').value  = trackId;
    el('edit-title').value     = track.title || '';
    el('edit-release-date').value = track.releaseDate || '';

    // Thumbnail
    const prev = el('edit-thumb-preview');
    const def  = el('edit-thumb-default');
    if (track.thumbnail) {
      prev.src = track.thumbnail; prev.style.display = 'block'; def.style.display = 'none';
    } else {
      prev.src = ''; prev.style.display = 'none'; def.style.display = 'flex';
    }

    // Artists
    editArtistIds = [...track.artistIds];
    _renderArtistChips();

    // Tags
    editTagIds = [...track.tagIds];
    _renderTagChips();

    openModal('modal-track-edit');
    setTimeout(() => el('edit-title').focus(), 50);
  }

  function _renderArtistChips() {
    const area = el('artist-chips');
    if (!area) return;
    area.innerHTML = '';
    editArtistIds.forEach(id => {
      const a = getArtist(id);
      if (!a) return;
      const chip = _chip(a.name, 'artist', () => {
        editArtistIds = editArtistIds.filter(x => x !== id);
        _renderArtistChips();
      });
      area.appendChild(chip);
    });
  }

  function _renderTagChips() {
    const area = el('tag-chips');
    if (!area) return;
    area.innerHTML = '';
    editTagIds.forEach(id => {
      const t = getTag(id);
      if (!t) return;
      const chip = _chip(t.name, 'tag', () => {
        editTagIds = editTagIds.filter(x => x !== id);
        _renderTagChips();
      }, t.color, t.id);
      area.appendChild(chip);
    });
  }

  function _chip(label, type, onRemove, color, tagId) {
    const c = document.createElement('span');
    c.className = `chip chip--${type}`;
    if (color) c.style.background = color;

    /* タグチップには色変更スウォッチを追加（曲情報編集画面からタグの色を自由に設定できるように） */
    if (type === 'tag' && tagId) {
      const swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.className = 'chip-color-swatch';
      swatch.value = color || '#3b82f6';
      swatch.title = 'タグの色を変更';
      swatch.addEventListener('click', e => e.stopPropagation());
      swatch.addEventListener('input', e => {
        c.style.background = e.target.value;
      });
      // Chrome では color input の change イベントがドラッグ中も連続発火するため
      // debounce でまとめて保存し、Toast やリスト再描画が大量に起きないようにする
      const _saveTagColor = debounce(async (newColor) => {
        const tag = AppState.tags.find(x => x.id === tagId);
        if (!tag) return;
        AppState.updateTag({ id: tagId, color: newColor });
        await Storage.saveTag(AppState.tags.find(x => x.id === tagId));
        PlayerScreen.refreshTrackList();
        refreshGrid();
        if (AppState.editorSection === 'tags') renderTagList();
        Toast.success('タグの色を変更しました');
      }, 400);
      swatch.addEventListener('change', e => {
        c.style.background = e.target.value;
        _saveTagColor(e.target.value);
      });
      c.appendChild(swatch);
    }

    c.appendChild(document.createTextNode(label));
    const x = document.createElement('span');
    x.className = 'chip-remove';
    x.innerHTML = '×';
    x.addEventListener('click', onRemove);
    c.appendChild(x);
    return c;
  }

  /* ─── Artist input + dropdown ─── */
  function _bindArtistInput() {
    const input = el('artist-input');
    const dd    = el('artist-dropdown');
    if (!input || !dd) return;

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { dd.classList.add('hidden'); return; }
      const matches = AppState.artists.filter(a => a.name.toLowerCase().includes(q) && !editArtistIds.includes(a.id));
      dd.innerHTML = '';
      matches.slice(0, 8).forEach(a => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = a.name;
        item.addEventListener('click', () => {
          if (!editArtistIds.includes(a.id)) editArtistIds.push(a.id);
          _renderArtistChips();
          input.value = ''; dd.classList.add('hidden');
        });
        dd.appendChild(item);
      });
      // Create new option
      if (!AppState.artists.find(a => a.name.toLowerCase() === q)) {
        const create = document.createElement('div');
        create.className = 'suggestion-item suggestion-create';
        create.textContent = `「${input.value.trim()}」を新規作成`;
        create.addEventListener('click', async () => {
          const name   = input.value.trim();
          const artist = { id: generateId(), name, icon: null, createdAt: Date.now() };
          AppState.addArtist(artist);
          await Storage.saveArtist(artist);
          editArtistIds.push(artist.id);
          _renderArtistChips();
          input.value = ''; dd.classList.add('hidden');
        });
        dd.appendChild(create);
      }
      dd.classList.toggle('hidden', dd.children.length === 0);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        const existing = AppState.artists.find(a => a.name.toLowerCase() === q.toLowerCase());
        if (existing && !editArtistIds.includes(existing.id)) {
          editArtistIds.push(existing.id);
        } else if (!existing) {
          const a = { id: generateId(), name: q, icon: null, createdAt: Date.now() };
          AppState.addArtist(a);
          Storage.saveArtist(a);
          editArtistIds.push(a.id);
        }
        _renderArtistChips();
        input.value = ''; dd.classList.add('hidden');
      }
    });
    document.addEventListener('click', e => {
      if (!input.contains(e.target) && !dd.contains(e.target)) dd.classList.add('hidden');
    });
  }

  /* ─── Tag input + dropdown ─── */
  function _bindTagInput() {
    const input = el('tag-input');
    const dd    = el('tag-dropdown');
    if (!input || !dd) return;

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { dd.classList.add('hidden'); return; }
      const matches = AppState.tags.filter(t => t.name.toLowerCase().includes(q) && !editTagIds.includes(t.id));
      dd.innerHTML = '';
      matches.slice(0, 8).forEach(t => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        const dot = document.createElement('span');
        dot.className = 'tag-dot';
        dot.style.background = t.color;
        dot.style.marginRight = '8px';
        item.appendChild(dot);
        item.appendChild(document.createTextNode(t.name));
        item.addEventListener('click', () => {
          if (!editTagIds.includes(t.id)) editTagIds.push(t.id);
          _renderTagChips();
          input.value = ''; dd.classList.add('hidden');
        });
        dd.appendChild(item);
      });
      if (!AppState.tags.find(t => t.name.toLowerCase() === q)) {
        const create = document.createElement('div');
        create.className = 'suggestion-item suggestion-create';
        create.textContent = `「${input.value.trim()}」を新規タグとして追加`;
        create.addEventListener('click', async () => {
          const name = input.value.trim();
          const tag  = { id: generateId(), name, color: '#3b82f6', displayOrder: AppState.tags.length, createdAt: Date.now() };
          AppState.addTag(tag);
          await Storage.saveTag(tag);
          editTagIds.push(tag.id);
          _renderTagChips();
          input.value = ''; dd.classList.add('hidden');
        });
        dd.appendChild(create);
      }
      dd.classList.toggle('hidden', dd.children.length === 0);
    });

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        const existing = AppState.tags.find(t => t.name.toLowerCase() === q.toLowerCase());
        if (existing && !editTagIds.includes(existing.id)) {
          editTagIds.push(existing.id);
        } else if (!existing) {
          const tag = { id: generateId(), name: q, color: '#3b82f6', displayOrder: AppState.tags.length, createdAt: Date.now() };
          AppState.addTag(tag);
          Storage.saveTag(tag);
          editTagIds.push(tag.id);
        }
        _renderTagChips();
        input.value = ''; dd.classList.add('hidden');
      }
    });
    document.addEventListener('click', e => {
      if (!input.contains(e.target) && !dd.contains(e.target)) dd.classList.add('hidden');
    });
  }

  /* ─── Thumbnail edit ─── */
  function _bindThumbEdit() {
    el('btn-change-thumb')?.addEventListener('click', () => el('thumb-input').click());
    el('thumb-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const url = await fileToDataUrl(file);
      el('edit-thumb-preview').src = url;
      el('edit-thumb-preview').style.display = 'block';
      el('edit-thumb-default').style.display = 'none';
    });
    el('btn-remove-thumb')?.addEventListener('click', () => {
      el('edit-thumb-preview').src = '';
      el('edit-thumb-preview').style.display = 'none';
      el('edit-thumb-default').style.display = 'flex';
    });
  }

  /* ─── Save track edit ─── */
  function _bindTrackEditSave() {
    bindModalCloseByClass('js-close-track-edit', 'modal-track-edit');
    el('btn-track-edit-save')?.addEventListener('click', async () => {
      const id = el('edit-track-id').value;
      if (!id) return;
      const thumbnail = el('edit-thumb-preview').style.display !== 'none' && el('edit-thumb-preview').src
        ? el('edit-thumb-preview').src : null;
      const updated = {
        id,
        title:       el('edit-title').value.trim() || '不明のタイトル',
        artistIds:   [...editArtistIds],
        tagIds:      [...editTagIds],
        releaseDate: el('edit-release-date').value || null,
        thumbnail,
      };
      AppState.updateTrack(updated);
      await Storage.saveTrack(AppState.getTrack(id));
      closeModal('modal-track-edit');
      refreshGrid();
      PlayerScreen.refreshTrackList();
      PlayerScreen.PlayerWidgetUI.updateTrack();
      Toast.success('保存しました');
    });
  }

  /* ============================================================
     TAG MANAGEMENT (22)(23)
     ============================================================ */

  const TAG_COLOR_PRESETS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899','#64748b','#1e293b'];

  function renderTagList() {
    const list  = el('tag-list');
    const empty = el('tag-list-empty');
    if (!list) return;
    list.innerHTML = '';
    const tags = [...AppState.tags].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    if (!tags.length) { empty?.classList.remove('hidden'); return; }
    empty?.classList.add('hidden');

    tags.forEach((tag, i) => {
      const item = document.createElement('div');
      item.className = 'tag-item';

      const icon = document.createElement('span');
      icon.className = 'tag-item-icon tag-dot--lg';
      icon.style.background = tag.color;
      const name = document.createElement('div');
      name.className = 'tag-item-name';
      name.textContent = tag.name;

      // count
      const count = AppState.tracks.filter(t => t.tagIds.includes(tag.id)).length;
      const countEl = document.createElement('span');
      countEl.className = 'tag-item-count';
      countEl.textContent = `${count}曲`;

      const actions = document.createElement('div');
      actions.className = 'tag-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn'; editBtn.title = '編集';
      editBtn.innerHTML = '<i data-lucide="pencil"></i>';
      editBtn.addEventListener('click', () => _openTagModal(tag.id));

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn'; delBtn.title = '削除';
      delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
      delBtn.style.color = 'var(--color-danger)';
      delBtn.addEventListener('click', async () => {
        const ok = await Confirm.open(`タグ「${tag.name}」を削除しますか？\n全曲からこのタグが削除されます。`, 'タグを削除');
        if (!ok) return;
        AppState.removeTag(tag.id);
        await Storage.deleteTag(tag.id);
        await Storage.saveTracks(AppState.tracks);
        renderTagList();
        Toast.success('タグを削除しました');
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      // Order arrows
      const arrows = document.createElement('div');
      arrows.className = 'order-arrows';
      const up = document.createElement('button');
      up.className = 'order-arrow'; up.disabled = i === 0;
      up.innerHTML = '<i data-lucide="chevron-up"></i>';
      up.addEventListener('click', async () => {
        if (i <= 0) return;
        // Find both tags in AppState.tags by id (sorted copy indices ≠ AppState array indices)
        const tagA = AppState.tags.find(t => t.id === tags[i].id);
        const tagB = AppState.tags.find(t => t.id === tags[i - 1].id);
        if (!tagA || !tagB) return;
        [tagA.displayOrder, tagB.displayOrder] = [tagB.displayOrder, tagA.displayOrder];
        AppState.tags.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
        await Storage.saveTags(AppState.tags);
        renderTagList();
      });
      const dn = document.createElement('button');
      dn.className = 'order-arrow'; dn.disabled = i === tags.length - 1;
      dn.innerHTML = '<i data-lucide="chevron-down"></i>';
      dn.addEventListener('click', async () => {
        if (i >= tags.length - 1) return;
        const tagA = AppState.tags.find(t => t.id === tags[i].id);
        const tagB = AppState.tags.find(t => t.id === tags[i + 1].id);
        if (!tagA || !tagB) return;
        [tagA.displayOrder, tagB.displayOrder] = [tagB.displayOrder, tagA.displayOrder];
        AppState.tags.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
        await Storage.saveTags(AppState.tags);
        renderTagList();
      });
      arrows.appendChild(up); arrows.appendChild(dn);

      item.appendChild(icon); item.appendChild(name); item.appendChild(countEl);
      item.appendChild(actions); item.appendChild(arrows);
      list.appendChild(item);
    });
    lucide.createIcons({ elements: [list] });
  }

  function _openTagModal(tagId) {
    const tag = tagId ? AppState.tags.find(t => t.id === tagId) : null;
    el('tag-modal-title').textContent = tag ? 'タグを編集' : 'タグを作成';
    el('tag-edit-id').value    = tagId || '';
    el('tag-name-input').value = tag?.name || '';
    el('tag-color-input').value = tag?.color || '#3b82f6';

    // Render color presets
    const presets = el('tag-color-presets');
    if (presets) {
      presets.innerHTML = '';
      TAG_COLOR_PRESETS.forEach(c => {
        const btn = document.createElement('button');
        btn.className = `color-preset${(tag?.color === c || (!tag && c === '#3b82f6')) ? ' selected' : ''}`;
        btn.style.background = c;
        btn.title = c;
        btn.addEventListener('click', () => {
          el('tag-color-input').value = c;
          presets.querySelectorAll('.color-preset').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
        });
        presets.appendChild(btn);
      });
    }
    openModal('modal-tag');
    setTimeout(() => el('tag-name-input').focus(), 50);
  }

  function _bindTagModal() {
    el('btn-new-tag')?.addEventListener('click', () => _openTagModal(null));
    bindModalCloseByClass('js-close-tag', 'modal-tag');
    el('btn-save-tag')?.addEventListener('click', async () => {
      const name  = el('tag-name-input')?.value.trim();
      const color = el('tag-color-input')?.value || '#3b82f6';
      if (!name) { Toast.error('タグ名を入力してください'); return; }
      const id = el('tag-edit-id')?.value;
      if (id) {
        AppState.updateTag({ id, name, color });
        await Storage.saveTag(AppState.tags.find(t => t.id === id));
      } else {
        const tag = { id: generateId(), name, color, displayOrder: AppState.tags.length, createdAt: Date.now() };
        AppState.addTag(tag);
        await Storage.saveTag(tag);
      }
      closeModal('modal-tag');
      renderTagList();
      Toast.success('保存しました');
    });
  }

  /* ============================================================
     ARTIST MANAGEMENT (24)(25)
     ============================================================ */

  function renderArtistList() {
    const list  = el('artist-list');
    const empty = el('artist-list-empty');
    if (!list) return;
    list.innerHTML = '';
    const artists = AppState.artists;
    if (!artists.length) { empty?.classList.remove('hidden'); return; }
    empty?.classList.add('hidden');

    artists.forEach(a => {
      const item = document.createElement('div');
      item.className = 'artist-item';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'artist-item-icon';
      if (a.icon) {
        const img = document.createElement('img');
        img.src = a.icon; img.alt = a.name; img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
        iconWrap.appendChild(img);
      } else {
        const def = document.createElement('div');
        def.className = 'artist-icon-placeholder';
        def.innerHTML = '<i data-lucide="user"></i>';
        iconWrap.appendChild(def);
      }

      const info = document.createElement('div');
      info.className = 'artist-item-info';
      const name = document.createElement('div');
      name.className = 'artist-item-name';
      name.textContent = a.name;
      const count = AppState.tracks.filter(t => t.artistIds.includes(a.id)).length;
      const countEl = document.createElement('div');
      countEl.className = 'artist-item-count';
      countEl.textContent = `${count}曲`;
      info.appendChild(name); info.appendChild(countEl);

      const actions = document.createElement('div');
      actions.className = 'artist-item-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'icon-btn'; editBtn.title = '編集';
      editBtn.innerHTML = '<i data-lucide="pencil"></i>';
      editBtn.addEventListener('click', () => _openArtistModal(a.id));
      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn'; delBtn.title = '削除';
      delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
      delBtn.style.color = 'var(--color-danger)';
      delBtn.addEventListener('click', async () => {
        const ok = await Confirm.open(`アーティスト「${a.name}」を削除しますか？\n全曲からこのアーティストが削除されます。`, 'アーティストを削除');
        if (!ok) return;
        AppState.removeArtist(a.id);
        await Storage.deleteArtist(a.id);
        await Storage.saveTracks(AppState.tracks);
        renderArtistList();
        Toast.success('アーティストを削除しました');
      });
      actions.appendChild(editBtn); actions.appendChild(delBtn);

      item.appendChild(iconWrap); item.appendChild(info); item.appendChild(actions);
      list.appendChild(item);
    });
    lucide.createIcons({ elements: [list] });
  }

  function _openArtistModal(artistId) {
    const a = artistId ? AppState.artists.find(x => x.id === artistId) : null;
    el('artist-modal-title').textContent = a ? 'アーティストを編集' : 'アーティストを作成';
    el('artist-edit-id').value      = artistId || '';
    el('artist-name-input').value   = a?.name || '';
    const prev = el('artist-icon-preview'), def = el('artist-icon-default');
    if (a?.icon) { prev.src = a.icon; prev.style.display = 'block'; def.style.display = 'none'; }
    else         { prev.src = '';     prev.style.display = 'none';  def.style.display = 'flex'; }
    openModal('modal-artist');
    setTimeout(() => el('artist-name-input').focus(), 50);
  }

  function _bindArtistModal() {
    el('btn-new-artist')?.addEventListener('click', () => _openArtistModal(null));
    bindModalCloseByClass('js-close-artist', 'modal-artist');

    el('btn-change-artist-icon')?.addEventListener('click', () => el('artist-icon-input').click());
    el('artist-icon-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const url = await fileToDataUrl(file);
      el('artist-icon-preview').src = url;
      el('artist-icon-preview').style.display = 'block';
      el('artist-icon-default').style.display = 'none';
    });
    el('btn-remove-artist-icon')?.addEventListener('click', () => {
      el('artist-icon-preview').src = '';
      el('artist-icon-preview').style.display = 'none';
      el('artist-icon-default').style.display = 'flex';
    });

    el('btn-save-artist')?.addEventListener('click', async () => {
      const name = el('artist-name-input')?.value.trim();
      if (!name) { Toast.error('アーティスト名を入力してください'); return; }
      const icon = el('artist-icon-preview').style.display !== 'none' && el('artist-icon-preview').src
        ? el('artist-icon-preview').src : null;
      const id = el('artist-edit-id')?.value;
      if (id) {
        AppState.updateArtist({ id, name, icon });
        await Storage.saveArtist(AppState.artists.find(a => a.id === id));
      } else {
        const artist = { id: generateId(), name, icon, createdAt: Date.now() };
        AppState.addArtist(artist);
        await Storage.saveArtist(artist);
      }
      closeModal('modal-artist');
      renderArtistList();
      Toast.success('保存しました');
    });
  }

  /* ============================================================
     EventBus subscriptions
     ============================================================ */

  function _bindEvents() {
    EventBus.on('data:tracks',  () => { if (AppState.editorSection === 'tracks') refreshGrid(); });
    EventBus.on('data:tags',    () => { if (AppState.editorSection === 'tags') renderTagList(); });
    EventBus.on('data:artists', () => { if (AppState.editorSection === 'artists') renderArtistList(); });

    // When switching TO the editor screen, refresh the visible sub-section.
    // setTimeout(30) lets the screen render first so clientWidth/clientHeight are non-zero.
    EventBus.on('screen:change', s => {
      if (s !== 'editor') return;
      setTimeout(() => {
        if (AppState.editorSection === 'tracks')  refreshGrid();
        if (AppState.editorSection === 'tags')    renderTagList();
        if (AppState.editorSection === 'artists') renderArtistList();
      }, 30);
    });
  }

  /* ============================================================
     INIT
     ============================================================ */

  function init() {
    _bindSubNav();
    _bindSearchSort();
    _bindColumnToggle();
    initGrid();
    _bindThumbEdit();
    _bindArtistInput();
    _bindTagInput();
    _bindTrackEditSave();
    _bindTagModal();
    _bindArtistModal();
    _bindEvents();
  }

  return { init, refreshGrid, renderTagList, renderArtistList, openTrackEditModal };
})();
