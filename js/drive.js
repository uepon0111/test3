/**
 * drive.js — Google Drive integration for Sonora
 * 
 * BUG FIXES:
 *  1. ログイン時に自動同期が有効な場合のみ syncNow() を呼ぶ
 *  2. _uploadingIds Set によるアップロード重複防止ロック
 *  3. _deleteFile を _api 経由にして 401 ハンドリングを統一
 *  4. _diffAudio で同一ベース名の重複 Drive ファイルを検出・削除
 *  5. 同期中断チェックポイント — 再同期時に前回の中断を検知・通知
 */

const Drive = (() => {

  /* ─── CONFIG ─── */
  const CLIENT_ID   = '216604412012-80eanap7n3ldoa1npd73v22t9gl552nq.apps.googleusercontent.com';
  const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';
  const LOGS_FILE   = 'sonora_logs.json';   // separate log file for cross-device sync
  const SYNC_CHECKPOINT_KEY = 'syncCheckpoint';

  /* ─── STATE ─── */
  let _token       = null;
  let _userEmail   = null;
  let _tokenClient = null;
  let _autoSync    = false;
  let _syncBusy    = false;
  let _autoTimer   = null;
  let _debounce    = null;
  let _logTimer    = null;

  let _fid   = null;
  let _afid  = null;
  let _tfid  = null;
  let _lfid  = null;   // Drive file ID for sonora_logs.json

  // BUG FIX: アップロード重複防止ロック ('audio:<id>' | 'thumb:<id>')
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
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  }
  function _progDone() {
    setTimeout(() => {
      const w = document.getElementById('sync-progress-wrap');
      const f = document.getElementById('sync-bar-fill');
      if (w) w.classList.remove('visible');
      if (f) f.style.width = '0%';
    }, 2000);
  }

  /* ─── PARALLEL RUNNER (max N concurrent) ─── */
  async function _parallel(items, fn, limit = 3) {
    // BUG FIX: 空配列のとき不要なワーカーを生成しない
    if (!items.length) return;
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          try { await fn(item); } catch (e) { console.warn('[Drive] parallel task err:', e); }
        }
      })
    );
  }

  /* ─── SYNC CHECKPOINT (中断検知) ─── */
  async function _saveCheckpoint(phase) {
    await Storage.setMeta(SYNC_CHECKPOINT_KEY, { phase, time: Date.now() }).catch(() => {});
  }
  async function _clearCheckpoint() {
    await Storage.deleteMeta(SYNC_CHECKPOINT_KEY).catch(() => {});
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
        // BUG FIX: 起動時はトークンを復元するだけ — 自動同期は別途スケジュールで行う
      }
    });

    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const t = document.getElementById('auto-sync-toggle');
      if (t && v) t.classList.add('on');
      // BUG FIX: autoSync が on かつ既にログイン済みの場合のみスケジュール開始
      if (v && _token) _scheduleAuto();
    });
  }

  async function _onToken(resp) {
    if (resp.error) { UI?.toast('Googleログインに失敗しました', 'error'); return; }
    _token = resp.access_token;
    const expiry = Date.now() + (resp.expires_in - 60) * 1000;
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: 'Bearer ' + _token } });
      const d = await r.json();
      _userEmail = d.email || null;
    } catch {}
    await Storage.setMeta('driveToken', { token: _token, expiry, email: _userEmail });
    _updateLoginUI(true);
    UI?.toast('Googleアカウントでログインしました');
    // BUG FIX: ログイン直後の自動同期は autoSync が有効な場合のみ実行
    if (_autoSync) {
      syncNow();
    }
  }

  function toggleLogin() { _token ? _logout() : _login(); }
  function _login() {
    if (!_tokenClient) { UI?.toast('Google認証の読み込み中です', 'error'); return; }
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }
  function _logout() {
    if (_token && typeof google !== 'undefined')
      google.accounts.oauth2.revoke(_token, () => {});
    _token = null; _userEmail = null;
    _fid = null; _afid = null; _tfid = null;
    _uploadingIds.clear();
    clearTimeout(_autoTimer);
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
    _logTimer = setTimeout(async () => {
      if (!_token) return;
      try {
        // 必ず pull → push の順で実行し、他端末のログを取り込んでからプッシュする。
        // これにより「プッシュ時に相手のログを上書き消去」を防ぐ。
        await _folders();            // フォルダIDが未取得の場合に備えて初期化
        await _pullAndMergeLogs();   // ①他端末のログをローカルへマージ
        await _pushLogs();           // ②マージ済みログを Drive へプッシュ
      } catch (e) {
        console.warn('[Drive] scheduleSyncLogs error:', e);
        // フォールバック: インデックスにも logs が含まれているためプッシュを試みる
        _pushIndex().catch(() => {});
      }
    }, 10000);  // 10 second debounce
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
    // BUG FIX: 204 No Content (DELETE 成功) はボディなしで正常
    if (res.status === 204) return null;
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
      JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] }),
      'application/json');
  }
  async function _upload(name, mime, data, parentId, existingId) {
    const metaObj = { name, parents: existingId ? undefined : (parentId ? [parentId] : []) };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metaObj)], { type: 'application/json' }));
    form.append('file', data instanceof Blob ? data : new Blob([data], { type: mime }), name);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    return _api(existingId ? 'PATCH' : 'POST', url, form);
  }
  const _download = id =>
    _api('GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);

  // BUG FIX: raw fetch → _api 経由に変更して 401 ハンドリングを統一。
  // 404 (既に削除済み) は無視する。
  async function _deleteFile(id) {
    if (!_token || !id) return;
    try {
      await _api('DELETE', `https://www.googleapis.com/drive/v3/files/${id}`);
    } catch (e) {
      if (!e.message?.includes('Drive 404')) {
        console.warn('[Drive] _deleteFile failed:', id, e.message);
      }
    }
  }

  /* ─── FOLDER SETUP ─── */
  async function _folders() {
    if (!_fid) _fid = await Storage.getMeta('driveFolderId');
    if (!_fid) {
      const r = await _list({
        q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      });
      _fid = r.files?.[0]?.id || (await _createFolder(FOLDER_NAME)).id;
      await Storage.setMeta('driveFolderId', _fid);
    }
    const [af, tf] = await Promise.all([
      _ensureSubFolder('audio',  'driveAudioFolderId', _afid),
      _ensureSubFolder('thumbs', 'driveThumbFolderId', _tfid),
    ]);
    _afid = af; _tfid = tf;
  }
  async function _ensureSubFolder(name, metaKey, cached) {
    if (cached) return cached;
    let id = await Storage.getMeta(metaKey);
    if (!id) {
      const r = await _list({
        q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      id = r.files?.[0]?.id || (await _createFolder(name, _fid)).id;
      await Storage.setMeta(metaKey, id);
    }
    return id;
  }

  /* ─── INDEX ─── */
  async function _indexFileId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (!id) {
      const r = await _list({
        q: `name='${INDEX_FILE}' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveIndexFileId', id); }
    }
    return id || null;
  }
  async function _pushIndex() {
    await _folders();
    const snap       = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snap.deletedIds  = deletedIds;
    const blob       = new Blob([JSON.stringify(snap)], { type: 'application/json' });
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

  /* ─── LOGS FILE (sonora_logs.json) ─── */
  async function _logsFileId() {
    if (_lfid) return _lfid;
    let id = await Storage.getMeta('driveLogsFileId');
    if (!id) {
      await _folders();
      const r = await _list({
        q: `name='${LOGS_FILE}' and '${_fid}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveLogsFileId', id); }
    }
    _lfid = id || null;
    return _lfid;
  }

  async function _pushLogs() {
    await _folders();
    const logs = await Storage.getLogs();
    const blob = new Blob([JSON.stringify({ version: 1, logs })], { type: 'application/json' });
    const existing = await _logsFileId();
    const r = await _upload(LOGS_FILE, 'application/json', blob, _fid, existing);
    if (r?.id) {
      _lfid = r.id;
      await Storage.setMeta('driveLogsFileId', r.id);
    }
  }

  async function _pullAndMergeLogs() {
    const id = await _logsFileId();
    if (!id) return;
    try {
      const buf    = await _download(id);
      const remote = JSON.parse(new TextDecoder().decode(buf));
      const localLogs = await Storage.getLogs();
      const exIds  = new Set(localLogs.map(l => l.id));
      let added = 0;
      for (const log of remote.logs || []) {
        // IDが存在しない場合だけ追加（既存エントリを絶対に上書きしない）
        if (!exIds.has(log.id)) {
          await Storage.addLogRaw(log);
          exIds.add(log.id);   // 同一バッチ内の重複も防ぐ
          added++;
        }
      }
      if (added > 0) console.log(`[Drive] Merged ${added} remote log entries`);
    } catch (e) {
      console.warn('[Drive] _pullAndMergeLogs error:', e);
    }
  }

  /* ─── AUDIO / THUMB TRANSFER ─── */

  // BUG FIX: _uploadingIds ロックで同一トラックの並行アップロードを防止。
  // アップロード前に最新のトラック情報を再取得し、既存の driveFileId を使って
  // PATCH (上書き) にする — これにより Drive 側の重複ファイルを防ぐ。
  async function _uploadAudio(track) {
    if (!track.blobKey) return;
    const lockKey = 'audio:' + track.id;
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      const buf = await Storage.getBlob(fresh.blobKey);
      if (!buf) return;
      const r = await _upload(fresh.id + '.mp3', 'audio/mpeg', buf, _afid, fresh.driveFileId || null);
      if (r?.id) await Storage.updateTrack(fresh.id, { driveFileId: r.id });
    } finally {
      _uploadingIds.delete(lockKey);
    }
  }
  async function _uploadThumb(track) {
    if (!track.thumbKey) return;
    const lockKey = 'thumb:' + track.id;
    if (_uploadingIds.has(lockKey)) return;
    _uploadingIds.add(lockKey);
    try {
      const fresh = (await Storage.getTrack(track.id)) || track;
      const buf = await Storage.getBlob(fresh.thumbKey);
      if (!buf) return;
      const r = await _upload(fresh.id + '.jpg', 'image/jpeg', buf, _tfid, fresh.driveThumbId || null);
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
      const base = (fileName || '').replace(/\.[^.]+$/, '');
      const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
      return { title: dash ? dash[2].trim() : base, artist: dash ? dash[1].trim() : '', duration: 0, releaseDate: null, thumbData: null, thumbMime: null, rawBuffer: null };
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
        a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
        a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
        setTimeout(() => { URL.revokeObjectURL(url); resolve(0); }, 8000);
      });
      return { ...meta, duration: dur, rawBuffer: raw };
    } catch { return fallback(); }
  }

  /* ─────────────────────────────────────────
     DIFF: Drive audio/ フォルダとローカルトラックの差分計算
  ───────────────────────────────────────── */
  async function _diffAudio(localTracks, deletedIds) {
    const r = await _list({
      q:        `'${_afid}' in parents and trashed=false`,
      fields:   'files(id,name,modifiedTime)',
      pageSize: 1000,
    }).catch(() => ({ files: [] }));

    const driveFiles     = r.files || [];
    const driveIdSet     = new Set(driveFiles.map(f => f.id));
    const localByDriveId = new Map(
      localTracks.filter(t => t.driveFileId).map(t => [t.driveFileId, t])
    );

    const toAdd    = [];
    const toDelete = [];
    // BUG FIX: 同一ベース名の重複 Drive ファイルを検出するためのセット
    const handledBases = new Set();

    for (const df of driveFiles) {
      const base = df.name.replace(/\.[^.]+$/, '');

      // Case 1: ローカルで削除済み — Drive からも消す
      if (deletedIds.has(base) || deletedIds.has(df.id)) {
        toDelete.push(df.id);
        continue;
      }
      // Case 2: driveFileId が一致するローカルトラックがある → 処理済み
      if (localByDriveId.has(df.id)) {
        handledBases.add(base);
        continue;
      }
      // Case 3: ベース名がローカルトラック ID と一致 → 紐付け
      const matchByBase = localTracks.find(t => t.id === base);
      if (matchByBase) {
        if (!matchByBase.driveFileId)
          await Storage.updateTrack(matchByBase.id, { driveFileId: df.id });
        // BUG FIX: 同じベース名が既に処理済みなら重複ファイル → 削除対象
        if (handledBases.has(base)) {
          toDelete.push(df.id);
        } else {
          handledBases.add(base);
        }
        continue;
      }
      // Case 4: 完全に新規の Drive ファイル
      if (!handledBases.has(base)) {
        toAdd.push(df);
        handledBases.add(base);
      } else {
        // 同名の新規ファイルが複数存在 → 余分な方を削除
        toDelete.push(df.id);
      }
    }

    // Drive 側から消えたファイル (driveFileId があるのに Drive に存在しない)
    const driveDeleted = localTracks.filter(
      t => t.driveFileId && !driveIdSet.has(t.driveFileId)
    );

    return { toAdd, toDelete, driveDeleted };
  }

  /* ─────────────────────────────────────────
     MAIN SYNC
  ───────────────────────────────────────── */
  async function syncNow() {
    if (!_token)   { UI?.toast('ログインしてから同期してください', 'error'); return; }
    if (_syncBusy) return;
    _syncBusy = true;

    try {
      // 前回の中断チェックポイントを確認
      const prevCp = await Storage.getMeta(SYNC_CHECKPOINT_KEY);
      if (prevCp) {
        const minsSince = Math.round((Date.now() - prevCp.time) / 60000);
        console.warn(`[Drive] 前回同期が '${prevCp.phase}' フェーズで中断 (${minsSince}分前)。再同期します。`);
        UI?.toast('前回の同期が中断されました。再同期します...', '');
      }

      _prog(5, 'フォルダを確認中...');
      await _saveCheckpoint('folders');
      await _folders();

      /* Phase A — リモートデータ取得 */
      _prog(10, 'リモートデータを取得中...');
      await _saveCheckpoint('pull');
      const [remoteIndex, localTracks] = await Promise.all([
        _pullIndex(),
        Storage.getTracks(),
      ]);

      const deletedIds   = new Set(await Storage.getMeta('deletedTrackIds', []));
      const remoteDelIds = new Set(remoteIndex?.deletedIds || []);

      /* Phase B — リモート削除の適用 + スナップショットマージ */
      _prog(20, '差分を計算中...');
      await _saveCheckpoint('merge');

      for (const id of remoteDelIds) {
        const t = localTracks.find(t2 => t2.id === id);
        if (t && !deletedIds.has(id)) {
          await Storage.deleteTrack(id);
          deletedIds.add(id);
        }
      }
      if (remoteIndex) await Storage.importSnapshot(remoteIndex);

      /* Phase C — Drive audio/ フォルダとの差分 */
      _prog(30, 'Driveファイルを確認中...');
      await _saveCheckpoint('diff');
      const freshTracks = await Storage.getTracks();
      const { toAdd, toDelete, driveDeleted } = await _diffAudio(freshTracks, deletedIds);

      /* ローカルで削除されたファイルを Drive からも削除 */
      _prog(35, 'Driveからファイルを削除中...');
      await _saveCheckpoint('delete_drive');
      await _parallel(toDelete, id => _deleteFile(id), 3);

      /* Drive 側から消えていたファイルをローカルからも削除 */
      for (const t of driveDeleted) {
        deletedIds.add(t.id);
        await Storage.deleteTrack(t.id);
      }

      /* Phase D — ローカル削除済みトラックの Drive ファイルをクリーンアップ */
      _prog(40, 'ローカル削除を同期中...');
      await _saveCheckpoint('cleanup');
      for (const id of deletedIds) {
        const remoteTrack = remoteIndex?.tracks?.find(t => t.id === id);
        if (remoteTrack?.driveFileId)  await _deleteFile(remoteTrack.driveFileId).catch(() => {});
        if (remoteTrack?.driveThumbId) await _deleteFile(remoteTrack.driveThumbId).catch(() => {});
      }

      /* Phase E — ファイル転送 */
      const afterMerge  = await Storage.getTracks();
      const needUpAudio = afterMerge.filter(t =>  t.blobKey  && !t.driveFileId);
      const needDlAudio = afterMerge.filter(t => !t.blobKey  &&  t.driveFileId);
      const needUpThumb = afterMerge.filter(t =>  t.thumbKey && !t.driveThumbId);
      const needDlThumb = afterMerge.filter(t => !t.thumbKey &&  t.driveThumbId);

      const totalIO = needUpAudio.length + needDlAudio.length + needUpThumb.length
                    + needDlThumb.length + toAdd.length;
      let doneIO = 0;
      const tick = () => {
        doneIO++;
        _prog(45 + (doneIO / Math.max(totalIO, 1)) * 40, '同期中...');
      };

      _prog(45, 'ファイルを転送中...');
      await _saveCheckpoint('transfer');
      await Promise.all([
        _parallel(needUpAudio, async t => { await _uploadAudio(t);  tick(); }, 3),
        _parallel(needDlAudio, async t => { await _downloadAudio(t); tick(); }, 3),
        _parallel(needUpThumb, async t => { await _uploadThumb(t);  tick(); }, 3),
        _parallel(needDlThumb, async t => { await _downloadThumb(t); tick(); }, 2),
      ]);

      /* Phase F — Drive 直接追加ファイルを取り込む */
      _prog(85, '新規ファイルを取り込み中...');
      await _saveCheckpoint('import');
      for (const df of toAdd) {
        await _importDriveFile(df);
        tick();
      }

      /* Phase G — ログをマージ＆プッシュ (別ファイル) */
      _prog(88, 'ログを同期中...');
      await _saveCheckpoint('sync_logs');
      await _pullAndMergeLogs();   // 他端末のログを取り込む
      await _pushLogs();           // マージ済みログをプッシュ

      /* Phase H — インデックスをプッシュ */
      _prog(93, 'インデックスを保存中...');
      await _saveCheckpoint('push_index');
      await _pushIndex();

      // インデックスプッシュ成功後に deletedIds を確定保存
      await Storage.setMeta('deletedTrackIds', [...deletedIds]);

      // 正常完了 — チェックポイントを消去
      await _clearCheckpoint();

      _prog(100, '同期完了');
      _progDone();
      UI?.toast('同期が完了しました', 'success');
      if (typeof App !== 'undefined') App.refreshAll();

    } catch (err) {
      console.error('[Drive] Sync error:', err);
      // チェックポイントは残して次回起動時に中断を検知できるようにする
      _progDone();
      UI?.toast('同期エラー: ' + (err.message || '不明'), 'error');
    } finally {
      _syncBusy = false;
    }
  }

  /* ─── IMPORT A DRIVE-DIRECT FILE ─── */
  async function _importDriveFile(driveFile) {
    const meta = await _extractMeta(driveFile.id, driveFile.name);

    let blobKey  = null;
    let thumbKey = null;

    if (meta.rawBuffer) blobKey  = await Storage.saveBlob(meta.rawBuffer);
    if (meta.thumbData) thumbKey = await Storage.saveBlob(meta.thumbData);

    const base    = driveFile.name.replace(/\.[^.]+$/, '');
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
    // BUG FIX: ログイン状態に関わらず deletedIds に記録 (次回同期で伝播)
    const existing = await Storage.getMeta('deletedTrackIds', []);
    if (!existing.includes(trackId)) existing.push(trackId);
    await Storage.setMeta('deletedTrackIds', existing);

    if (_token) {
      try { await _folders(); } catch {}
      await Promise.all([
        driveFileId  ? _deleteFile(driveFileId).catch(() => {})  : Promise.resolve(),
        driveThumbId ? _deleteFile(driveThumbId).catch(() => {}) : Promise.resolve(),
      ]);
      await _pushIndex().catch(() => {});
    }
  }

  /* ─── FULL DRIVE RESET ─── */
  async function resetDriveData() {
    if (!_token) return;
    _prog(5, 'Driveデータを削除中...');
    if (_fid) await _deleteFile(_fid).catch(() => {});
    _fid = null; _afid = null; _tfid = null; _lfid = null;
    await Promise.all([
      Storage.deleteMeta('driveFolderId'),
      Storage.deleteMeta('driveAudioFolderId'),
      Storage.deleteMeta('driveThumbFolderId'),
      Storage.deleteMeta('driveIndexFileId'),
      Storage.deleteMeta('driveLogsFileId'),
    ]);
    await _clearCheckpoint();
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
