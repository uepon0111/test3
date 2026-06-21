'use strict';

/* ============================================================
   STORAGE  —  IndexedDB 永続化
   ============================================================ */

const DB_NAME    = 'MusicBoxDB';
const DB_VERSION = 1;

const STORE = {
  TRACKS:     'tracks',
  FILES:      'audioFiles',
  PLAYLISTS:  'playlists',
  TAGS:       'tags',
  ARTISTS:    'artists',
  PLAY_LOGS:  'playLogs',
  SETTINGS:   'settings',
};

const Storage = (() => {
  let _db = null;

  /* ---- DB Open ---- */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE.TRACKS))
          db.createObjectStore(STORE.TRACKS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.FILES))
          db.createObjectStore(STORE.FILES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.PLAYLISTS))
          db.createObjectStore(STORE.PLAYLISTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.TAGS))
          db.createObjectStore(STORE.TAGS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.ARTISTS))
          db.createObjectStore(STORE.ARTISTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.PLAY_LOGS))
          db.createObjectStore(STORE.PLAY_LOGS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE.SETTINGS))
          db.createObjectStore(STORE.SETTINGS, { keyPath: 'key' });
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* ---- Generic helpers ---- */
  function tx(storeName, mode = 'readonly') {
    return _db.transaction([storeName], mode).objectStore(storeName);
  }
  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function getAll(storeName) {
    await open();
    return wrap(tx(storeName).getAll());
  }
  async function get(storeName, key) {
    await open();
    return wrap(tx(storeName).get(key));
  }
  async function put(storeName, value) {
    await open();
    return wrap(tx(storeName, 'readwrite').put(value));
  }
  async function del(storeName, key) {
    await open();
    return wrap(tx(storeName, 'readwrite').delete(key));
  }
  async function clear(storeName) {
    await open();
    return wrap(tx(storeName, 'readwrite').clear());
  }
  async function putBulk(storeName, items) {
    await open();
    const store = tx(storeName, 'readwrite');
    await Promise.all(items.map(item => wrap(store.put(item))));
  }

  /* ---- Tracks (metadata only, no file data) ---- */
  async function saveTracks(tracks) { await putBulk(STORE.TRACKS, tracks); }
  async function saveTrack(track)   { await put(STORE.TRACKS, track); }
  async function deleteTrack(id)    {
    await del(STORE.TRACKS, id);
    await del(STORE.FILES, id);
    // Also delete play logs for this track
    const logs = await getAll(STORE.PLAY_LOGS);
    const toDelete = logs.filter(l => l.trackId === id).map(l => l.id);
    await Promise.all(toDelete.map(lid => del(STORE.PLAY_LOGS, lid)));
  }

  /* ---- Audio files (ArrayBuffer) ---- */
  async function saveAudioFile(id, arrayBuffer) {
    await put(STORE.FILES, { id, data: arrayBuffer });
  }
  async function getAudioFile(id) {
    const rec = await get(STORE.FILES, id);
    return rec ? rec.data : null;
  }

  /* ---- Playlists ---- */
  async function savePlaylists(pls) { await putBulk(STORE.PLAYLISTS, pls); }
  async function savePlaylist(pl)   { await put(STORE.PLAYLISTS, pl); }
  async function deletePlaylist(id) { await del(STORE.PLAYLISTS, id); }

  /* ---- Tags ---- */
  async function saveTags(tags) { await putBulk(STORE.TAGS, tags); }
  async function saveTag(tag)   { await put(STORE.TAGS, tag); }
  async function deleteTag(id)  { await del(STORE.TAGS, id); }

  /* ---- Artists ---- */
  async function saveArtists(arts) { await putBulk(STORE.ARTISTS, arts); }
  async function saveArtist(art)   { await put(STORE.ARTISTS, art); }
  async function deleteArtist(id)  { await del(STORE.ARTISTS, id); }

  /* ---- Play logs ---- */
  async function addPlayLog(log)    { await put(STORE.PLAY_LOGS, log); }
  async function deleteLogByTrack(trackId) {
    const logs = await getAll(STORE.PLAY_LOGS);
    const toDelete = logs.filter(l => l.trackId === trackId);
    await Promise.all(toDelete.map(l => del(STORE.PLAY_LOGS, l.id)));
  }

  /* ---- Settings ---- */
  async function getSetting(key, defaultVal = null) {
    const rec = await get(STORE.SETTINGS, key);
    return rec ? rec.value : defaultVal;
  }
  async function setSetting(key, value) {
    await put(STORE.SETTINGS, { key, value });
  }

  /* ---- Load all (initial boot) ---- */
  async function loadAll() {
    await open();
    const [tracks, playlists, tags, artists, logs] = await Promise.all([
      getAll(STORE.TRACKS),
      getAll(STORE.PLAYLISTS),
      getAll(STORE.TAGS),
      getAll(STORE.ARTISTS),
      getAll(STORE.PLAY_LOGS),
    ]);
    return { tracks, playlists, tags, artists, logs };
  }

  /* ---- Clear everything ---- */
  async function clearAll() {
    await open();
    await Promise.all(Object.values(STORE).map(s => clear(s)));
  }

  /* ---- Storage estimate ---- */
  async function getStorageEstimate() {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      return navigator.storage.estimate();
    }
    return { usage: 0, quota: 0 };
  }

  /* ---- Persist ALL state arrays at once (used for bulk reorder) ---- */
  async function persistState() {
    const { tracks, playlists, tags, artists } = AppState;
    await saveTracks(tracks);
    await savePlaylists(playlists);
    await saveTags(tags);
    await saveArtists(artists);
  }

  return {
    open, loadAll, clearAll, getStorageEstimate,
    saveTrack, saveTracks, deleteTrack,
    saveAudioFile, getAudioFile,
    savePlaylist, savePlaylists, deletePlaylist,
    saveTag, saveTags, deleteTag,
    saveArtist, saveArtists, deleteArtist,
    addPlayLog, deleteLogByTrack,
    getSetting, setSetting,
    getAll: (s) => getAll(s),
    persistState,
    STORE,
  };
})();
