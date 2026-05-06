'use strict';
/* ================================================
   List  –  file list screen
   ================================================ */
const List = (() => {
  /* State */
  let _sortKey   = 'date';   /* 'date' | 'name' */
  let _sortAsc   = false;
  let _search    = '';
  let _filterIds = new Set();  /* active tag filter (OR logic) */
  let _nameFileId = null;

  /* ══════════════════════════════════════════════
     RENDER FILE LIST
     ══════════════════════════════════════════════ */
  function renderFileList() {
    let files = Storage.getFiles();
    const allFiles = files;

    /* Search filter (name OR tag names) */
    if (_search) {
      const q = _search.toLowerCase();
      const tags = Storage.getTags();
      files = files.filter(f => {
        if (f.name.toLowerCase().includes(q)) return true;
        return (f.tagIds || []).some(tid => {
          const t = tags.find(x => x.id === tid);
          return t && t.name.toLowerCase().includes(q);
        });
      });
    }

    /* Tag filter (OR: file has at least one selected tag) */
    if (_filterIds.size > 0) {
      files = files.filter(f =>
        [..._filterIds].some(tid => (f.tagIds || []).includes(tid))
      );
    }

    /* Sort */
    files = files.slice().sort((a, b) => {
      let cmp = 0;
      if (_sortKey === 'name') {
        cmp = a.name.localeCompare(b.name, 'ja');
      } else {
        cmp = a.addedAt - b.addedAt;
      }
      return _sortAsc ? cmp : -cmp;
    });

    const grid  = document.getElementById('file-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';

    if (allFiles.length === 0) {
      empty.removeAttribute('hidden');
      return;
    }
    empty.setAttribute('hidden', '');

    if (files.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'no-results-msg';
      msg.textContent = 'No videos match the current filter.';
      grid.appendChild(msg);
      return;
    }

    files.forEach(f => grid.appendChild(_buildCard(f)));
  }

  /* ── Build one file card ── */
  function _buildCard(file) {
    const allTags  = Storage.getTags();
    const fileTags = (file.tagIds || [])
      .map(tid => allTags.find(t => t.id === tid))
      .filter(Boolean);

    const card = document.createElement('div');
    card.className = 'file-card';

    /* Thumbnail */
    const thumb = document.createElement('div');
    thumb.className = 'file-card-thumb';
    thumb.innerHTML = '<i class="fa-solid fa-circle-play"></i>';
    thumb.title = 'Play video';
    thumb.addEventListener('click', () => App.openPlayer(file.id));
    card.appendChild(thumb);

    /* Body */
    const body = document.createElement('div');
    body.className = 'file-card-body';

    /* Name row */
    const nameRow = document.createElement('div');
    nameRow.className = 'file-card-name-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-card-name';
    nameEl.textContent = file.name;
    nameEl.title = file.name;
    nameEl.addEventListener('click', () => App.openPlayer(file.id));

    const btnEdit = document.createElement('button');
    btnEdit.className = 'list-icon-btn';
    btnEdit.title = 'Edit Name';
    btnEdit.innerHTML = '<i class="fa-solid fa-pen"></i>';
    btnEdit.addEventListener('click', e => {
      e.stopPropagation();
      _openNameModal(file.id, file.name);
    });

    nameRow.appendChild(nameEl);
    nameRow.appendChild(btnEdit);
    body.appendChild(nameRow);

    /* Tags */
    const tagsEl = document.createElement('div');
    tagsEl.className = 'file-card-tags';
    fileTags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'file-tag-chip';
      chip.style.background = tag.color;
      chip.textContent = tag.name;
      tagsEl.appendChild(chip);
    });
    body.appendChild(tagsEl);

    /* Footer */
    const footer = document.createElement('div');
    footer.className = 'file-card-footer';

    const left = document.createElement('div');
    left.className = 'file-card-footer-left';

    const btnTags = document.createElement('button');
    btnTags.className = 'list-icon-btn';
    btnTags.title = 'Assign Tags';
    btnTags.innerHTML = '<i class="fa-solid fa-tag"></i>';
    btnTags.addEventListener('click', e => {
      e.stopPropagation();
      Tags.openTagAssignModal(file.id);
    });
    left.appendChild(btnTags);
    footer.appendChild(left);

    const right = document.createElement('div');
    right.className = 'file-card-footer-right';

    const btnDel = document.createElement('button');
    btnDel.className = 'list-icon-btn';
    btnDel.title = 'Delete Video';
    btnDel.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    btnDel.style.color = 'var(--danger)';
    btnDel.addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm(`Delete "${file.name}"?\nThis cannot be undone.`)) {
        await App.deleteFile(file.id);
      }
    });
    right.appendChild(btnDel);
    footer.appendChild(right);

    body.appendChild(footer);
    card.appendChild(body);
    return card;
  }

  /* ══════════════════════════════════════════════
     TAG FILTER BAR
     ══════════════════════════════════════════════ */
  function renderTagFilterBar() {
    const tags = Storage.getTags();
    const bar  = document.getElementById('tag-filter-bar');
    bar.innerHTML = '';

    if (tags.length === 0) return;

    /* "All" chip */
    const allChip = document.createElement('button');
    allChip.className = 'tag-chip' + (_filterIds.size === 0 ? ' active' : '');
    allChip.style.setProperty('--chip-color', 'var(--accent)');
    allChip.textContent = 'All';
    allChip.addEventListener('click', () => {
      _filterIds.clear();
      renderTagFilterBar();
      renderFileList();
    });
    bar.appendChild(allChip);

    /* One chip per tag */
    tags.forEach(tag => {
      const chip = document.createElement('button');
      const isOn = _filterIds.has(tag.id);
      chip.className = 'tag-chip' + (isOn ? ' active' : '');
      chip.style.setProperty('--chip-color', tag.color);

      const dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = tag.color;

      const lbl = document.createElement('span');
      lbl.textContent = tag.name;

      chip.appendChild(dot);
      chip.appendChild(lbl);

      chip.addEventListener('click', () => {
        if (_filterIds.has(tag.id)) _filterIds.delete(tag.id);
        else                        _filterIds.add(tag.id);
        renderTagFilterBar();
        renderFileList();
      });
      bar.appendChild(chip);
    });
  }

  /* ══════════════════════════════════════════════
     NAME EDIT MODAL
     ══════════════════════════════════════════════ */
  function _openNameModal(fileId, currentName) {
    _nameFileId = fileId;
    const input = document.getElementById('name-edit-input');
    input.value = currentName;
    document.getElementById('modal-name').removeAttribute('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 60);
  }

  function _closeNameModal() {
    _nameFileId = null;
    document.getElementById('modal-name').setAttribute('hidden', '');
  }

  function _saveName() {
    const name = document.getElementById('name-edit-input').value.trim();
    if (name && _nameFileId) {
      Storage.updateFile(_nameFileId, { name });
      renderFileList();
    }
    _closeNameModal();
  }

  /* ══════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════ */
  function init() {
    /* Add file button */
    document.getElementById('btn-add-file').addEventListener('click', () => {
      document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';          /* reset so same file can be re-added */
      await App.addFile(file);
    });

    /* Sort */
    document.getElementById('sort-key').addEventListener('change', e => {
      _sortKey = e.target.value;
      renderFileList();
    });

    document.getElementById('btn-sort-dir').addEventListener('click', () => {
      _sortAsc = !_sortAsc;
      const icon = document.getElementById('sort-dir-icon');
      icon.className = _sortAsc
        ? 'fa-solid fa-arrow-up-wide-short'
        : 'fa-solid fa-arrow-down-wide-short';
      renderFileList();
    });

    /* Search */
    document.getElementById('search-input').addEventListener('input', e => {
      _search = e.target.value.trim();
      renderFileList();
    });

    /* Name modal */
    document.getElementById('btn-close-name').addEventListener('click', _closeNameModal);
    document.getElementById('btn-save-name').addEventListener('click', _saveName);
    document.getElementById('name-edit-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') _saveName();
      if (e.key === 'Escape') _closeNameModal();
    });
    document.getElementById('modal-name').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-name')) _closeNameModal();
    });
  }

  return { init, renderFileList, renderTagFilterBar };
})();
