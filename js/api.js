/**
 * api.js — プロセカ楽曲データの取得とマッチング
 */
const MusicAPI = (() => {
  let _musics     = null;
  let _difficulties = null;

  async function fetchMusics() {
    if (_musics) return _musics;
    const r = await fetch(CONFIG.MUSICS_API);
    _musics = await r.json();
    return _musics;
  }

  async function fetchDifficulties() {
    if (_difficulties) return _difficulties;
    const r = await fetch(CONFIG.DIFFICULTIES_API);
    _difficulties = await r.json();
    return _difficulties;
  }

  async function getAll() {
    const [musics, diffs] = await Promise.all([fetchMusics(), fetchDifficulties()]);
    return { musics, diffs };
  }

  /** Levenshtein distance */
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = [];
    for (let i = 0; i <= m; i++) { dp[i] = [i]; }
    for (let j = 0; j <= n; j++) { dp[0][j] = j; }
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  }

  function normalize(s) {
    return (s || '').toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[　]/g, '')        // full-width space
      .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // full→half
      .trim();
  }

  /** Find best matching music by title string */
  async function findBestMatch(query) {
    const musics = await fetchMusics();
    const normQ = normalize(query);
    let best = null, bestScore = Infinity;

    for (const m of musics) {
      const s1 = levenshtein(normQ, normalize(m.title));
      const s2 = levenshtein(normQ, normalize(m.pronunciation || ''));
      const score = Math.min(s1, s2);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return { music: best, score: bestScore };
  }

  /** Get difficulty entries for a musicId */
  async function getDifficultyEntries(musicId) {
    const diffs = await fetchDifficulties();
    return diffs.filter(d => d.musicId === musicId);
  }

  /** Get one difficulty entry */
  async function getDifficultyEntry(musicId, musicDifficulty) {
    const diffs = await fetchDifficulties();
    return diffs.find(d => d.musicId === musicId &&
      d.musicDifficulty?.toUpperCase() === musicDifficulty?.toUpperCase()) || null;
  }

  /** Validate result: sum of notes should equal totalNoteCount */
  function validateNotes(perfect, great, good, bad, miss, totalNoteCount) {
    const sum = perfect + great + good + bad + miss;
    return sum === totalNoteCount;
  }

  return { fetchMusics, fetchDifficulties, getAll, findBestMatch,
           getDifficultyEntries, getDifficultyEntry, validateNotes };
})();
