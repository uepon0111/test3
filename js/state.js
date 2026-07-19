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

// ルート/Resultsフォルダの検索・作成処理は非同期のため、複数箇所(画像アップロード・
// 設定のDrive同期など)からほぼ同時に呼ばれると「無い→作成」の判定が競合し、同名の
// フォルダが重複作成されてしまう可能性があります。これを防ぐため、進行中の解決処理
// そのもの(Promise)を共有してキャッシュし、後続の呼び出しは新たに検索・作成を
// 行わずこのPromiseの完了を待つだけにします(「トランザクション」的な排他制御)。
// ルートのみを必要とする呼び出し(設定のDrive同期)と、ルート+Resultsの両方を
// 必要とする呼び出し(画像アップロード)があるため、2段階それぞれに別々のロックを持たせています。
let rootFolderEnsurePromise = null;
let resultsFolderEnsurePromise = null;

function resetDriveFolderCache() {
  cachedRootFolderId = null;
  cachedResultsFolderId = null;
  rootFolderEnsurePromise = null;
  resultsFolderEnsurePromise = null;
}

// --- 並び替え状態 ---
let currentSortMode = DEFAULT_SORT_MODE;
let sortDirections = Object.assign({}, DEFAULT_SORT_DIRECTIONS);

// --- 自己ベストのみ表示 ---
let showBestOnly = false;

// --- 機種プロファイル (アップロード時に使用。実体は localStorage で device-profiles.js が管理) ---
let deviceProfilesCache = null; // getDeviceProfiles() の結果をメモリキャッシュ
