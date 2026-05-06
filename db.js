'use strict';
/* ================================================
   DB  –  IndexedDB wrapper for video blob storage
   ================================================ */
const DB = (() => {
  const DB_NAME    = 'VideoPlayerDB';
  const DB_VERSION = 1;
  const STORE      = 'videos';
  let _db = null;

  /* Open (or reuse) the database */
  function open() {
    return new Promise((resolve, reject) => {
      if (_db) { resolve(_db); return; }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onerror = () => reject(new Error('IndexedDB open failed: ' + req.error));

      req.onsuccess = () => {
        _db = req.result;
        resolve(_db);
      };

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
    });
  }

  /* Save a video blob (File or Blob) */
  function saveVideo(id, blob) {
    return new Promise((resolve, reject) => {
      const tx    = _db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req   = store.put({ id, blob });
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  /* Retrieve a video blob; resolves with null if not found */
  function getVideo(id) {
    return new Promise((resolve, reject) => {
      const tx    = _db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req   = store.get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror   = () => reject(req.error);
    });
  }

  /* Delete a video blob */
  function deleteVideo(id) {
    return new Promise((resolve, reject) => {
      const tx    = _db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req   = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  return { open, saveVideo, getVideo, deleteVideo };
})();
