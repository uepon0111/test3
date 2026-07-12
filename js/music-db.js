/*
 * music-db.js
 * -----------------------------------------------------------------------
 * プロセカ非公式マスターDB(musics.json / musicDifficulties.json)の取得と、
 * OCRで読み取った曲名から最も近い楽曲を推定するファジーマッチング処理。
 *
 * 追加改善:
 *   - 曲名OCRが弱い場合でも、難易度・レベル・総ノーツ数を手掛かりに候補を再評価
 *   - DB側のレベル/総ノーツ数を使って、似たタイトル候補を総合スコアで選択
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

function getDbTitleScore(targetNorm, dbTitleNorm) {
  if (!targetNorm || !dbTitleNorm) return 1;
  const dist = levenshtein(targetNorm, dbTitleNorm);
  return dist / Math.max(targetNorm.length, dbTitleNorm.length, 1);
}

function findBestMatchMusicDetailed(ocrText) {
  if (!dbMusics || dbMusics.length === 0) return null;
  const target = normalizeString(ocrText);
  if (target.length === 0) return null;

  let bestMatch = null;
  let bestScore = Infinity;
  for (const music of dbMusics) {
    const dbTitleNorm = normalizeString(music.title);
    const score = getDbTitleScore(target, dbTitleNorm);
    if (score < bestScore) {
      bestScore = score;
      bestMatch = music;
    }
  }
  return bestMatch ? { music: bestMatch, score: bestScore, target } : null;
}

function findBestMatchMusic(ocrText) {
  const detailed = findBestMatchMusicDetailed(ocrText);
  return detailed ? detailed.music : null;
}

function getLevelFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  const entry = dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey);
  return entry ? entry.playLevel : null;
}

function getDbEntryForMusicDiff(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  return dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey) || null;
}

function getMusicTotalNotesFromDb(musicId, diffKey) {
  const entry = getDbEntryForMusicDiff(musicId, diffKey);
  if (!entry) return null;
  const candidates = [
    entry.totalNotes,
    entry.total_note_count,
    entry.noteCount,
    entry.notes,
    entry.musicTotalNotes,
    entry.playNoteCount,
    entry.noteCnt,
    entry.notesCount,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function scoreMusicCandidateWithContext(music, ctx) {
  const diffKey = ctx.diffCode ? getDiffDbKey(ctx.diffCode) : null;
  const titleNorm = normalizeString(music.title);
  const ocrNorm = normalizeString(ctx.ocrText);
  let score = 0;

  if (ocrNorm) {
    const textScore = getDbTitleScore(ocrNorm, titleNorm);
    // OCR 文字列があるときはタイトル一致を最優先。ただし低信頼なら他情報を強く使う。
    score += textScore * (ctx.ocrConfidence >= 70 ? 5.0 : 2.0);
  }

  if (diffKey && ctx.level !== null && ctx.level !== undefined && ctx.level !== '') {
    const dbLevel = getLevelFromDb(music.id, diffKey);
    if (dbLevel !== null && dbLevel !== undefined && dbLevel !== '') {
      const a = parseFloat(dbLevel);
      const b = parseFloat(ctx.level);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        score += Math.abs(a - b) / 12;
      } else if (String(dbLevel) !== String(ctx.level)) {
        score += 0.15;
      }
    } else {
      score += 0.25;
    }
  }

  if (diffKey && ctx.totalNotes && ctx.totalNotes > 0) {
    const noteCount = getMusicTotalNotesFromDb(music.id, diffKey);
    if (Number.isFinite(noteCount) && noteCount > 0) {
      score += Math.abs(noteCount - ctx.totalNotes) / Math.max(noteCount, ctx.totalNotes) * 3.5;
    } else {
      // 総ノーツ数が取れない場合は少しだけ不利にする
      score += 0.12;
    }
  }

  return score;
}

// 曲名OCRが弱いときの補完。
// ctx: { ocrText, ocrConfidence, diffCode, level, totalNotes }
function findBestMusicByContext(ctx) {
  if (!dbMusics || dbMusics.length === 0) return null;
  let best = null;
  let bestScore = Infinity;
  for (const music of dbMusics) {
    const score = scoreMusicCandidateWithContext(music, ctx || {});
    if (score < bestScore) {
      bestScore = score;
      best = music;
    }
  }
  return best ? { music: best, score: bestScore } : null;
}

// OCR結果が十分強い場合はタイトル一致を優先し、弱い場合は難易度/レベル/総ノーツ数で再評価する。
function resolveMusicFromAnalysis(ctx) {
  const detailed = findBestMatchMusicDetailed(ctx.ocrText || '');
  const titleScore = detailed ? detailed.score : Infinity;

  // OCRが強い場合は素直にタイトル一致を採用
  if (detailed && titleScore <= 0.34 && (ctx.ocrConfidence === undefined || ctx.ocrConfidence >= 40)) {
    return {
      music: detailed.music,
      mode: 'title-match',
      score: titleScore,
    };
  }

  const fallback = findBestMusicByContext(ctx);
  if (fallback) {
    return {
      music: fallback.music,
      mode: detailed ? 'context-fallback' : 'context-only',
      score: fallback.score,
      titleScore,
    };
  }

  return detailed ? {
    music: detailed.music,
    mode: 'title-only',
    score: titleScore,
  } : null;
}
