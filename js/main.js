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

function openSettingsPanel() {
  const modal = document.getElementById('settingsModal');
  const iframe = document.getElementById('settingsFrame');
  if (!modal || !iframe) return;
  modal.style.display = 'flex';
  if (!iframe.src || !iframe.src.includes('settings.html')) {
    iframe.src = 'settings.html';
  }
}

function closeSettingsPanel() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
}

window.closeSettingsPanel = closeSettingsPanel;
window.openSettingsPanel = openSettingsPanel;

window.onload = async () => {
  populateDifficultySelect(document.getElementById('filter-diff'), { includeAll: true, defaultValue: 'all' });

  initSortControls();
  initBestOnlyToggle();
  initFilterControls();
  initUploadEditor();

  await loadMusicDb();
  getDeviceProfiles();
};
