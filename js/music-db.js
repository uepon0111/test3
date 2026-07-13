/*
 * music-db.js
 * -----------------------------------------------------------------------
 * プロセカ非公式マスターDB(musics.json / musicDifficulties.json)の取得と、
 * OCRで読み取った曲名・難易度・レベル・ノーツ数から最も近い楽曲を推定する処理。
 * -----------------------------------------------------------------------
 */

let musicDbLoadPromise = null;
let dbMusicsById = new Map();
let dbDiffsByMusicId = new Map();

function rebuildMusicDbIndexes() {
  dbMusicsById = new Map();
  dbDiffsByMusicId = new Map();

  for (const music of dbMusics || []) {
    if (music && music.id !== undefined && music.id !== null) {
      dbMusicsById.set(music.id, music);
    }
  }

  for (const diff of dbDiffs || []) {
    if (!diff || diff.musicId === undefined || diff.musicId === null) continue;
    if (!dbDiffsByMusicId.has(diff.musicId)) dbDiffsByMusicId.set(diff.musicId, []);
    dbDiffsByMusicId.get(diff.musicId).push(diff);
  }

  for (const rows of dbDiffsByMusicId.values()) {
    rows.sort((a, b) => getDiffRankByDbKey(a.musicDifficulty) - getDiffRankByDbKey(b.musicDifficulty));
  }
}

function getDiffRankByDbKey(dbKey) {
  const item = DIFFICULTIES.find(d => d.dbKey === dbKey);
  return item ? item.rank : 0;
}

async function loadMusicDb() {
  if (musicDbLoadPromise) return musicDbLoadPromise;
  musicDbLoadPromise = (async () => {
    try {
      const [musicsResp, diffsResp] = await Promise.all([
        fetch(MUSICS_URL),
        fetch(MUSIC_DIFFICULTIES_URL)
      ]);
      dbMusics = await musicsResp.json();
      dbDiffs = await diffsResp.json();
      rebuildMusicDbIndexes();
      return { musics: dbMusics, diffs: dbDiffs };
    } catch (e) {
      console.error('DB Error', e);
      dbMusics = Array.isArray(dbMusics) ? dbMusics : [];
      dbDiffs = Array.isArray(dbDiffs) ? dbDiffs : [];
      rebuildMusicDbIndexes();
      return { musics: dbMusics, diffs: dbDiffs, error: e };
    }
  })();
  return musicDbLoadPromise;
}

function ensureMusicDbLoaded() {
  return loadMusicDb();
}

function getMusicById(musicId) {
  return dbMusicsById.get(musicId) || null;
}

function getDifficultyEntriesForMusic(musicId) {
  return dbDiffsByMusicId.get(musicId) ? dbDiffsByMusicId.get(musicId).slice() : [];
}

function getMusicDifficultyEntry(musicId, diffKey) {
  const rows = dbDiffsByMusicId.get(musicId);
  if (!rows || rows.length === 0) return null;
  return rows.find(d => d.musicDifficulty === diffKey) || null;
}

function getLevelFromDb(musicId, diffKey) {
  const entry = getMusicDifficultyEntry(musicId, diffKey);
  return entry ? entry.playLevel : null;
}

function getTotalNoteCountFromDb(musicId, diffKey) {
  const entry = getMusicDifficultyEntry(musicId, diffKey);
  return entry ? entry.totalNoteCount : null;
}

function buildMusicCandidate(music, diffEntry) {
  if (!music || !diffEntry) return null;
  return {
    musicId: music.id,
    title: music.title,
    pronunciation: music.pronunciation || '',
    diffKey: diffEntry.musicDifficulty,
    playLevel: diffEntry.playLevel,
    totalNoteCount: diffEntry.totalNoteCount,
  };
}

function chooseBestDifficultyEntry(entries, targetLevel, targetNotes) {
  if (!entries || entries.length === 0) return null;
  let best = entries[0];
  let bestScore = Infinity;
  for (const entry of entries) {
    const levelScore = Number.isFinite(targetLevel) ? Math.abs((entry.playLevel ?? 0) - targetLevel) : 0.5;
    const noteScore = Number.isFinite(targetNotes) && targetNotes > 0
      ? Math.abs((entry.totalNoteCount ?? 0) - targetNotes) / Math.max(targetNotes, entry.totalNoteCount || 1)
      : 0.5;
    const score = noteScore * 0.7 + levelScore * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best;
}

function normalizedLevenshteinScore(a, b) {
  const aa = normalizeString(a || '');
  const bb = normalizeString(b || '');
  if (!aa && !bb) return 0;
  if (!aa || !bb) return 1;
  return levenshtein(aa, bb) / Math.max(aa.length, bb.length, 1);
}

function inferMusicFromEvidence({
  titleText = '',
  titleConfidence = 0,
  diffKey = null,
  level = null,
  totalNotes = null,
} = {}) {
  if (!dbMusics || dbMusics.length === 0 || !dbDiffs || dbDiffs.length === 0) {
    return null;
  }

  const targetLevel = Number.isFinite(level) ? level : parseFloat(level);
  const targetNotes = Number.isFinite(totalNotes) ? totalNotes : parseInt(totalNotes, 10);
  const hasExactDifficulty = !!diffKey && DIFFICULTIES.some(d => d.dbKey === diffKey);
  const titleNorm = normalizeString(titleText);
  const titleWeight = titleConfidence >= 80 ? 0.60 : titleConfidence >= 60 ? 0.40 : titleConfidence >= 40 ? 0.22 : 0.08;

  const candidates = [];
  for (const music of dbMusics) {
    const entries = getDifficultyEntriesForMusic(music.id);
    if (!entries.length) continue;

    let usableEntries = entries;
    if (hasExactDifficulty) {
      const exact = entries.filter(e => e.musicDifficulty === diffKey);
      if (exact.length > 0) usableEntries = exact;
    }

    const chosenEntry = chooseBestDifficultyEntry(usableEntries, targetLevel, targetNotes);
    if (!chosenEntry) continue;

    const titleScore = titleNorm ? normalizedLevenshteinScore(titleText, music.title) : 1;
    const levelScore = Number.isFinite(targetLevel) ? Math.abs((chosenEntry.playLevel ?? 0) - targetLevel) / Math.max(chosenEntry.playLevel ?? 1, targetLevel, 1) : 0.5;
    const noteScore = Number.isFinite(targetNotes) && targetNotes > 0
      ? Math.abs((chosenEntry.totalNoteCount ?? 0) - targetNotes) / Math.max(chosenEntry.totalNoteCount ?? 1, targetNotes, 1)
      : 0.5;
    const exactDifficultyBonus = hasExactDifficulty && chosenEntry.musicDifficulty === diffKey ? 0 : 0.25;

    const score = titleScore * titleWeight + levelScore * 0.25 + noteScore * 0.45 + exactDifficultyBonus;
    candidates.push({
      ...buildMusicCandidate(music, chosenEntry),
      score,
      titleScore,
      levelScore,
      noteScore,
      exactDifficulty: chosenEntry.musicDifficulty === diffKey,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return {
    ...best,
    candidates: candidates.slice(0, 8),
  };
}

function findBestMatchMusic(ocrText) {
  if (!dbMusics || dbMusics.length === 0) return null;
  const target = normalizeString(ocrText);
  if (target.length === 0) return null;
  let bestMatch = null, minScore = Infinity;
  for (const music of dbMusics) {
    const dbTitleNorm = normalizeString(music.title);
    const dist = levenshtein(target, dbTitleNorm);
    const score = dist / Math.max(target.length, dbTitleNorm.length);
    if (score < minScore) { minScore = score; bestMatch = music; }
  }
  return bestMatch;
}
