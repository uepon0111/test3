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

  // 楽曲マスターDBの読み込み (アップロード解析時に使用)
  loadMusicDb();

  // 機種プロファイルを準備 (未作成なら「デフォルト」を1件作成)
  getDeviceProfiles();

  // 旧 settings.html (別ページ)のブックマーク/リンクからのアクセスをリダイレクトで
  // 受けた場合、そのまま設定モーダルを開く。以前の状態(履歴)にURLを汚さないよう、
  // クエリパラメータは即座に取り除く。
  const params = new URLSearchParams(location.search);
  if (params.get('openSettings')) {
    history.replaceState(null, '', location.pathname);
    openSettingsModal();
  }
};
