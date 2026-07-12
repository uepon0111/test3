/*
 * music-db.js
 * -----------------------------------------------------------------------
 * プロセカ非公式マスターDB(musics.json / musicDifficulties.json)の取得と、
 * OCRで読み取った曲名から最も近い楽曲を推定するファジーマッチング処理。
 * さらに、曲名が曖昧な場合でも難易度・レベル・総ノーツ数を組み合わせて
 * 候補を総合評価できるようにしています。
 * -----------------------------------------------------------------------
 */

function getMusicDifficultyEntriesForMusicId(musicId) {
  if (!dbDiffs || !musicId) return [];
  return dbDiffs.filter(d => String(d.musicId) === String(musicId));
}

function getDifficultyEntryLevel(entry) {
  if (!entry) return null;
  const candidates = [
    entry.playLevel,
    entry.level,
    entry.difficultyLevel,
    entry.musicLevel,
    entry.playlevel,
  ];
  for (const v of candidates) {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getDifficultyEntryNoteCount(entry) {
  if (!entry) return null;
  const priorityKeys = Object.keys(entry).filter(k => /note|count|total/i.test(k));
  const ignored = new Set(['musicId', 'musicDifficulty', 'playLevel', 'level', 'difficultyLevel', 'musicLevel', 'id', 'createdAt', 'updatedAt']);
  const candidates = [];

  for (const key of priorityKeys) {
    if (ignored.has(key)) continue;
    const value = entry[key];
    const n = Number(value);
    if (Number.isFinite(n)) candidates.push({ key, n });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const aScore = /note/i.test(a.key) ? 0 : 1;
      const bScore = /note/i.test(b.key) ? 0 : 1;
      return aScore - bScore;
    });
    return candidates[0].n;
  }

  // フォールバック: 数値っぽい値を広く拾う。ただし ID 系やレベル系は避ける。
  for (const [key, value] of Object.entries(entry)) {
    if (ignored.has(key)) continue;
    if (/id$/i.test(key)) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getNoteCountFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs || dbDiffs.length === 0) return null;
  const entry = dbDiffs.find(d => String(d.musicId) === String(musicId) && String(d.musicDifficulty) === String(diffKey));
  return getDifficultyEntryNoteCount(entry);
}

function getDiffEntryForMusicId(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  return dbDiffs.find(d => String(d.musicId) === String(musicId) && String(d.musicDifficulty) === String(diffKey)) || null;
}

let musicDbLoadPromise = null;

async function loadMusicDb() {
  if (dbMusics && dbMusics.length > 0 && dbDiffs && dbDiffs.length > 0) return { dbMusics, dbDiffs };
  if (musicDbLoadPromise) return musicDbLoadPromise;
  musicDbLoadPromise = (async () => {
    try {
      const [musicsResp, diffsResp] = await Promise.all([
        fetch(MUSICS_URL),
        fetch(MUSIC_DIFFICULTIES_URL)
      ]);
      dbMusics = await musicsResp.json();
      dbDiffs = await diffsResp.json();
      return { dbMusics, dbDiffs };
    } catch (e) {
      console.error("DB Error", e);
      return { dbMusics, dbDiffs };
    } finally {
      musicDbLoadPromise = null;
    }
  })();
  return musicDbLoadPromise;
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

function scoreMusicCandidate(music, context) {
  const c = context || {};
  const target = normalizeString(c.ocrText || '');
  const dbTitleNorm = normalizeString(music.title || '');
  const titleDist = target
    ? levenshtein(target, dbTitleNorm) / Math.max(target.length, dbTitleNorm.length || 1)
    : 1;

  const titleConfidence = Number.isFinite(c.titleConfidence) ? c.titleConfidence : 0;
  const titleWeight = titleConfidence >= 80 ? 0.22 : titleConfidence >= 60 ? 0.32 : titleConfidence >= 35 ? 0.46 : 0.58;
  const contextWeight = 1 - titleWeight;

  let bestDiffPenalty = 0.9;
  let bestDiffKey = c.diffKey || null;
  let bestDiffLabel = null;
  let bestLevel = null;
  let bestNoteCount = null;

  const entries = getMusicDifficultyEntriesForMusicId(music.id);
  if (entries.length > 0) {
    let bestEntryScore = Infinity;
    for (const entry of entries) {
      const entryDiffKey = String(entry.musicDifficulty || '');
      const entryLevel = getDifficultyEntryLevel(entry);
      const entryNoteCount = getDifficultyEntryNoteCount(entry);

      let penalty = 0;
      if (c.diffKey && entryDiffKey) {
        penalty += entryDiffKey === c.diffKey ? 0 : 0.25;
      }
      if (Number.isFinite(c.level) && Number.isFinite(entryLevel)) {
        penalty += Math.abs(entryLevel - c.level) / 100;
      }
      if (Number.isFinite(c.totalNotes) && Number.isFinite(entryNoteCount)) {
        penalty += Math.abs(entryNoteCount - c.totalNotes) / Math.max(entryNoteCount, c.totalNotes, 1);
      }

      if (penalty < bestEntryScore) {
        bestEntryScore = penalty;
        bestDiffPenalty = penalty;
        bestDiffKey = entryDiffKey || bestDiffKey;
        bestLevel = Number.isFinite(entryLevel) ? entryLevel : bestLevel;
        bestNoteCount = Number.isFinite(entryNoteCount) ? entryNoteCount : bestNoteCount;
      }
    }
  }

  const score = (titleDist * titleWeight) + (bestDiffPenalty * contextWeight);
  return {
    music,
    score,
    titleDist,
    titleWeight,
    contextWeight,
    diffKey: bestDiffKey,
    level: bestLevel,
    noteCount: bestNoteCount,
  };
}

function inferMusicByContext(ocrText, context) {
  if (!dbMusics || dbMusics.length === 0) {
    return {
      music: null,
      score: 1,
      candidates: [],
      diffKey: null,
      level: null,
      noteCount: null,
    };
  }

  const ctx = context || {};
  const level = Number.isFinite(ctx.level) ? ctx.level : parseFloat(ctx.level);
  const totalNotes = Number.isFinite(ctx.totalNotes) ? ctx.totalNotes : parseFloat(ctx.totalNotes);
  const scored = dbMusics.map(m => scoreMusicCandidate(m, {
    ocrText,
    titleConfidence: ctx.titleConfidence || 0,
    diffKey: ctx.diffKey || null,
    level: Number.isFinite(level) ? level : null,
    totalNotes: Number.isFinite(totalNotes) ? totalNotes : null,
  }));

  scored.sort((a, b) => a.score - b.score);
  const top = scored.slice(0, 5);
  const best = top[0] || null;
  return {
    music: best ? best.music : null,
    score: best ? best.score : 1,
    candidates: top,
    diffKey: best ? best.diffKey : null,
    level: best ? best.level : null,
    noteCount: best ? best.noteCount : null,
  };
}

function getLevelFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  const entry = getDiffEntryForMusicId(musicId, diffKey);
  return entry ? getDifficultyEntryLevel(entry) : null;
}
