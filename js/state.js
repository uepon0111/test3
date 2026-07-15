/*
 * state.js
 * -----------------------------------------------------------------------
 * index.html 内の各スクリプトから参照・更新される共有状態(グローバル変数)。
 * 1箇所にまとめることで重複宣言を避け、状態の流れを追いやすくします。
 * -----------------------------------------------------------------------
 */

// --- 認証まわり ---
let tokenClient;
let gapiInited = false;
let gisInited = false;

// --- リザルトデータ ---
let allRecords = [];       // Drive から取得した全レコード
let filteredRecords = [];  // 現在の絞り込み・並び替え後に表示中のレコード

// --- 楽曲マスターDB ---
let dbMusics = [];
let dbDiffs = [];

// --- 選択モード ---
let isSelectMode = false;
let selectedIds = new Set();

// --- 一括アップロード/編集モーダル ---
let editorQueue = []; // { id, file, imgUrl, status, data:{}, originalId, originalParent, schema }
let activeItemId = null;
let currentMode = 'upload'; // 'upload' or 'edit'

// --- Drive フォルダIDキャッシュ (バッチ処理中の重複検索を避けるため) ---
let cachedRootFolderId = null;
let cachedResultsFolderId = null;
let cachedLegacyFolderId = null;   // 見つかった場合のフォルダID (存在しない場合はnullのまま)
let legacyFolderChecked = false;   // 旧FCフォルダの検索を既に試みたか

function resetDriveFolderCache() {
  cachedRootFolderId = null;
  cachedResultsFolderId = null;
  cachedLegacyFolderId = null;
  legacyFolderChecked = false;
}

// --- 並び替え状態 ---
let currentSortMode = DEFAULT_SORT_MODE;
let sortDirections = Object.assign({}, DEFAULT_SORT_DIRECTIONS);

// --- 自己ベストのみ表示 ---
let showBestOnly = false;

// --- 機種プロファイル (アップロード時に使用。実体は localStorage で device-profiles.js が管理) ---
let deviceProfilesCache = null; // getDeviceProfiles() の結果をメモリキャッシュ
