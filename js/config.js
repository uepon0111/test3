/*
 * config.js
 * -----------------------------------------------------------------------
 * アプリ全体で共有する定数・設定値をまとめたファイルです。
 * index.html / settings.html の両方から読み込まれます。
 * -----------------------------------------------------------------------
 */

// ↓↓↓ GCP Settings ↓↓↓ (元のindex.htmlから移動。値は変更していません)
const CLIENT_ID = '966636096862-8hrrm5heb4g5r469veoels7u6ifjguuk.apps.googleusercontent.com';
const API_KEY = 'AIzaSyC-m1rkHuJTmNK2k-s89bJFshvXCS5MZZ0';
// ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑

const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive';

// 楽曲マスターデータ (プロセカ非公式データベース)
const MUSICS_URL = 'https://sekai-world.github.io/sekai-master-db-diff/musics.json';
const MUSIC_DIFFICULTIES_URL = 'https://sekai-world.github.io/sekai-master-db-diff/musicDifficulties.json';

// --- Google Drive 上のフォルダ構成 ---
// ルートフォルダ名は既存運用との継続性のため変更していません。
const ROOT_FOLDER_NAME = "プロセカリザルト";
// 新方式: ルート直下の1つのフォルダに全リザルト画像をフラットに格納し、
// 曲ごとのサブフォルダを作らないことでフォルダ作成/検索コストを大幅に削減します。
const RESULTS_FOLDER_NAME = "Results";
// 旧方式(曲ごとのサブフォルダ構成)。読み取り専用の後方互換用に残します。
const LEGACY_FOLDER_NAME = "FC";

// --- 難易度定義 ---
// code: 内部/保存用の2文字コード, label: 表示名, color: タグ色, rank: 易しい順の序列, dbKey: マスターDB上のキー
const DIFFICULTIES = [
  { code: 'EZ', label: 'EASY',   color: '#66DA7E', rank: 1, dbKey: 'easy' },
  { code: 'NM', label: 'NORMAL', color: '#66C9F9', rank: 2, dbKey: 'normal' },
  { code: 'HD', label: 'HARD',   color: '#F5CC44', rank: 3, dbKey: 'hard' },
  { code: 'EX', label: 'EXPERT', color: '#EA5577', rank: 4, dbKey: 'expert' },
  { code: 'MS', label: 'MASTER', color: '#BB40F5', rank: 5, dbKey: 'master' },
  { code: 'AP', label: 'APPEND', color: '#EE82E2', rank: 6, dbKey: 'append' },
];

// 旧バージョン(1文字コード: H/E/M/A)からの変換マップ。旧データ読み込み時の後方互換用。
const LEGACY_DIFF_CODE_MAP = { 'H': 'HD', 'E': 'EX', 'M': 'MS', 'A': 'AP' };

function getDiffByCode(code) { return DIFFICULTIES.find(d => d.code === code) || null; }
function getDiffRank(code) { const d = getDiffByCode(code); return d ? d.rank : 0; }
function getDiffColor(code) { const d = getDiffByCode(code); return d ? d.color : '#999999'; }
function getDiffLabel(code) { const d = getDiffByCode(code); return d ? d.label : (code || '?'); }
function getDiffDbKey(code) { const d = getDiffByCode(code); return d ? d.dbKey : null; }
function getDiffCodeByDbKey(dbKey) { const d = DIFFICULTIES.find(d => d.dbKey === dbKey); return d ? d.code : null; }

// --- 読み取り範囲(クロップ範囲)のデフォルト値 ---
// すべて画像サイズに対する比率(0〜1)。プロフィールが1件も無い場合の最終フォールバックとして使用します。
// 参考として提供されたリザルト画像(1530×1069)を実測してキャリブレーションしています
// (difficulty/titleは旧デフォルトとほぼ一致、breakdown/comboは旧デフォルトが実態と大きくズレて
// いたため実測値に置き換え。levelは今回新規追加)。実機の解像度・機種差はあるため、
// 最終的には設定画面(読み取り設定)でサンプル画像を見ながら微調整してください。
const DEFAULT_REGIONS = {
  difficulty: { x: 0.185, y: 0.065, w: 0.125, h: 0.045 },
  level:      { x: 0.298, y: 0.063, w: 0.118, h: 0.048 },
  title:      { x: 0.186, y: 0.012, w: 0.360, h: 0.048 },
  breakdown:  { x: 0.121, y: 0.526, w: 0.188, h: 0.243 },
  combo:      { x: 0.431, y: 0.526, w: 0.082, h: 0.052 },
};

// 読み取り範囲の項目メタ情報 (設定画面での表示順・ラベル・色に使用)
const REGION_DEFS = [
  { key: 'difficulty', label: '難易度',       color: '#007bff' },
  { key: 'level',      label: '楽曲レベル',   color: '#fd7e14' },
  { key: 'title',      label: '曲名',         color: '#28a745' },
  { key: 'breakdown',  label: '判定内訳',     color: '#e6a700' },
  { key: 'combo',      label: 'コンボ数',     color: '#dc3545' },
];

// --- OCR実測ログ・信頼度まわりの設定 ---
// 曲名のファジーマッチが「自信あり」と判定されるしきい値。
// levenshtein距離を文字数で正規化した値がこれ以下なら信頼できる一致とみなす。
// (加えて、絶対距離が1以下の場合も短いタイトルの誤差を許容するため信頼扱いにする)
const TITLE_MATCH_CONFIDENT_MAX_NORM_DIST = 0.30;
const TITLE_MATCH_CONFIDENT_MAX_ABS_DIST = 1;

// 総ノーツ数から楽曲候補を逆算する際、OCRの数え間違い(1〜2ノーツ程度)を許容する誤差幅。
// まず誤差0(完全一致)で候補を絞り込み、候補が無い場合のみこの範囲まで広げて再探索する。
const NOTE_COUNT_BACK_CALC_TOLERANCE = 2;

// Tesseractのconfidence(0〜100)がこの値未満の場合、その項目は「読み取り信頼度が低い」として
// 実測ログ・警告表示の対象にする。
const OCR_LOW_CONFIDENCE_THRESHOLD = 55;

// --- localStorage キー ---
const LS_KEY_DEVICE_PROFILES = 'prsk_device_profiles_v1';

// --- ソート設定 ---
const SORT_MODES = [
  { key: 'name',  label: '名前順' },
  { key: 'level', label: '楽曲レベル順' },
  { key: 'miss',  label: 'ミス数順' },
  { key: 'date',  label: '追加日順' },
];
const DEFAULT_SORT_MODE = 'level';
const DEFAULT_SORT_DIRECTIONS = { name: 'asc', level: 'desc', miss: 'asc', date: 'desc' };
