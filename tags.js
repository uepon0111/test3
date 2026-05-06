'use strict';
/* ================================================
   Tags  –  tag management & both tag modals
   ================================================ */
const Tags = (() => {
  let _assignFileId = null;   /* file whose tags are being edited */

  /* ══════════════════════════════════════════════
     TAG EDIT MODAL  (#modal-tags)
     ══════════════════════════════════════════════ */
  function openTagModal() {
    _renderTagEditList();
    document.getElementById('new-tag-name').value = '';
    document.getElementById('modal-tags').removeAttribute('hidden');
    setTimeout(() => document.getElementById('new-tag-name').focus(), 60);
  }

  function closeTagModal() {
    document.getElementById('modal-tags').setAttribute('hidden', '');
  }

  function _renderTagEditList() {
    const tags = Storage.getTags();
    const container = document.getElementById('tag-edit-list');
    container.innerHTML = '';
    tags.forEach((tag, idx) => {
      container.appendChild(_buildTagEditRow(tag, idx, tags.length));
    });
  }

  function _buildTagEditRow(tag, idx, total) {
    const row = document.createElement('div');
    row.className = 'tag-edit-row';

    /* ── Color swatch (label wraps hidden color input) ── */
    const label = document.createElement('label');
    label.className = 'tag-color-label';
    label.title = 'Change color';

    const dot = document.createElement('span');
    dot.className = 'tag-color-dot';
    dot.style.background = tag.color;

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = tag.color;
    colorInput.className = 'tag-color-hidden';

    colorInput.addEventListener('input', () => {
      dot.style.background = colorInput.value;
    });
    colorInput.addEventListener('change', () => {
      Storage.updateTag(tag.id, { color: colorInput.value });
      App.refreshAll();
    });

    label.appendChild(dot);
    label.appendChild(colorInput);
    row.appendChild(label);

    /* ── Name input ── */
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = tag.name;
    nameInput.className = 'tag-name-input';
    nameInput.placeholder = 'Tag name';
    nameInput.addEventListener('blur', () => {
      const v = nameInput.value.trim();
      if (v && v !== tag.name) {
        Storage.updateTag(tag.id, { name: v });
        App.refreshAll();
      }
    });
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') nameInput.blur();
    });
    row.appendChild(nameInput);

    /* ── Move up / down / delete ── */
    const actions = document.createElement('div');
    actions.className = 'tag-edit-actions';

    const mkBtn = (iconClass, title, disabled, onClick) => {
      const b = document.createElement('button');
      b.className = 'list-icon-btn';
      b.title = title;
      b.disabled = disabled;
      b.innerHTML = `<i class="${iconClass}"></i>`;
      b.addEventListener('click', onClick);
      return b;
    };

    actions.appendChild(mkBtn('fa-solid fa-chevron-up', 'Move Up', idx === 0, () => {
      const tags = Storage.getTags();
      const i = tags.findIndex(t => t.id === tag.id);
      if (i > 0) {
        [tags[i - 1], tags[i]] = [tags[i], tags[i - 1]];
        Storage.saveTags(tags);
        _renderTagEditList();
        App.refreshAll();
      }
    }));

    actions.appendChild(mkBtn('fa-solid fa-chevron-down', 'Move Down', idx === total - 1, () => {
      const tags = Storage.getTags();
      const i = tags.findIndex(t => t.id === tag.id);
      if (i < tags.length - 1) {
        [tags[i], tags[i + 1]] = [tags[i + 1], tags[i]];
        Storage.saveTags(tags);
        _renderTagEditList();
        App.refreshAll();
      }
    }));

    const delBtn = mkBtn('fa-solid fa-trash-can', 'Delete Tag', false, () => {
      if (confirm(`Delete tag "${tag.name}"?\nIt will be removed from all videos.`)) {
        Storage.deleteTag(tag.id);
        _renderTagEditList();
        App.refreshAll();
      }
    });
    delBtn.style.color = 'var(--danger)';
    actions.appendChild(delBtn);

    row.appendChild(actions);
    return row;
  }

  function _handleAddTag() {
    const nameInput  = document.getElementById('new-tag-name');
    const colorInput = document.getElementById('new-tag-color');
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }

    Storage.addTag({
      id:    crypto.randomUUID(),
      name,
      color: colorInput.value
    });
    nameInput.value = '';
    nameInput.focus();
    _renderTagEditList();
    App.refreshAll();
  }

  /* ══════════════════════════════════════════════
     TAG ASSIGN MODAL  (#modal-tag-assign)
     ══════════════════════════════════════════════ */
  function openTagAssignModal(fileId) {
    _assignFileId = fileId;
    _renderTagAssignList();
    document.getElementById('modal-tag-assign').removeAttribute('hidden');
  }

  function closeTagAssignModal() {
    _assignFileId = null;
    document.getElementById('modal-tag-assign').setAttribute('hidden', '');
  }

  function _renderTagAssignList() {
    const tags     = Storage.getTags();
    const file     = Storage.getFile(_assignFileId);
    const assigned = new Set(file ? (file.tagIds || []) : []);
    const container = document.getElementById('tag-assign-list');
    container.innerHTML = '';

    if (tags.length === 0) {
      const p = document.createElement('p');
      p.className = 'tag-assign-empty';
      p.innerHTML = 'No tags yet.<br>Use the <i class="fa-solid fa-tags"></i> button to create tags first.';
      container.appendChild(p);
      return;
    }

    tags.forEach(tag => {
      const row = document.createElement('div');
      row.className = 'tag-assign-row' + (assigned.has(tag.id) ? ' assigned' : '');

      const dot = document.createElement('span');
      dot.className = 'tag-assign-dot';
      dot.style.background = tag.color;

      const name = document.createElement('span');
      name.className = 'tag-assign-name';
      name.textContent = tag.name;

      const check = document.createElement('i');
      check.className = 'fa-solid fa-check tag-assign-check';
      if (!assigned.has(tag.id)) check.style.visibility = 'hidden';

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(check);

      row.addEventListener('click', () => {
        const f = Storage.getFile(_assignFileId);
        if (!f) return;
        const ids = new Set(f.tagIds || []);
        if (ids.has(tag.id)) {
          ids.delete(tag.id);
          check.style.visibility = 'hidden';
          row.classList.remove('assigned');
        } else {
          ids.add(tag.id);
          check.style.visibility = 'visible';
          row.classList.add('assigned');
        }
        Storage.updateFile(_assignFileId, { tagIds: [...ids] });
        List.renderFileList();
      });

      container.appendChild(row);
    });
  }

  /* ══════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════ */
  function init() {
    /* Tag edit modal */
    document.getElementById('btn-open-tags').addEventListener('click', openTagModal);
    document.getElementById('btn-close-tags').addEventListener('click', closeTagModal);
    document.getElementById('btn-add-tag').addEventListener('click', _handleAddTag);
    document.getElementById('new-tag-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') _handleAddTag();
    });
    document.getElementById('modal-tags').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-tags')) closeTagModal();
    });

    /* Tag assign modal */
    document.getElementById('btn-close-tag-assign').addEventListener('click', closeTagAssignModal);
    document.getElementById('modal-tag-assign').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-tag-assign')) closeTagAssignModal();
    });
  }

  return { init, openTagModal, openTagAssignModal };
})();
