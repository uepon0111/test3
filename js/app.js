/**
 * app.js — Main orchestrator for Sonora
 */

const App = (() => {

  let _currentPage = 'player';

  /* ─── BOOT ─── */
  async function boot() {
    try {
      await Storage.open();
      Player.init();
      Drive.init();
      UI.init();
      await UI.loadData();
      UI.renderPlaylistTabs();
      UI.applySort();
      await Player.restoreState();
      switchPage('player');
      UI.onPageSwitch('player');
      console.log('[Sonora] Boot complete');
    } catch (err) {
      console.error('[Sonora] Boot error:', err);
      UI.toast('初期化エラー: ' + (err.message || '不明'), 'error');
    }
  }

  /* ─── PAGE NAVIGATION ─── */
  function switchPage(name) {
    _currentPage = name;
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === name + '-page');
    });
    UI.onPageSwitch(name);
    if (name === 'log')  UI.renderLogOverview();
    if (name === 'edit') UI.renderEditGrid();
  }

  function switchBotNav(btn) {
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  /* ─── FILE UPLOAD ─── */
  async function uploadFiles() {
    const queue = UI.getUploadQueue();
    if (!queue.length) return;
    UI.closeModal('upload-modal');
    UI.toast(`${queue.length}曲を追加中...`);

    const added = [];
    for (const item of queue) {
      try {
        const buf = await _readAsBuffer(item.file);

        // Save audio blob
        const blobKey = await Storage.saveBlob(buf);

        // Save thumbnail if extracted from ID3
        let thumbKey = null;
        if (item.thumbData) {
          thumbKey = await Storage.saveBlob(item.thumbData);
        }

        const track = await Storage.addTrack({
          title:       item.title,
          artist:      item.artist       || '',
          releaseDate: item.releaseDate  || null,
          duration:    item.duration     || 0,
          blobKey,
          thumbKey,
        });
        added.push(track);
      } catch (err) {
        console.error('Upload error:', item.file.name, err);
        UI.toast(`追加失敗: ${item.title}`, 'error');
      }
    }

    await UI.refreshAll();
    UI.toast(`${added.length}曲を追加しました`, 'success');

    // Push to Drive asynchronously (do not await — let UI remain responsive)
    for (const track of added) {
      Drive.onTrackAdded(track).catch(() => {});
    }
  }

  function _readAsBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = e => resolve(e.target.result);
      r.onerror = e => reject(e.target.error);
      r.readAsArrayBuffer(file);
    });
  }

  /* ─── TRACK CRUD ─── */
  async function deleteTrack(id) {
    try {
      // Get Drive IDs BEFORE deleting from Storage
      const track = await Storage.getTrack(id);
      const driveFileId  = track?.driveFileId  || null;
      const driveThumbId = track?.driveThumbId || null;

      // 1. Notify Drive (records deletion + deletes Drive files + pushes index)
      await Drive.onTrackDeleted(id, driveFileId, driveThumbId);

      // 2. Delete from local Storage (blobs, logs, playlists)
      await Storage.deleteTrack(id);

      // 3. Refresh UI
      await UI.refreshAll();
      UI.toast('曲を削除しました');
    } catch (err) {
      console.error('Delete track error:', err);
      UI.toast('削除に失敗しました', 'error');
    }
  }

  async function saveTrackEdit() {
    const data = await UI.getEditFormData();
    if (!data.id) return;
    try {
      const changes = {
        title:       data.title,
        artist:      data.artist,
        releaseDate: data.releaseDate,
        tags:        data.tags,
      };
      if (data.thumbData) {
        const track = await Storage.getTrack(data.id);
        if (track.thumbKey) await Storage.deleteBlob(track.thumbKey);
        changes.thumbKey      = await Storage.saveBlob(data.thumbData);
        changes.driveThumbId  = null; // will re-upload on next sync
      }
      await Storage.updateTrack(data.id, changes);
      await UI.refreshAll();
      UI.closeModal('edit-track-modal');
      UI.toast('情報を保存しました', 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save track edit error:', err);
      UI.toast('保存に失敗しました', 'error');
    }
  }

  /* ─── PLAYLIST CRUD ─── */
  async function createPlaylist() {
    const data = UI.getNewPlaylistData();
    if (!data.name) { UI.toast('プレイリスト名を入力してください','error'); return; }
    try {
      await Storage.createPlaylist(data.name, data.desc);
      await UI.refreshPlaylists();
      UI.closeModal('new-playlist-modal');
      UI.toast(`「${data.name}」を作成しました`, 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Create playlist error:', err);
      UI.toast('作成に失敗しました', 'error');
    }
  }

  async function deletePlaylist(id) {
    try {
      await Storage.deletePlaylist(id);
      await UI.refreshPlaylists();
      UI.switchPlaylist('__all__');
      UI.toast('プレイリストを削除しました');
      Drive.triggerAutoSync();
    } catch {}
  }

  /* ─── TAG CRUD ─── */
  async function saveTag() {
    const data = UI.getTagFormData();
    if (!data.name) { UI.toast('タグ名を入力してください','error'); return; }
    try {
      if (data.id) {
        await Storage.updateTag(data.id, { name:data.name, color:data.color, textColor:data.textColor });
        UI.toast('タグを更新しました', 'success');
      } else {
        await Storage.createTag(data.name, data.color, data.textColor);
        UI.toast(`タグ「${data.name}」を作成しました`, 'success');
      }
      await UI.refreshTags();
      await UI.renderTagManager();
      UI.closeModal('tag-modal');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save tag error:', err);
      UI.toast('タグの保存に失敗しました', 'error');
    }
  }

  async function deleteTag(id) {
    try {
      await Storage.deleteTag(id);
      await UI.refreshAll();
      UI.renderTagManager();
      UI.toast('タグを削除しました');
      Drive.triggerAutoSync();
    } catch {}
  }

  /* ─── RESET ─── */
  function confirmReset(type) {
    const msgs = {
      cache: 'ページのキャッシュ（音声ファイル含む）を全て削除します。\nDrive上のデータは残ります。この操作は取り消せません。',
      all:   'キャッシュとGoogle Drive上の全データを削除します。\nこの操作は完全に取り消せません。',
    };
    const titleEl = document.getElementById('confirm-title');
    const msgEl   = document.getElementById('confirm-msg');
    const okBtn   = document.getElementById('confirm-ok-btn');
    if (titleEl) titleEl.textContent = type==='all' ? '全データリセット' : 'キャッシュリセット';
    if (msgEl)   msgEl.textContent   = msgs[type] || '';
    if (okBtn)   okBtn.onclick = async () => {
      UI.closeModal('confirm-modal');
      await _doReset(type);
    };
    UI.openModal('confirm-modal');
  }

  async function _doReset(type) {
    try {
      UI.toast('リセット中...');
      if (type === 'all') await Drive.resetDriveData();
      await Storage.resetAll();
      await UI.refreshAll();
      Player.setQueue([], -1);
      UI.toast('リセットが完了しました', 'success');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      console.error('Reset error:', err);
      UI.toast('リセットに失敗しました', 'error');
    }
  }

  /* ─── REFRESH (called by Drive after sync) ─── */
  async function refreshAll() {
    await UI.refreshAll();
    if (_currentPage === 'log')  UI.renderLogOverview();
    if (_currentPage === 'edit') UI.renderEditGrid();
  }

  /* ─── KEYBOARD SHORTCUTS ─── */
  function _initKeyboard() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.code) {
        case 'Space':      e.preventDefault(); Player.togglePlay(); break;
        case 'ArrowRight': if (e.altKey) Player.next(); break;
        case 'ArrowLeft':  if (e.altKey) Player.prev(); break;
        case 'KeyM':       Player.toggleMute(); break;
        case 'Escape': {
          const fp = document.getElementById('full-player-overlay');
          if (fp?.classList.contains('open')) { UI.closeFullPlayer(); return; }
          document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
          break;
        }
      }
    });
  }

  /* ─── MEDIA SESSION API ─── */
  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play',          () => Player.play());
    navigator.mediaSession.setActionHandler('pause',         () => Player.pause());
    navigator.mediaSession.setActionHandler('nexttrack',     () => Player.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => Player.prev());
    document.getElementById('audio-el')?.addEventListener('play', async () => {
      const id    = Player.getCurrentTrackId();
      const track = id ? await Storage.getTrack(id) : null;
      if (!track) return;
      const artwork = [];
      if (track.thumbKey) {
        const url = await Storage.getBlobUrl(track.thumbKey);
        if (url) artwork.push({ src:url, sizes:'512x512' });
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title  || '',
        artist: track.artist || '',
        artwork,
      });
    });
  }

  /* ─── UNLOAD GUARD ─── */
  function _initUnloadGuard() {
    window.addEventListener('beforeunload', e => {
      if (Player.isPlaying()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ─── ENTRY POINT ─── */
  document.addEventListener('DOMContentLoaded', async () => {
    _initKeyboard();
    _initMediaSession();
    _initUnloadGuard();
    await boot();
  });

  /* ─── PUBLIC ─── */
  return {
    switchPage, switchBotNav,
    uploadFiles,
    deleteTrack, saveTrackEdit,
    createPlaylist, deletePlaylist,
    saveTag, deleteTag,
    confirmReset,
    refreshAll,
  };
})();
