/*
 * music-db.js
 * -----------------------------------------------------------------------
 * プロセカ非公式マスターDB(musics.json / musicDifficulties.json)の取得と、
 * OCRで読み取った曲名・難易度・レベル・総ノーツ数から楽曲を推定するための
 * 各種検索・マッチング処理。
 *
 * findBestMatchMusic は曲名テキストからの直接マッチ(第一候補)、
 * find CandidatesBy* 系は「曲名の自信度が低いときに、難易度・レベル・総ノーツ数から
 * 逆算して候補を絞り込む」ための補助関数群です(result-reconciler.js から利用)。
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

// 曲名同士の類似度を 0(完全一致)〜1(まったく異なる) で返す。
// 全角/半角・大小文字・空白/ハイフンの差異は normalizeString で吸収する。
function titleDistanceRatio(textA, textB) {
  const a = normalizeString(textA);
  const b = normalizeString(textB);
  if (!a || !b) return 1;
  return levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

// OCRで読み取った曲名テキストに最も近い楽曲をDB全体から探す。
// 戻り値は { music, distanceRatio, distanceAbs } (見つからない場合は null)。
// distanceRatio が小さいほど信頼できる一致。呼び出し側(result-reconciler.js)で
// TITLE_MATCH_CONFIDENT_MAX_NORM_DIST 等と比較して「自信あり/なし」を判定する。
function findBestMatchMusic(ocrText) {
  if (!dbMusics || dbMusics.length === 0) return null;
  const target = normalizeString(ocrText);
  if (target.length === 0) return null;
  let bestMatch = null, minScore = Infinity, minAbsDist = Infinity;
  for (const music of dbMusics) {
    const dbTitleNorm = normalizeString(music.title);
    const dist = levenshtein(target, dbTitleNorm);
    const score = dist / Math.max(target.length, dbTitleNorm.length, 1);
    if (score < minScore) { minScore = score; bestMatch = music; minAbsDist = dist; }
  }
  return bestMatch ? { music: bestMatch, distanceRatio: minScore, distanceAbs: minAbsDist } : null;
}

function getMusicById(musicId) {
  if (musicId === null || musicId === undefined || !dbMusics) return null;
  return dbMusics.find(m => m.id === musicId) || null;
}

function getLevelFromDb(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  const entry = dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey);
  return entry ? entry.playLevel : null;
}

function getDiffEntry(musicId, diffKey) {
  if (!musicId || !diffKey || !dbDiffs) return null;
  return dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey) || null;
}

function getDiffEntriesForMusic(musicId) {
  if (musicId === null || musicId === undefined || !dbDiffs) return [];
  return dbDiffs.filter(d => d.musicId === musicId);
}

// 難易度キー(easy/normal/hard/expert/master/append)と総ノーツ数から楽曲候補を逆算する。
// 「楽曲タイトルに自信がない場合は、読み取った楽曲難易度・総ノーツ数から条件に合う
// ものをリストアップする」という要件のコア部分。tolerance を指定すると、OCRの
// カウント誤差(数ノーツ程度の誤読)を許容して探索範囲を広げられる。
function findCandidatesByDifficultyAndNoteCount(diffKey, noteCount, tolerance) {
  if (!diffKey || !Number.isFinite(noteCount) || !dbDiffs) return [];
  const tol = tolerance || 0;
  return dbDiffs
    .filter(d => d.musicDifficulty === diffKey && Math.abs(d.totalNoteCount - noteCount) <= tol)
    .map(d => ({ music: getMusicById(d.musicId), diffEntry: d, noteCountDiff: Math.abs(d.totalNoteCount - noteCount) }))
    .filter(c => !!c.music);
}

// 難易度キーとレベルから楽曲候補を探す(総ノーツ数での絞り込みが空振りした場合の
// 補助的な手がかり。レベルだけでは同一難易度内で多数の楽曲が重複するため、
// 単独では確定材料にならず、他の候補リストとの共通項として使うのが基本)。
function findCandidatesByDifficultyAndLevel(diffKey, level) {
  if (!diffKey || !Number.isFinite(level) || !dbDiffs) return [];
  return dbDiffs
    .filter(d => d.musicDifficulty === diffKey && d.playLevel === level)
    .map(d => ({ music: getMusicById(d.musicId), diffEntry: d }))
    .filter(c => !!c.music);
}
