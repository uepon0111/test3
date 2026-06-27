/**
 * drive.js — Google Drive API 操作
 */
const Drive = (() => {
  let _folderId = null;

  async function _req(path, opts = {}) {
    const tk = await Auth.getToken();
    if (!tk) throw new Error('未ログイン');
    const base = CONFIG.GOOGLE_DRIVE_API;
    const res = await fetch(base + path, {
      ...opts,
      headers: { Authorization: `Bearer ${tk}`, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Drive API error ${res.status}`);
    }
    return res.json();
  }

  async function _upload(metadata, blob, update = false, fileId = null) {
    const tk = await Auth.getToken();
    if (!tk) throw new Error('未ログイン');
    const url = update && fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const method = update && fileId ? 'PATCH' : 'POST';

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${tk}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Upload error ${res.status}`);
    return res.json();
  }

  /** Ensure app folder exists */
  async function getOrCreateFolder() {
    if (_folderId) return _folderId;
    const stored = await DB.getSetting('drive_folder_id');
    if (stored) { _folderId = stored; return stored; }

    // Search for existing folder
    const name = CONFIG.DRIVE_FOLDER_NAME;
    const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const data = await _req(`/files?q=${q}&fields=files(id,name)`);

    if (data.files && data.files.length > 0) {
      _folderId = data.files[0].id;
    } else {
      const created = await _req('/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
      });
      _folderId = created.id;
    }
    await DB.setSetting('drive_folder_id', _folderId);
    return _folderId;
  }

  /** Upload image blob to Drive */
  async function uploadImage(blob, filename) {
    const folderId = await getOrCreateFolder();
    const meta = { name: filename, parents: [folderId] };
    const data = await _upload(meta, blob);
    return data.id;
  }

  /** Delete file from Drive */
  async function deleteFile(fileId) {
    if (!fileId) return;
    const tk = await Auth.getToken();
    if (!tk) return;
    await fetch(`${CONFIG.GOOGLE_DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tk}` },
    });
  }

  /** Get download URL */
  async function getDownloadUrl(fileId) {
    const data = await _req(`/files/${fileId}?alt=media`);
    return data;
  }

  /** Check if Drive is available */
  async function isAvailable() {
    try {
      const tk = await Auth.getToken();
      return !!tk;
    } catch { return false; }
  }

  return { uploadImage, deleteFile, getDownloadUrl, isAvailable, getOrCreateFolder };
})();
