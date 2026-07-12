/*
 * music-db.js
 * -----------------------------------------------------------------------
 * プロセカ非公式マスターDB(musics.json / musicDifficulties.json)の取得と、
 * OCRで読み取った曲名から最も近い楽曲を推定するファジーマッチング処理。
 * 処理内容は元のindex.htmlから変更していません。
 * -----------------------------------------------------------------------
 */

async function loadMusicDb() {
  try {
    const [musicsResp, diffsResp] = await Promise.all([
      fetch(MUSICS_URL),
      fetch(MUSIC_DIFFICULTIES_URL)
    ]);
    dbMusics = await musicsResp.json();
    dbDiffs = await diffsResp.json();
  } catch (e) {
    console.error("DB Error", e);
  }
}

function getMusicDifficultyEntry(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs || dbDiffs.length === 0) return null;
  return dbDiffs.find(d => String(d.musicId) === String(musicId) && String(d.musicDifficulty) === String(diffKey)) || null;
}

function extractNoteCountFromDifficultyEntry(entry) {
  if (!entry) return null;
  const keys = [
    'totalNotes', 'totalNoteCount', 'noteCount', 'notes', 'notesCount', 'total_note_count',
    'note_count', 'totalnotes', 'totalnote', 'totalNotesCount', 'noteTotal'
  ];
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      const n = toInt(entry[key], null);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function getMusicDifficultyMeta(musicId, diffKey) {
  const entry = getMusicDifficultyEntry(musicId, diffKey);
  if (!entry) return null;
  return {
    playLevel: entry.playLevel !== undefined ? String(entry.playLevel) : '',
    noteCount: extractNoteCountFromDifficultyEntry(entry),
    entry,
  };
}

function scoreMusicCandidate(music, opts) {
  const titleNorm = normalizeString(music.title || '');
  const ocrNorm = normalizeString(opts.ocrTitle || '');
  const diffKey = opts.diffKey || null;
  const levelText = (opts.levelText || '').toString().trim();
  const levelNum = levelText ? parseInt(levelText, 10) : null;
  const totalNotes = Number.isFinite(opts.totalNotes) ? opts.totalNotes : null;
  const meta = diffKey ? getMusicDifficultyMeta(music.id, diffKey) : null;

  let titleScore = 1;
  if (ocrNorm) {
    const dist = levenshtein(ocrNorm, titleNorm);
    titleScore = dist / Math.max(ocrNorm.length, titleNorm.length);
  }

  let score = titleScore * 100;
  const reasons = [];

  if (ocrNorm && titleNorm.includes(ocrNorm) && ocrNorm.length >= 2) {
    score -= 12;
    reasons.push('title包含一致');
  }
  if (levelNum !== null && meta && meta.playLevel !== '') {
    const metaLevel = parseInt(meta.playLevel, 10);
    if (Number.isFinite(metaLevel)) {
      const diff = Math.abs(levelNum - metaLevel);
      score += diff * 8;
      if (diff === 0) reasons.push('レベル一致');
      else reasons.push(`レベル差${diff}`);
    }
  }
  if (totalNotes !== null && meta && Number.isFinite(meta.noteCount)) {
    const diff = Math.abs(totalNotes - meta.noteCount);
    score += diff === 0 ? -18 : Math.min(24, diff * 0.35);
    if (diff === 0) reasons.push('ノーツ一致');
    else reasons.push(`ノーツ差${diff}`);
  }
  if (opts.titleConfidence !== undefined && opts.titleConfidence !== null) {
    if (opts.titleConfidence >= 90) score -= 10;
    else if (opts.titleConfidence < 55) score += 10;
  }

  return {
    music,
    score,
    titleScore,
    playLevel: meta ? meta.playLevel : '',
    noteCount: meta ? meta.noteCount : null,
    reasons,
  };
}

function rankMusicCandidates(opts) {
  if (!dbMusics || dbMusics.length === 0) return [];
  const diffKey = opts && opts.diffCode ? getDiffDbKey(opts.diffCode) : null;
  const list = dbMusics.map(m => scoreMusicCandidate(m, {
    ocrTitle: opts ? opts.ocrTitle : '',
    diffKey,
    levelText: opts ? opts.levelText : '',
    totalNotes: opts ? opts.totalNotes : null,
    titleConfidence: opts ? opts.titleConfidence : null,
  }));

  const exactNoteMatches = (opts && Number.isFinite(opts.totalNotes))
    ? list.filter(c => Number.isFinite(c.noteCount) && c.noteCount === opts.totalNotes)
    : [];
  const exactLevelMatches = (opts && (opts.levelText || '').toString().trim())
    ? list.filter(c => c.playLevel !== '' && String(c.playLevel) === String(opts.levelText).trim())
    : [];

  let pool = list;
  if (exactNoteMatches.length > 0) pool = exactNoteMatches;
  else if (exactLevelMatches.length > 0) pool = exactLevelMatches;

  pool.sort((a, b) => a.score - b.score || a.titleScore - b.titleScore);
  return pool.slice(0, opts && opts.limit ? opts.limit : 8);
}

function findBestMatchMusic(ocrText, opts) {
  if (!dbMusics || dbMusics.length === 0) return null;
  const target = normalizeString(ocrText);
  if (target.length === 0 && !opts) return null;
  if (opts) {
    const ranked = rankMusicCandidates({
      ocrTitle: ocrText,
      diffCode: opts.diffCode,
      levelText: opts.levelText,
      totalNotes: opts.totalNotes,
      titleConfidence: opts.titleConfidence,
      limit: 1,
    });
    if (ranked.length > 0) return ranked[0].music;
  }
  let bestMatch = null, minScore = Infinity;
  for (const music of dbMusics) {
    const dbTitleNorm = normalizeString(music.title);
    const dist = levenshtein(target, dbTitleNorm);
    const score = dist / Math.max(target.length, dbTitleNorm.length);
    if (score < minScore) { minScore = score; bestMatch = music; }
  }
  return bestMatch;
}
function getLevelFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  const entry = dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey);
  return entry ? entry.playLevel : null;
}
