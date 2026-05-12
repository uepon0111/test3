/**
 * drive.js — Google Drive integration for Sonora
 *
 * Folder layout:
 *   Sonora/
 *     sonora_index.json        ← snapshot + deletedIds[]
 *     audio/<trackId>.mp3      ← audio files
 *     thumbs/<trackId>.jpg     ← thumbnails
 *
 * FIX LOG:
 *   1. _onToken: No longer calls syncNow() unconditionally; respects _autoSync flag
 *   2. _uploadAudio/_uploadThumb: Per-track upload lock + existing-file check to
 *      prevent duplicate uploads from concurrent onTrackAdded / syncNow calls
 *   3. syncNow: Passes deletedIds to importSnapshot so deleted tracks are not
 *      re-created from an outdated remote index
 *   4. _deleteOrphanedThumbs: Cleans up thumb files for deleted tracks
 *   5. syncInProgress checkpoint: Detects interrupted syncs on next boot
 */

const Drive = (() => {

  /* ─── CONFIG ─── */
  const CLIENT_ID   = '216604412012-80eanap7n3ldoa1npd73v22t9gl552nq.apps.googleusercontent.com';
  const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';

  /* ─── STATE ─── */
  let _token       = null;
  let _userEmail   = null;
  let _tokenClient = null;
  let _autoSync    = false;
  let _syncBusy    = false;
  let _autoTimer   = null;
  let _debounce    = null;
  let _logTimer    = null;

  let _fid  = null;
  let _afid = null;
  let _tfid = null;

  // Per-track upload locks: prevents duplicate uploads when
  // onTrackAdded and syncNow run concurrently for the same track
  const _uploadingIds = new Set();

  /* ─── PROGRESS ─── */
  function _prog(pct, detail) {
    const wrap  = document.getElementById('sync-progress-wrap');
    const fill  = document.getElementById('sync-bar-fill');
    const det   = document.getElementById('sync-detail-txt');
    const pctEl = document.getElementById('sync-pct-txt');
    if (wrap)  wrap.classList.add('visible');
    if (fill)  fill.style.width = Math.min(100, pct) + '%';
    if (det)   det.textContent  = detail;
    if (pctEl) pctEl.textContent= Math.round(pct) + '%';
  }
  function _progDone() {
    setTimeout(() => {
      const w = document.getElementById('sync-progress-wrap');
      const f = document.getElementById('sync-bar-fill');
      if (w) w.classList.remove('visible');
      if (f) f.style.width = '0%';
    }, 2000);
  }

  /* ─── PARALLEL RUNNER ─── */
  async function _parallel(items, fn, limit = 3) {
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try { await fn(item); } catch (e) { console.warn('parallel task err:', e); }
        }
      })
    );
  }

  /* ─── AUTH ─── */
  function init() {
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2) {
        clearInterval(check);
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope:     SCOPES,
          callback:  _onToken,
        });
      }
    }, 300);

    Storage.getMeta('driveToken').then(tok => {
      if (tok?.expiry > Date.now()) {
        _token     = tok.token;
        _userEmail = tok.email || null;
        _updateLoginUI(true);
      }
    });

    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const t = document.getElementById('auto-sync-toggle');
      if (t && v) t.classList.add('on');
    });

    // Detect interrupted sync from previous session
    Storage.getMeta('syncInProgress', false).then(wasInterrupted => {
      if (wasInterrupted) {
        console.warn('[Drive] Previous sync was interrupted. Will retry on next sync.');
        Storage.setMeta('syncInProgress', false);
      }
    });
  }

  async function _onToken(resp) {
    if (resp.error) { UI?.toast('Googleログインに失敗しました','error'); return; }
    _token = resp.access_token;
    const expiry = Date.now() + (resp.expires_in - 60) * 1000;
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers:{ Authorization:'Bearer '+_token } });
      const d = await r.json();
      _userEmail = d.email || null;
    } catch {}
    await Storage.setMeta('driveToken', { token:_token, expiry, email:_userEmail });
    _updateLoginUI(true);
    UI?.toast('Googleアカウントでログインしました');
    // FIX: Previously always called syncNow() regardless of _autoSync.
    // Now only syncs if the user has auto-sync enabled.
    if (_autoSync) syncNow();
  }

  function toggleLogin() { _token ? _logout() : _login(); }
  function _login() {
    if (!_tokenClient) { UI?.toast('Google認証の読み込み中です','error'); return; }
    _tokenClient.requestAccessToken({ prompt:'consent' });
  }
  function _logout() {
    if (_token && typeof google !== 'undefined')
      google.accounts.oauth2.revoke(_token, () => {});
    _token = null; _userEmail = null;
    _fid = null; _afid = null; _tfid = null;
    Storage.deleteMeta('driveToken');
    Storage.deleteMeta('driveFolderId');
    Storage.deleteMeta('driveAudioFolderId');
    Storage.deleteMeta('driveThumbFolderId');
    Storage.deleteMeta('driveIndexFileId');
    _updateLoginUI(false);
    UI?.toast('ログアウトしました');
  }
  const isLoggedIn = () => !!_token;

  function _updateLoginUI(on) {
    const txt  = document.getElementById('settings-login-txt');
    const row  = document.getElementById('account-info-row');
    const mail = document.getElementById('account-email');
    const sbtn = document.getElementById('sync-now-btn');
    if (txt)  txt.textContent   = on ? 'ログアウト' : 'ログイン';
    if (row)  row.style.display = on ? 'flex' : 'none';
    if (mail && _userEmail) mail.textContent = _userEmail;
    if (sbtn) sbtn.disabled = !on;
  }

  /* ─── AUTO SYNC ─── */
  function toggleAutoSync(btn) {
    _autoSync = !_autoSync;
    btn.classList.toggle('on', _autoSync);
    Storage.setMeta('autoSync', _autoSync);
    if (_autoSync && _token) _scheduleAuto();
    else clearTimeout(_autoTimer);
    UI?.toast(_autoSync ? '自動同期オン' : '自動同期オフ');
  }
  function _scheduleAuto() {
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(() => {
      if (_autoSync && _token) syncNow().then(_scheduleAuto);
    }, 5 * 60 * 1000);
  }
  function triggerAutoSync() {
    if (!_autoSync || !_token) return;
    clearTimeout(_debounce);
    _debounce = setTimeout(() => syncNow(), 4000);
  }
  function scheduleSyncLogs() {
    clearTimeout(_logTimer);
    _logTimer = setTimeout(() => { if (_token) _pushIndex().catch(() => {}); }, 15000);
  }

  /* ─── DRIVE API ─── */
  async function _api(method, url, body, ct) {
    if (!_token) throw new Error('Not authenticated');
    const headers = { Authorization: 'Bearer ' + _token };
    if (ct) headers['Content-Type'] = ct;
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401) {
      _token = null;
      Storage.deleteMeta('driveToken');
      _updateLoginUI(false);
      throw new Error('Token expired');
    }
    if (!res.ok) throw new Error(`Drive ${res.status}: ` + await res.text());
    const ctype = res.headers.get('content-type') || '';
    return ctype.includes('application/json') ? res.json() : res.arrayBuffer();
  }

  async function _list(params) {
    const qs = new URLSearchParams(params).toString();
    return _api('GET', `https://www.googleapis.com/drive/v3/files?${qs}`);
  }
  async function _createFolder(name, parentId) {
    return _api('POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      JSON.stringify({ name, mimeType:'application/vnd.google-apps.folder', parents:parentId?[parentId]:[] }),
      'application/json');
  }
  async function _upload(name, mime, data, parentId, existingId) {
    const metaObj = { name, parents: existingId ? undefined : (parentId ? [parentId] : []) };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metaObj)], { type:'application/json' }));
    form.append('file', data instanceof Blob ? data : new Blob([data], { type:mime }), name);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    return _api(existingId ? 'PATCH' : 'POST', url, form);
  }
  const _download = id =>
    _api('GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  async function _deleteFile(id) {
    if (!_token || !id) return;
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${id}`,
        { method:'DELETE', headers:{ Authorization:'Bearer '+_token } });
    } catch {}
  }

  /* ─── FOLDER SETUP ─── */
  async function _folders() {
    if (!_fid) _fid = await Storage.getMeta('driveFolderId');
    if (!_fid) {
      const r = await _list({ q:`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields:'files(id)' });
      _fid = r.files?.[0]?.id || (await _createFolder(FOLDER_NAME)).id;
      await Storage.setMeta('driveFolderId', _fid);
    }
    const [af, tf] = await Promise.all([
      _ensureSubFolder('audio', 'driveAudioFolderId', _afid),
      _ensureSubFolder('thumbs','driveThumbFolderId', _tfid),
    ]);
    _afid = af; _tfid = tf;
  }
  async function _ensureSubFolder(name, metaKey, cached) {
    if (cached) return cached;
    let id = await Storage.getMeta(metaKey);
    if (!id) {
      const r = await _list({
        q:`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${_fid}' in parents and trashed=false`,
        fields:'files(id)'
      });
      id = r.files?.[0]?.id || (await _createFolder(name, _fid)).id;
      await Storage.setMeta(metaKey, id);
    }
    return id;
  }

  /* ─── FIND EXISTING DRIVE FILE BY NAME ─── */
  // Used to prevent duplicate uploads when the same file already exists on Drive
  async function _findExistingFile(name, folderId) {
    try {
      const r = await _list({
        q:        `name='${name}' and '${folderId}' in parents and trashed=false`,
        fields:   'files(id)',
        pageSize: 1,
      });
      return r.files?.[0]?.id || null;
    } catch { return null; }
  }

  /* ─── INDEX ─── */
  async function _indexFileId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (!id) {
      const r = await _list({ q:`name='${INDEX_FILE}' and '${_fid}' in parents and trashed=false`, fields:'files(id)' });
      if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveIndexFileId', id); }
    }
    return id || null;
  }
  async function _pushIndex() {
    await _folders();
    const snap       = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snap.deletedIds  = deletedIds;
    const blob       = new Blob([JSON.stringify(snap)], { type:'application/json' });
    const existing   = await _indexFileId();
    const r = await _upload(INDEX_FILE, 'application/json', blob, _fid, existing);
    if (r?.id) await Storage.setMeta('driveIndexFileId', r.id);
  }
  async function _pullIndex() {
    const id = await _indexFileId();
    if (!id) return null;
    try {
      const buf = await _download(id);
      return JSON.parse(new TextDecoder().decode(buf));
    } catch { return null; }
  }

  /* ─── AUDIO / THUMB TRANSFER ─── */

  /**
   * FIX: Upload lock prevents concurrent duplicate uploads.
   * Re-reads the latest track state before uploading; queries Drive for
   * an existing file with the same name to avoid creating duplicates even
   * when a previous upload completed but driveFileId was never saved back.
   */
  async function _uploadAudio(track) {
    if (!track.blobKey) return;
    const lockKey = track.id + ':audio';
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      if (!fresh?.blobKey) return;
      const buf = await Storage.getBlob(fresh.blobKey);
      if (!buf) return;
      // Prefer stored driveFileId; fall back to querying Drive by filename
      const existingId = fresh.driveFileId
        || await _findExistingFile(fresh.id + '.mp3', _afid);
      const r = await _upload(fresh.id + '.mp3', 'audio/mpeg', buf, _afid, existingId || null);
      if (r?.id) await Storage.updateTrack(fresh.id, { driveFileId: r.id });
    } finally {
      _uploadingIds.delete(lockKey);
    }
  }

  async function _uploadThumb(track) {
    if (!track.thumbKey) return;
    const lockKey = track.id + ':thumb';
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      if (!fresh?.thumbKey) return;
      const buf = await Storage.getBlob(fresh.thumbKey);
      if (!buf) return;
      const existingId = fresh.driveThumbId
        || await _findExistingFile(fresh.id + '.jpg', _tfid);
      const r = await _upload(fresh.id + '.jpg', 'image/jpeg', buf, _tfid, existingId || null);
      if (r?.id) await Storage.updateTrack(fresh.id, { driveThumbId: r.id });
    } finally {
      _uploadingIds.delete(lockKey);
    }
  }

  async function _downloadAudio(track) {
    if (!track.driveFileId) return false;
    try {
      const buf = await _download(track.driveFileId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { blobKey: key });
      return true;
    } catch { return false; }
  }
  async function _downloadThumb(track) {
    if (!track.driveThumbId) return false;
    try {
      const buf = await _download(track.driveThumbId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { thumbKey: key });
      return true;
    } catch { return false; }
  }

  /* ─── EXTRACT METADATA FROM DRIVE FILE ─── */
  async function _extractMeta(driveFileId, fileName) {
    const fallback = () => {
      const base = (fileName||'').replace(/\.[^.]+$/,'');
      const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
      return { title:dash?dash[2].trim():base, artist:dash?dash[1].trim():'', duration:0, releaseDate:null, thumbData:null, thumbMime:null, rawBuffer:null };
    };
    try {
      const raw = await _download(driveFileId);
      if (!raw) return fallback();
      const meta = Storage.parseAudioMetaFromBuffer(raw, fileName);
      const blob = new Blob([raw]);
      const url  = URL.createObjectURL(blob);
      const dur  = await new Promise(resolve => {
        const a = document.createElement('audio');
        a.src = url; a.preload = 'metadata';
        a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration||0); };
        a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
        setTimeout(()    => { URL.revokeObjectURL(url); resolve(0); }, 8000);
      });
      return { ...meta, duration:dur, rawBuffer:raw };
    } catch { return fallback(); }
  }

  /* ─────────────────────────────────────────
     DIFF: Drive audio/ folder vs local tracks
  ───────────────────────────────────────── */
  async function _diffAudio(localTracks, deletedIds) {
    const r = await _list({
      q:      `'${_afid}' in parents and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: 1000,
    }).catch(() => ({ files:[] }));

    const driveFiles     = r.files || [];
    const driveIdSet     = new Set(driveFiles.map(f => f.id));
    const localByDriveId = new Map(
      localTracks.filter(t => t.driveFileId).map(t => [t.driveFileId, t])
    );

    const toAdd    = [];
    const toDelete = [];

    for (const df of driveFiles) {
      const base = df.name.replace(/\.[^.]+$/,'');
      if (deletedIds.has(base) || deletedIds.has(df.id)) {
        toDelete.push(df.id);
        continue;
      }
      if (localByDriveId.has(df.id)) continue;
      const matchByBase = localTracks.find(t => t.id === base);
      if (matchByBase) {
        if (!matchByBase.driveFileId)
          await Storage.updateTrack(matchByBase.id, { driveFileId: df.id });
        continue;
      }
      toAdd.push(df);
    }

    const driveDeleted = localTracks.filter(
      t => t.driveFileId && !driveIdSet.has(t.driveFileId)
    );

    return { toAdd, toDelete, driveDeleted };
  }

  /* ─── DELETE ORPHANED THUMBS ─── */
  // Cleans up thumb files in Drive whose corresponding track was deleted locally.
  // _diffAudio only handles the audio/ folder; this handles thumbs/ separately.
  async function _deleteOrphanedThumbs(deletedIds) {
    if (deletedIds.size === 0) return;
    const r = await _list({
      q:      `'${_tfid}' in parents and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 1000,
    }).catch(() => ({ files:[] }));

    await _parallel((r.files || []), async df => {
      const base = df.name.replace(/\.[^.]+$/,'');
      if (deletedIds.has(base)) await _deleteFile(df.id);
    }, 3);
  }

  /* ─────────────────────────────────────────
     MAIN SYNC
  ───────────────────────────────────────── */
  async function syncNow() {
    if (!_token)   { UI?.toast('ログインしてから同期してください','error'); return; }
    if (_syncBusy) return;
    _syncBusy = true;

    // Checkpoint: detect if browser closes mid-sync next time
    await Storage.setMeta('syncInProgress', true);

    try {
      _prog(5, 'フォルダを確認中...');
      await _folders();

      /* Phase A — pull remote data */
      _prog(10, 'リモートデータを取得中...');
      const [remoteIndex, localTracks] = await Promise.all([
        _pullIndex(),
        Storage.getTracks(),
      ]);

      const deletedIds   = new Set(await Storage.getMeta('deletedTrackIds', []));
      const remoteDelIds = new Set(remoteIndex?.deletedIds || []);

      /* Phase B — reconcile local state */
      _prog(20, '差分を計算中...');

      // Apply remote deletions to local
      for (const id of remoteDelIds) {
        const t = localTracks.find(t2 => t2.id === id);
        if (t && !deletedIds.has(id)) {
          await Storage.deleteTrack(id);
          deletedIds.add(id);
        }
      }

      // Merge remote tracks — FIX: pass deletedIds so we skip tracks that were
      // deleted locally but still appear in an outdated remote index.
      // Without this, importSnapshot would re-create locally-deleted tracks,
      // causing them to reappear in the UI and potentially be re-downloaded.
      if (remoteIndex) await Storage.importSnapshot(remoteIndex, deletedIds);

      /* Phase C — diff Drive audio/ folder */
      _prog(30, 'Driveファイルを確認中...');
      const freshTracks = await Storage.getTracks();
      const { toAdd, toDelete, driveDeleted } = await _diffAudio(freshTracks, deletedIds);

      // Delete Drive audio files for deleted tracks
      _prog(35, 'Driveからファイルを削除中...');
      await _parallel(toDelete, id => _deleteFile(id), 3);

      // Clean up orphaned thumb files for deleted tracks
      await _deleteOrphanedThumbs(deletedIds);

      // Handle Drive-direct deletes
      for (const t of driveDeleted) {
        deletedIds.add(t.id);
        await Storage.deleteTrack(t.id);
      }

      /* Phase D — I/O transfers */
      const afterMerge = await Storage.getTracks();
      // Skip tracks currently being uploaded by onTrackAdded (they have locks)
      const needUpAudio = afterMerge.filter(t =>  t.blobKey  && !t.driveFileId && !_uploadingIds.has(t.id + ':audio'));
      const needDlAudio = afterMerge.filter(t => !t.blobKey  &&  t.driveFileId);
      const needUpThumb = afterMerge.filter(t =>  t.thumbKey && !t.driveThumbId && !_uploadingIds.has(t.id + ':thumb'));
      const needDlThumb = afterMerge.filter(t => !t.thumbKey &&  t.driveThumbId);

      const totalIO = needUpAudio.length + needDlAudio.length + needUpThumb.length
                    + needDlThumb.length + toAdd.length;
      let doneIO = 0;
      const tick = () => {
        doneIO++;
        _prog(45 + (doneIO / Math.max(totalIO, 1)) * 40, '同期中...');
      };

      _prog(45, 'ファイルを転送中...');
      await Promise.all([
        _parallel(needUpAudio, async t => { await _uploadAudio(t);  tick(); }, 3),
        _parallel(needDlAudio, async t => { await _downloadAudio(t);tick(); }, 3),
        _parallel(needUpThumb, async t => { await _uploadThumb(t);  tick(); }, 3),
        _parallel(needDlThumb, async t => { await _downloadThumb(t);tick(); }, 2),
      ]);

      /* Phase E — import Drive-direct additions */
      _prog(85, '新規ファイルを取り込み中...');
      for (const df of toAdd) {
        await _importDriveFile(df);
        tick();
      }

      /* Phase F — push updated index */
      _prog(93, 'インデックスを保存中...');
      await _pushIndex();

      // Persist deletedIds (includes any additions made during this sync)
      await Storage.setMeta('deletedTrackIds', [...deletedIds]);

      _prog(100, '同期完了');
      _progDone();
      UI?.toast('同期が完了しました', 'success');
      if (typeof App !== 'undefined') App.refreshAll();

    } catch (err) {
      console.error('[Drive] Sync error:', err);
      _progDone();
      UI?.toast('同期エラー: ' + (err.message || '不明'), 'error');
    } finally {
      _syncBusy = false;
      Storage.setMeta('syncInProgress', false);
    }
  }

  /* ─── IMPORT A DRIVE-DIRECT FILE ─── */
  async function _importDriveFile(driveFile) {
    const meta = await _extractMeta(driveFile.id, driveFile.name);
    let blobKey  = null;
    let thumbKey = null;
    if (meta.rawBuffer) blobKey  = await Storage.saveBlob(meta.rawBuffer);
    if (meta.thumbData) thumbKey = await Storage.saveBlob(meta.thumbData);
    const base    = driveFile.name.replace(/\.[^.]+$/,'');
    const isOurId = /^[a-z0-9]{9,}$/.test(base);
    await Storage.addTrack({
      id:          isOurId ? base : undefined,
      title:       meta.title   || driveFile.name,
      artist:      meta.artist  || '',
      releaseDate: meta.releaseDate || null,
      duration:    meta.duration || 0,
      blobKey,
      thumbKey,
      driveFileId: driveFile.id,
      dateAdded:   new Date(driveFile.modifiedTime || Date.now()).getTime(),
    });
  }

  /* ─── ON TRACK ADDED ─── */
  async function onTrackAdded(track) {
    if (!_token) return;
    try {
      await _folders();
      await Promise.all([
        _uploadAudio(track),
        track.thumbKey ? _uploadThumb(track) : Promise.resolve(),
      ]);
      await _pushIndex();
    } catch (e) {
      console.warn('[Drive] onTrackAdded failed:', e);
    }
  }

  /* ─── ON TRACK DELETED ─── */
  async function onTrackDeleted(trackId, driveFileId, driveThumbId) {
    // Record deletion first (even if network fails, next sync will clean up Drive)
    const existing = await Storage.getMeta('deletedTrackIds', []);
    if (!existing.includes(trackId)) existing.push(trackId);
    await Storage.setMeta('deletedTrackIds', existing);

    if (_token) {
      await Promise.all([
        driveFileId  ? _deleteFile(driveFileId).catch(()=>{})  : Promise.resolve(),
        driveThumbId ? _deleteFile(driveThumbId).catch(()=>{}) : Promise.resolve(),
      ]);
      await _pushIndex().catch(() => {});
    }
  }

  /* ─── FULL DRIVE RESET ─── */
  async function resetDriveData() {
    if (!_token) return;
    _prog(5, 'Driveデータを削除中...');
    if (_fid) await _deleteFile(_fid).catch(() => {});
    _fid = null; _afid = null; _tfid = null;
    await Promise.all([
      Storage.deleteMeta('driveFolderId'),
      Storage.deleteMeta('driveAudioFolderId'),
      Storage.deleteMeta('driveThumbFolderId'),
      Storage.deleteMeta('driveIndexFileId'),
    ]);
    _prog(100, '削除完了');
    _progDone();
  }

  /* ─── PUBLIC ─── */
  return {
    init,
    isLoggedIn,
    toggleLogin,
    toggleAutoSync,
    triggerAutoSync,
    scheduleSyncLogs,
    syncNow,
    onTrackAdded,
    onTrackDeleted,
    resetDriveData,
  };
})();
