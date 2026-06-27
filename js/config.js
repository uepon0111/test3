/**
 * config.js — アプリ全体の定数・設定
 */
const CONFIG = {
  APP_NAME: 'プロセカ リザルト',
  DB_NAME: 'SekaiResultsDB',
  DB_VERSION: 1,

  DIFFICULTIES: {
    EASY:   { name: 'EASY',   color: '#66DA7E', order: 0 },
    NORMAL: { name: 'NORMAL', color: '#66C9F9', order: 1 },
    HARD:   { name: 'HARD',   color: '#F5CC44', order: 2 },
    EXPERT: { name: 'EXPERT', color: '#EA5577', order: 3 },
    MASTER: { name: 'MASTER', color: '#BB40F5', order: 4 },
    APPEND: { name: 'APPEND', color: '#EE82E2', order: 5 },
  },

  DIFFICULTY_ORDER: ['EASY','NORMAL','HARD','EXPERT','MASTER','APPEND'],

  MODES: { AP: 'ap', AP_TOURNAMENT: 'ap-tournament', FC: 'fc' },

  SORT_TYPES: { NAME: 'name', LEVEL: 'level', MISS: 'miss', DATE: 'date' },

  TRASH_DAYS: 3,

  MUSICS_API:      'https://sekai-world.github.io/sekai-master-db-diff/musics.json',
  DIFFICULTIES_API:'https://sekai-world.github.io/sekai-master-db-diff/musicDifficulties.json',

  GOOGLE_SCOPES:    'https://www.googleapis.com/auth/drive.file email profile openid',
  GOOGLE_DRIVE_API: 'https://www.googleapis.com/drive/v3',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_USERINFO:  'https://www.googleapis.com/oauth2/v3/userinfo',
  GOOGLE_AUTH_URL:  'https://accounts.google.com/o/oauth2/v2/auth',

  DRIVE_FOLDER_NAME: 'ProsekaResults',

  // Default OCR regions (as % of image dimensions) for standard game screenshots
  DEFAULT_REGIONS: {
    title:      { x: 0.14, y: 0.015, w: 0.36, h: 0.085 },
    difficulty: { x: 0.14, y: 0.065, w: 0.14,  h: 0.065 },
    level:      { x: 0.275, y: 0.065, w: 0.19, h: 0.065 },
    result:     { x: 0.09,  y: 0.45,  w: 0.29, h: 0.38  },
    combo:      { x: 0.35,  y: 0.45,  w: 0.25, h: 0.12  },
  },

  REGION_COLORS: {
    title:      '#ef4444',
    difficulty: '#22c55e',
    level:      '#3b82f6',
    result:     '#f97316',
    combo:      '#a855f7',
  },
};
