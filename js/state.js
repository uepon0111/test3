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
let cachedSettingsFileId = null;   // settings.json (機種プロファイル等の同期用ファイル) のID
// ensureRootAndResultsFolders() の同時呼び出し(例: アップロードと設定同期が同時に走った場合)が
// 別々にフォルダ作成を試みて重複フォルダを作ってしまわないよう、進行中のPromiseを共有するための変数
// (drive-client.js で使用。「トランザクション」的な排他制御の一種)
let ensureFoldersPromise = null;

function resetDriveFolderCache() {
  cachedRootFolderId = null;
  cachedResultsFolderId = null;
  cachedSettingsFileId = null;
  ensureFoldersPromise = null;
}

// --- 並び替え状態 ---
let currentSortMode = DEFAULT_SORT_MODE;
let sortDirections = Object.assign({}, DEFAULT_SORT_DIRECTIONS);

// --- 自己ベストのみ表示 ---
let showBestOnly = false;

// --- 機種プロファイル (アップロード時に使用。実体は localStorage で device-profiles.js が管理) ---
let deviceProfilesCache = null; // getDeviceProfiles() の結果をメモリキャッシュ

// --- ログイン中のGoogleアカウント識別 (設定のアカウント別保存・Drive同期に使用) ---
let currentAccountKey = null;      // ログイン中アカウントのメールアドレス (未ログイン時 null)
let settingsSyncState = 'idle';    // 'idle' | 'syncing' | 'synced' | 'error' (読み取り設定モーダルのバッジ表示用)
let settingsSyncInFlight = null;   // 同期処理の直列化用(連続保存で同期リクエストが競合しないように)

// 旧 settings.html (別ページ) の "?openSettings=1" リダイレクトを受けた際、読み取り設定は
// ログイン後のみ表示する方針(改善要望より)になったため、ログイン完了まで開くのを保留するフラグ。
let pendingOpenSettingsAfterLogin = false;
