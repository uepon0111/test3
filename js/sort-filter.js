/**
 * sort-filter.js — 並び替え・絞り込みロジック
 */
const SortFilter = (() => {

  /** Compute miss counts and achievement flags */
  function computeMiss(entry) {
    const { perfect=0, great=0, good=0, bad=0, miss=0 } = entry;
    return {
      missAP:           great + good + bad + miss,
      missAPTournament: great * 1 + good * 2 + bad * 3 + miss * 3,
      missFC:           good  + bad + miss,
      isAP:             (great + good + bad + miss) === 0
                        && (great*1 + good*2 + bad*3 + miss*3) === 0,
      isFC:             (good + bad + miss) === 0,
    };
  }

  /** Get miss value for current mode */
  function getMissForMode(entry, mode) {
    const { missAP, missAPTournament, missFC } = computeMiss(entry);
    switch (mode) {
      case 'ap':            return missAP;
      case 'ap-tournament': return missAPTournament;
      case 'fc':            return missFC;
      default:              return missAP;
    }
  }

  /** Get miss priority tuple for current mode (requirement 2.15) */
  function getMissPriority(entry, mode) {
    const { missAP, missAPTournament, missFC } = computeMiss(entry);
    const negPerfect = -(entry.perfect || 0);
    const negCombo   = -(entry.combo   || 0);
    switch (mode) {
      case 'ap':
        return [missAP, missAPTournament, negPerfect, negCombo];
      case 'ap-tournament':
        return [missAPTournament, negPerfect, negCombo];
      case 'fc':
        return [missFC, missAPTournament, negPerfect, negCombo];
      default:
        return [missAP, missAPTournament, negPerfect, negCombo];
    }
  }

  const DIFF_ORDER = CONFIG.DIFFICULTY_ORDER;

  function diffOrder(d) { return DIFF_ORDER.indexOf(d?.toUpperCase()); }

  /** Sort results according to sort type (req 2.14) */
  function sortResults(results, sortType, sortAsc, mode) {
    const sign = sortAsc ? 1 : -1;

    return [...results].sort((a, b) => {
      let cmp = 0;

      function compareArr(arrA, arrB) {
        for (let i = 0; i < Math.max(arrA.length, arrB.length); i++) {
          const va = arrA[i] ?? 0, vb = arrB[i] ?? 0;
          if (va !== vb) return va - vb;
        }
        return 0;
      }

      switch (sortType) {
        case 'name':
          // 名前順 → 難易度順 → ミス数順 → 追加日順
          cmp = (a.title || '').localeCompare(b.title || '', 'ja');
          if (!cmp) cmp = diffOrder(a.difficulty) - diffOrder(b.difficulty);
          if (!cmp) cmp = compareArr(getMissPriority(a, mode), getMissPriority(b, mode));
          if (!cmp) cmp = new Date(a.addedAt) - new Date(b.addedAt);
          break;

        case 'level':
          // レベル順 → 難易度順 → 名前順 → ミス数順 → 追加日順
          cmp = (a.level || 0) - (b.level || 0);
          if (!cmp) cmp = diffOrder(a.difficulty) - diffOrder(b.difficulty);
          if (!cmp) cmp = (a.title || '').localeCompare(b.title || '', 'ja');
          if (!cmp) cmp = compareArr(getMissPriority(a, mode), getMissPriority(b, mode));
          if (!cmp) cmp = new Date(a.addedAt) - new Date(b.addedAt);
          break;

        case 'miss':
          // ミス数順 → レベル順 → 難易度順 → 名前順 → 追加日順
          cmp = compareArr(getMissPriority(a, mode), getMissPriority(b, mode));
          if (!cmp) cmp = (a.level || 0) - (b.level || 0);
          if (!cmp) cmp = diffOrder(a.difficulty) - diffOrder(b.difficulty);
          if (!cmp) cmp = (a.title || '').localeCompare(b.title || '', 'ja');
          if (!cmp) cmp = new Date(a.addedAt) - new Date(b.addedAt);
          break;

        case 'date':
          // 追加日順
          cmp = new Date(a.addedAt) - new Date(b.addedAt);
          break;
      }

      return cmp * sign;
    });
  }

  /** Filter results based on current filter state */
  function filterResults(results, filters, mode, displayMode) {
    let out = results;

    // Search by title or pronunciation
    if (filters.search) {
      const q = filters.search.toLowerCase().replace(/\s/g,'');
      out = out.filter(r =>
        (r.title       || '').toLowerCase().replace(/\s/g,'').includes(q) ||
        (r.pronunciation || '').toLowerCase().replace(/\s/g,'').includes(q)
      );
    }

    // Difficulty filter
    if (filters.difficulties && filters.difficulties.length > 0) {
      out = out.filter(r => filters.difficulties.includes(r.difficulty?.toUpperCase()));
    }

    // Level filter
    if (filters.level !== null && filters.level !== undefined && filters.level !== '') {
      out = out.filter(r => r.level === parseInt(filters.level));
    }

    // AP / FC achieved filter
    if (filters.achievedAP) {
      out = out.filter(r => computeMiss(r).isAP);
    }
    if (filters.achievedFC) {
      out = out.filter(r => computeMiss(r).isFC);
    }

    // Miss range filter
    if (filters.missMin !== null && filters.missMin !== '') {
      out = out.filter(r => getMissForMode(r, mode) >= parseInt(filters.missMin));
    }
    if (filters.missMax !== null && filters.missMax !== '') {
      out = out.filter(r => getMissForMode(r, mode) <= parseInt(filters.missMax));
    }

    // Display mode: best only
    if (displayMode === 'best') {
      out = getBestResults(out, mode);
    }

    return out;
  }

  /**
   * For "best only" mode:
   * Group by (musicId, difficulty), keep the one with lowest miss for the current mode.
   */
  function getBestResults(results, mode) {
    const map = new Map();
    for (const r of results) {
      const key = `${r.musicId}_${r.difficulty}`;
      const miss = getMissForMode(r, mode);
      if (!map.has(key) || miss < getMissForMode(map.get(key), mode)) {
        map.set(key, r);
      }
    }
    return Array.from(map.values());
  }

  return { computeMiss, getMissForMode, getMissPriority, sortResults, filterResults, getBestResults };
})();
