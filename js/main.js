// Settings modal / embedded settings page (keeps auth session on the main page)
function openSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const frame = document.getElementById('settingsFrame');
  if (!modal || !frame) return;
  if (!frame.src || !frame.src.includes('settings.html')) {
    frame.src = 'settings.html';
  }
  modal.style.display = 'flex';
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
}

function initSettingsModal() {
  const btn = document.getElementById('settings_link');
  if (btn) btn.addEventListener('click', openSettingsModal);

  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'prsk-close-settings') {
      closeSettingsModal();
    }
    if (data.type === 'prsk-device-profiles-updated') {
      // Settings are stored in localStorage, so most UI reads see changes automatically.
      // This hook is here for future refresh logic and to keep the iframe-based flow explicit.
    }
  });
}

/*
 * main.js
 * -----------------------------------------------------------------------
 * index.html のブートストラップ処理。ページ読み込み時に一度だけ実行され、
 * 各モジュールの初期化(イベント登録・セレクトボックスの選択肢生成など)を行います。
 * -----------------------------------------------------------------------
 */

// 難易度セレクトボックスの選択肢を DIFFICULTIES (config.js) から生成する。
// filter-diff には「すべて」を含め、up-diff (アップロード編集フォーム) には含めない。
function populateDifficultySelect(selectEl, opts) {
  opts = opts || {};
  let html = '';
  if (opts.includeAll) html += `<option value="all">すべて</option>`;
  html += DIFFICULTIES.map(d => `<option value="${d.code}">${d.label}</option>`).join('');
  selectEl.innerHTML = html;
  if (opts.defaultValue) selectEl.value = opts.defaultValue;
}

window.onload = async () => {
  // 難易度フィルターの選択肢を生成
  populateDifficultySelect(document.getElementById('filter-diff'), { includeAll: true, defaultValue: 'all' });

  // 各種イベント初期化
  initSortControls();
  initBestOnlyToggle();
  initFilterControls();
  initUploadEditor();
  initSettingsModal();

  // 楽曲マスターDBの読み込み (アップロード解析時に使用)
  loadMusicDb();

  // 機種プロファイルを準備 (未作成なら「デフォルト」を1件作成)
  getDeviceProfiles();
};
