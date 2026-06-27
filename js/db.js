/**
 * db.js — IndexedDB CRUD 操作
 * Stores: results, trash, settings, deviceProfiles
 */
const DB = (() => {
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('results')) {
          const rs = db.createObjectStore('results', { keyPath: 'id' });
          rs.createIndex('musicId',    'musicId',    { unique: false });
          rs.createIndex('title',      'title',      { unique: false });
          rs.createIndex('difficulty', 'difficulty', { unique: false });
          rs.createIndex('level',      'level',      { unique: false });
          rs.createIndex('addedAt',    'addedAt',    { unique: false });
        }

        if (!db.objectStoreNames.contains('trash')) {
          const ts = db.createObjectStore('trash', { keyPath: 'id' });
          ts.createIndex('deletedAt', 'deletedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('deviceProfiles')) {
          db.createObjectStore('deviceProfiles', { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  function tx(storeName, mode = 'readonly') {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = (e) => res(e.target.result);
      req.onerror   = (e) => rej(e.target.error);
    });
  }

  /** Results */
  async function addResult(entry) {
    await open();
    return wrap(tx('results','readwrite').add(entry));
  }

  async function updateResult(entry) {
    await open();
    return wrap(tx('results','readwrite').put(entry));
  }

  async function getResult(id) {
    await open();
    return wrap(tx('results').get(id));
  }

  async function getAllResults() {
    await open();
    return wrap(tx('results').getAll());
  }

  async function deleteResult(id) {
    await open();
    return wrap(tx('results','readwrite').delete(id));
  }

  /** Trash */
  async function addTrash(entry) {
    await open();
    return wrap(tx('trash','readwrite').add(entry));
  }

  async function getAllTrash() {
    await open();
    return wrap(tx('trash').getAll());
  }

  async function deleteTrash(id) {
    await open();
    return wrap(tx('trash','readwrite').delete(id));
  }

  async function getTrashItem(id) {
    await open();
    return wrap(tx('trash').get(id));
  }

  /** Settings */
  async function getSetting(key) {
    await open();
    const rec = await wrap(tx('settings').get(key));
    return rec ? rec.value : null;
  }

  async function setSetting(key, value) {
    await open();
    return wrap(tx('settings','readwrite').put({ key, value }));
  }

  /** Device Profiles */
  async function getAllDeviceProfiles() {
    await open();
    return wrap(tx('deviceProfiles').getAll());
  }

  async function addDeviceProfile(profile) {
    await open();
    return wrap(tx('deviceProfiles','readwrite').add(profile));
  }

  async function updateDeviceProfile(profile) {
    await open();
    return wrap(tx('deviceProfiles','readwrite').put(profile));
  }

  async function deleteDeviceProfile(id) {
    await open();
    return wrap(tx('deviceProfiles','readwrite').delete(id));
  }

  /** Move result to trash */
  async function moveToTrash(id) {
    const entry = await getResult(id);
    if (!entry) return;
    entry.deletedAt = new Date().toISOString();
    await deleteResult(id);
    await addTrash(entry);
  }

  /** Restore from trash */
  async function restoreFromTrash(id) {
    const entry = await getTrashItem(id);
    if (!entry) return;
    delete entry.deletedAt;
    await deleteTrash(id);
    await addResult(entry);
  }

  return {
    open, addResult, updateResult, getResult, getAllResults, deleteResult,
    addTrash, getAllTrash, deleteTrash, getTrashItem,
    getSetting, setSetting,
    getAllDeviceProfiles, addDeviceProfile, updateDeviceProfile, deleteDeviceProfile,
    moveToTrash, restoreFromTrash,
  };
})();
