'use strict';

/* ============================================================
   MAIN  —  アプリ起動・初期化
   ============================================================ */

let _layoutInit = false;

/* ── レイアウト (縦横比) 更新 ── */
function _updateLayout() {
  const isLandscape = window.innerWidth > window.innerHeight;
  const app = el('app');
  if (!app) return;
  app.classList.toggle('app-landscape', isLandscape);
  app.classList.toggle('app-portrait',  !isLandscape);

  if (!_layoutInit) {
    AppState.editorColumns = isLandscape ? 4 : 2;
    _layoutInit = true;
  }
  const lbl = el('editor-cols-label');
  if (lbl) lbl.textContent = `${AppState.editorColumns}列`;
}

/* ── 画面切り替え ── */
function _switchScreen(name) {
  if (!['player','editor','log','settings'].includes(name)) return;

  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === name)
  );
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('active', s.id === `screen-${name}`)
  );

  const app = el('app');
  ['player','editor','log','settings'].forEach(s => app.classList.remove(`showing-${s}`));
  app.classList.add(`showing-${name}`);

  AppState.setScreen(name);
}

/* ── ナビゲーション ── */
function _setupNavigation() {
  document.querySelectorAll('[data-screen]').forEach(btn => {
    if (btn.classList.contains('nav-tab')) {
      btn.addEventListener('click', () => _switchScreen(btn.dataset.screen));
    }
  });
}

/* ── キーボードショートカット ── */
function _setupKeyboard() {
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      AudioEngine.togglePlay();
    }
    if (e.altKey && e.code === 'ArrowLeft')  AudioEngine.prev();
    if (e.altKey && e.code === 'ArrowRight') AudioEngine.next();
  });
}

/* ── 設定変更を自動保存 ── */
function _setupAutoSave() {
  EventBus.on('playback:update', () => {
    Storage.setSetting('volume',          AppState.volume);
    Storage.setSetting('speed',           AppState.playbackRate);
    Storage.setSetting('repeat',          AppState.repeat);
    Storage.setSetting('shuffle',         AppState.shuffle);
    Storage.setSetting('normalizeVolume', AppState.normalizeVolume);
    Storage.setSetting('trimSilence',     AppState.trimSilence);
  });
}

/* ── アプリ初期化 ── */
async function initApp() {

  /* 1. DB からデータ読み込み */
  try {
    const { tracks, playlists, tags, artists } = await Storage.loadAll();
    AppState.tracks    = tracks    || [];
    AppState.playlists = playlists || [];
    AppState.tags      = tags.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)) || [];
    AppState.artists   = artists   || [];

    /* 全曲プレイリストが存在しない場合は作成 */
    let allPl = AppState.playlists.find(p => p.isDefault);
    if (!allPl) {
      allPl = {
        id: 'all', name: 'すべての曲', isDefault: true,
        trackIds: AppState.tracks.map(t => t.id),
        createdAt: Date.now(),
      };
      AppState.playlists.unshift(allPl);
      await Storage.savePlaylist(allPl);
    } else {
      /* 未登録の曲を全曲リストに追加 */
      const inAll  = new Set(allPl.trackIds);
      const missing = AppState.tracks.filter(t => !inAll.has(t.id));
      if (missing.length) {
        missing.forEach(t => allPl.trackIds.push(t.id));
        await Storage.savePlaylist(allPl);
      }
    }
    AppState.currentPlaylistId = allPl.id;

    /* 保存済みの再生設定を復元 */
    AppState.volume          = await Storage.getSetting('volume',          100);
    AppState.playbackRate    = await Storage.getSetting('speed',           1.0);
    AppState.repeat          = await Storage.getSetting('repeat',          'none');
    AppState.shuffle         = await Storage.getSetting('shuffle',         false);
    AppState.normalizeVolume = await Storage.getSetting('normalizeVolume', false);
    AppState.trimSilence     = await Storage.getSetting('trimSilence',     false);

  } catch (e) {
    console.error('Init error:', e);
    Toast.error('データの読み込みに失敗しました');
  }

  /* 2. レイアウト初期化 */
  _updateLayout();
  window.addEventListener('resize', debounce(() => {
    _updateLayout();
    PlayerScreen.refreshTrackList();
    if (AppState.editorSection === 'tracks') EditorScreen.refreshGrid();
  }, 150));

  /* 3. Lucide アイコン (静的なもの) */
  lucide.createIcons();

  /* 4. イコライザ設定を読み込んで UI 反映 */
  await Equalizer.loadSettings();
  Equalizer.bindUI();

  /* 5. 各画面モジュール初期化 */
  PlayerScreen.init();
  EditorScreen.init();
  LogScreen.init();
  SettingsScreen.init();

  /* 6. 初期 UI 描画 */
  PlayerScreen.renderPlaylistTabs();
  PlayerScreen.refreshTrackList();
  PlayerScreen.PlayerWidgetUI.updateTrack();
  PlayerScreen.PlayerWidgetUI.updatePlayState();
  PlayerScreen.PlayerWidgetUI.updateShuffle();
  PlayerScreen.PlayerWidgetUI.updateRepeat();
  PlayerScreen.PlayerWidgetUI.updateSpeed();
  PlayerScreen.PlayerWidgetUI.updateVolume();

  /* 7. ナビゲーション・ショートカット */
  _setupNavigation();
  _switchScreen('player');
  _setupKeyboard();
  _setupAutoSave();

  /* 8. PWA: Service Worker 登録 */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
    });
  }
}

document.addEventListener('DOMContentLoaded', initApp);
