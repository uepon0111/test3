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
const ROOT_FOLDER_NAME = "プロセカリザルト";
const RESULTS_FOLDER_NAME = "Results";
const LEGACY_FOLDER_NAME = "FC";

// --- 難易度定義 ---
const DIFFICULTIES = [
  { code: 'EZ', label: 'EASY',   color: '#66DA7E', rank: 1, dbKey: 'easy' },
  { code: 'NM', label: 'NORMAL', color: '#66C9F9', rank: 2, dbKey: 'normal' },
  { code: 'HD', label: 'HARD',   color: '#F5CC44', rank: 3, dbKey: 'hard' },
  { code: 'EX', label: 'EXPERT', color: '#EA5577', rank: 4, dbKey: 'expert' },
  { code: 'MS', label: 'MASTER', color: '#BB40F5', rank: 5, dbKey: 'master' },
  { code: 'AP', label: 'APPEND', color: '#EE82E2', rank: 6, dbKey: 'append' },
];

const LEGACY_DIFF_CODE_MAP = { 'H': 'HD', 'E': 'EX', 'M': 'MS', 'A': 'AP' };

function getDiffByCode(code) { return DIFFICULTIES.find(d => d.code === code) || null; }
function getDiffRank(code) { const d = getDiffByCode(code); return d ? d.rank : 0; }
function getDiffColor(code) { const d = getDiffByCode(code); return d ? d.color : '#999999'; }
function getDiffLabel(code) { const d = getDiffByCode(code); return d ? d.label : (code || '?'); }
function getDiffDbKey(code) { const d = getDiffByCode(code); return d ? d.dbKey : null; }

// --- 読み取り範囲(クロップ範囲)のデフォルト値 ---
const DEFAULT_REGIONS = {
  difficulty: { x: 0.20, y: 0.07, w: 0.10, h: 0.04 },
  level:      { x: 0.30, y: 0.07, w: 0.10, h: 0.04 },
  title:      { x: 0.19, y: 0.01, w: 0.32, h: 0.05 },
  breakdown:  { x: 0.10, y: 0.36, w: 0.22, h: 0.47 },
  combo:      { x: 0.34, y: 0.20, w: 0.32, h: 0.06 },
};

const REGION_DEFS = [
  { key: 'difficulty', label: '難易度',   color: '#007bff' },
  { key: 'level',      label: 'レベル',   color: '#6f42c1' },
  { key: 'title',      label: '曲名',     color: '#28a745' },
  { key: 'breakdown',  label: '判定内訳', color: '#e6a700' },
  { key: 'combo',      label: 'コンボ数', color: '#dc3545' },
];

const LS_KEY_DEVICE_PROFILES = 'prsk_device_profiles_v1';

const SORT_MODES = [
  { key: 'name',  label: '名前順' },
  { key: 'level', label: '楽曲レベル順' },
  { key: 'miss',  label: 'ミス数順' },
  { key: 'date',  label: '追加日順' },
];
const DEFAULT_SORT_MODE = 'level';
const DEFAULT_SORT_DIRECTIONS = { name: 'asc', level: 'desc', miss: 'asc', date: 'desc' };
