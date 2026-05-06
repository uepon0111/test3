'use strict';
/* ================================================
   Storage  –  localStorage wrapper for metadata
   ================================================
   Data shape
   ----------
   File record:
     { id, name, tagIds[], markers[], loop, addedAt }

   Tag record:
     { id, name, color }
   Tags array order = display order (user can reorder).
   ================================================ */
const Storage = (() => {
  const KEY_FILES = 'vp_files';
  const KEY_TAGS  = 'vp_tags';

  /* ── helpers ── */
  function _load(key) {
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch { return []; }
  }
  function _save(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  /* ══════════════════════════════════════════════
     FILES
     ══════════════════════════════════════════════ */
  function getFiles()         { return _load(KEY_FILES); }
  function saveFiles(files)   { _save(KEY_FILES, files); }

  function getFile(id) {
    return getFiles().find(f => f.id === id) || null;
  }

  function addFile(file) {
    const files = getFiles();
    files.push(file);
    saveFiles(files);
  }

  function updateFile(id, patch) {
    const files = getFiles();
    const i = files.findIndex(f => f.id === id);
    if (i !== -1) {
      files[i] = { ...files[i], ...patch };
      saveFiles(files);
    }
  }

  function deleteFile(id) {
    saveFiles(getFiles().filter(f => f.id !== id));
  }

  /* ══════════════════════════════════════════════
     TAGS
     ══════════════════════════════════════════════ */
  function getTags()       { return _load(KEY_TAGS); }
  function saveTags(tags)  { _save(KEY_TAGS, tags); }

  function getTag(id) {
    return getTags().find(t => t.id === id) || null;
  }

  function addTag(tag) {
    const tags = getTags();
    tags.push(tag);
    saveTags(tags);
  }

  function updateTag(id, patch) {
    const tags = getTags();
    const i = tags.findIndex(t => t.id === id);
    if (i !== -1) {
      tags[i] = { ...tags[i], ...patch };
      saveTags(tags);
    }
  }

  /* Deleting a tag also strips it from every file */
  function deleteTag(id) {
    const files = getFiles().map(f => ({
      ...f,
      tagIds: (f.tagIds || []).filter(tid => tid !== id)
    }));
    saveFiles(files);
    saveTags(getTags().filter(t => t.id !== id));
  }

  /* ══════════════════════════════════════════════
     MARKERS  (stored inside the file record)
     ══════════════════════════════════════════════ */
  function getMarkers(fileId) {
    const f = getFile(fileId);
    return f ? ([...(f.markers || [])].sort((a, b) => a - b)) : [];
  }

  function saveMarkers(fileId, markers) {
    updateFile(fileId, { markers: [...markers].sort((a, b) => a - b) });
  }

  /* ══════════════════════════════════════════════
     LOOP  (stored inside the file record)
     ══════════════════════════════════════════════ */
  function getLoop(fileId) {
    const f = getFile(fileId);
    return f ? (f.loop || null) : null;
  }

  function saveLoop(fileId, loop) {
    updateFile(fileId, { loop });
  }

  /* ── public API ── */
  return {
    getFiles, saveFiles, getFile, addFile, updateFile, deleteFile,
    getTags,  saveTags,  getTag,  addTag,  updateTag,  deleteTag,
    getMarkers, saveMarkers,
    getLoop,    saveLoop
  };
})();
