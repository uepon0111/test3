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

function getLevelFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  const entry = dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey);
  return entry ? entry.playLevel : null;
}


function getMusicDifficultyEntriesFor(diffKey) {
  if (!dbDiffs || !diffKey) return [];
  return dbDiffs.filter(d => d.musicDifficulty === diffKey);
}

function getMusicDifficultyEntry(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  return dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey) || null;
}

function getNoteCountFromDifficultyEntry(entry) {
  if (!entry) return null;
  const candidates = [
    entry.totalNoteCount,
    entry.totalNotes,
    entry.noteCount,
    entry.notes,
    entry.total_note_count,
    entry.total_note,
  ];
  for (const value of candidates) {
    const n = toInt(value, null);
    if (Number.isFinite(n) && n !== null) return n;
  }
  return null;
}

function scoreTitleAgainstMusicTitle(ocrText, musicTitle) {
  const a = normalizeString(ocrText);
  const b = normalizeString(musicTitle);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - (dist / Math.max(a.length, b.length));
}

function collectMusicCandidatesByContext(diffKey, totalNotes) {
  const entries = getMusicDifficultyEntriesFor(diffKey);
  const byMusic = new Map();
  for (const entry of entries) {
    const noteCount = getNoteCountFromDifficultyEntry(entry);
    const cur = byMusic.get(entry.musicId);
    if (!cur) {
      byMusic.set(entry.musicId, {
        musicId: entry.musicId,
        noteCount,
        diffEntry: entry,
      });
    } else if (cur.noteCount === null && noteCount !== null) {
      cur.noteCount = noteCount;
      cur.diffEntry = entry;
    }
  }

  const items = [];
  for (const [musicId, meta] of byMusic.entries()) {
    const music = dbMusics.find(m => m.id === musicId);
    if (!music) continue;
    const level = getLevelFromDb(musicId, diffKey);
    let noteDelta = null;
    if (totalNotes !== null && totalNotes !== undefined && meta.noteCount !== null && meta.noteCount !== undefined) {
      noteDelta = Math.abs(meta.noteCount - totalNotes);
    }
    items.push({
      music,
      musicId,
      level,
      noteCount: meta.noteCount,
      noteDelta,
      titleScore: 0,
      score: 0,
    });
  }
  return items;
}

function findBestMatchMusicByContext(options) {
  const opts = options || {};
  const ocrText = opts.ocrText || '';
  const diffKey = opts.diffKey || null;
  const totalNotes = (opts.totalNotes !== undefined && opts.totalNotes !== null) ? toInt(opts.totalNotes, null) : null;
  const levelHint = opts.levelHint !== undefined && opts.levelHint !== null && opts.levelHint !== '' ? String(opts.levelHint) : '';
  const normalizedTitle = normalizeString(ocrText);

  const allCandidates = [];
  if (diffKey) {
    const contextCandidates = collectMusicCandidatesByContext(diffKey, totalNotes);
    for (const cand of contextCandidates) {
      cand.titleScore = scoreTitleAgainstMusicTitle(ocrText, cand.music.title);
      let score = 0;

      // OCR文字列の近さを最優先
      score += (1 - cand.titleScore) * 2.5;

      // 総ノーツ数が分かる場合は強く効かせる
      if (cand.noteDelta !== null) score += Math.min(cand.noteDelta / 100, 2.0);

      // レベルのヒントがある場合は補助的に使う
      if (levelHint && cand.level) {
        const lvA = parseFloat(levelHint);
        const lvB = parseFloat(cand.level);
        if (Number.isFinite(lvA) && Number.isFinite(lvB)) {
          score += Math.min(Math.abs(lvA - lvB) / 10, 1.0);
        }
      }

      cand.score = score;
      allCandidates.push(cand);
    }
  }

  if (allCandidates.length > 0) {
    allCandidates.sort((a, b) => a.score - b.score || (b.titleScore - a.titleScore));
    const best = allCandidates[0];
    return {
      music: best.music,
      score: best.score,
      titleScore: best.titleScore,
      noteDelta: best.noteDelta,
      candidates: allCandidates.slice(0, 10),
      reason: 'context',
    };
  }

  const fallback = findBestMatchMusic(ocrText);
  if (!fallback) return null;
  return {
    music: fallback,
    score: 0,
    titleScore: scoreTitleAgainstMusicTitle(ocrText, fallback.title),
    noteDelta: null,
    candidates: [{ music: fallback, score: 0 }],
    reason: 'fallback',
  };
}
