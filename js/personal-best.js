/*
 * personal-best.js
 * -----------------------------------------------------------------------
 * 「自己ベスト」の判定に関する処理。
 * 同一楽曲・同一難易度のレコードをグループ化し、その中で最も良い記録を求めます。
 * 「良い記録」の基準: ミス数(good+bad+miss)が少ない方が良い。同数ならコンボ数が
 * 多い方、それも同じなら追加日が新しい方を優先します。
 *
 * grid-view.js (自己ベストのみ表示フィルタ) と upload-editor.js (アップロード後の
 * 自己ベスト更新通知) の両方から利用します。
 * -----------------------------------------------------------------------
 */

function getBestGroupKey(rec) {
  const idPart = (rec.musicId !== null && rec.musicId !== undefined && rec.musicId !== '')
    ? ('id:' + rec.musicId)
    : ('t:' + normalizeString(rec.title));
  return idPart + '|' + rec.difficultyRaw;
}

function isBetterRecord(a, b) {
  if (a.missCount !== b.missCount) return a.missCount < b.missCount;
  if (a.combo !== b.combo) return a.combo > b.combo;
  return new Date(a.createdTime || 0) > new Date(b.createdTime || 0);
}

// レコード配列から「グループキー -> そのグループ内の最良レコード」の Map を作る
function computeBestRecords(records) {
  const map = new Map();
  for (const rec of records) {
    const key = getBestGroupKey(rec);
    const cur = map.get(key);
    if (!cur || isBetterRecord(rec, cur)) map.set(key, rec);
  }
  return map;
}

// アップロード/編集直前の記録一覧(previousRecords)と、今回新たに追加・更新されたレコード
// (newlyAddedRecords, record風オブジェクトの配列)を比較し、自己ベストを更新した項目を返す。
// 「初めてプレイした曲」は比較対象がないため自己ベスト更新としては扱わない。
function detectNewBests(previousRecords, newlyAddedRecords) {
  const prevBestMap = computeBestRecords(previousRecords);
  const achievements = [];
  for (const rec of newlyAddedRecords) {
    const key = getBestGroupKey(rec);
    const prevBest = prevBestMap.get(key);
    if (prevBest && isBetterRecord(rec, prevBest)) {
      achievements.push({ record: rec, previous: prevBest });
    }
  }
  return achievements;
}
