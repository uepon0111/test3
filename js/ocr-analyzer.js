/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取る範囲(座標)は「機種プロファイル」(device-profiles.js)から与えられ、
 * 設定ページで自由に調整できます。
 *
 * 改善ポイント:
 *   - 単純に大きな領域を読むだけでなく、UIの位置関係を使って読み分ける
 *   - 判定内訳は各行を個別に読む(ラベルの誤認識に引きずられにくい)
 *   - コンボ数は数値部分を優先して読む
 *   - 同じ項目に複数の切り出しを試し、もっとも自然な結果を採用する
 * -----------------------------------------------------------------------
 */

// 画像の指定範囲(比率 x,y,w,h ∈ [0,1])を切り出してCanvas化する。
// 余白を少し広げたり、OCR用に拡大することもできる。
async function cropImage(imageElement, xRatio, yRatio, wRatio, hRatio, type = 'filter-standard', opt = {}) {
  const canvas = document.createElement('canvas');
  const srcW = imageElement.naturalWidth;
  const srcH = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');

  const padX = opt.padX || 0;
  const padY = opt.padY || 0;
  const scale = opt.scale || 1;

  const sx = clamp(xRatio - padX, 0, 1);
  const sy = clamp(yRatio - padY, 0, 1);
  const ex = clamp(xRatio + wRatio + padX, 0, 1);
  const ey = clamp(yRatio + hRatio + padY, 0, 1);

  const cropW = Math.max(1, Math.round(srcW * Math.max(0, ex - sx)));
  const cropH = Math.max(1, Math.round(srcH * Math.max(0, ey - sy)));

  canvas.width = Math.max(1, Math.round(cropW * scale));
  canvas.height = Math.max(1, Math.round(cropH * scale));

  if (type === 'threshold-diff') {
    // 白背景に黒文字を作る単純二値化。リザルト画面のような高コントラストUIに強い。
    ctx.drawImage(imageElement, srcW * sx, srcH * sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      // 明るい部分を黒、暗い部分を白へ反転して文字を立たせる
      const v = (gray > 175) ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
  } else {
    ctx.filter = 'grayscale(100%) contrast(180%)';
    ctx.drawImage(imageElement, srcW * sx, srcH * sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
  }

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function recognizeCrop(worker, imageElement, region, lang, opt = {}) {
  const blob = await cropImage(
    imageElement,
    region.x, region.y, region.w, region.h,
    opt.type || 'filter-standard',
    opt
  );
  const ret = await worker.recognize(blob, { lang });
  return {
    text: (ret && ret.data && ret.data.text) ? ret.data.text : '',
    confidence: (ret && ret.data && typeof ret.data.confidence === 'number') ? ret.data.confidence : 0,
  };
}

function normalizeNumericText(text) {
  return (text || '')
    .replace(/[OoQqＤ]/g, '0')
    .replace(/[Il|!]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
}

function extractDigits(text) {
  const cleaned = normalizeNumericText(text);
  const matches = cleaned.match(/\d+/g);
  return matches ? matches.join('\n') : '';
}

function parseBestNumber(text) {
  const digits = extractDigits(text);
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function scoreDifficultyText(diffText) {
  const cleaned = (diffText || '').toUpperCase().replace(/[^A-Z]/g, '');
  const words = Object.keys(DIFF_WORD_TO_CODE);
  if (!cleaned) return { code: 'EX', score: Infinity, exact: false };

  for (const word of words) {
    if (cleaned.includes(word)) {
      return { code: DIFF_WORD_TO_CODE[word], score: 0, exact: true, word };
    }
  }

  let bestWord = 'EXPERT';
  let bestDist = Infinity;
  for (const word of words) {
    const dist = levenshtein(cleaned, word) / Math.max(cleaned.length, word.length);
    if (dist < bestDist) {
      bestDist = dist;
      bestWord = word;
    }
  }
  return { code: DIFF_WORD_TO_CODE[bestWord], score: bestDist, exact: false, word: bestWord };
}

function detectDifficultyCode(diffText) {
  return scoreDifficultyText(diffText).code;
}

function parseBreakdownText(text) {
  const lines = (text || '').split('\n');
  let perfect = 0, great = 0, good = 0, bad = 0, miss = 0;
  const parseLine = (line, regex) => {
    if (regex.test(line)) {
      const nums = line.match(/\d+/g);
      if (nums) return parseInt(nums[nums.length - 1], 10);
    }
    return 0;
  };
  lines.forEach(line => {
    if (/PERFECT/i.test(line)) perfect = parseLine(line, /PERFECT/i);
    if (/GREAT/i.test(line)) great = parseLine(line, /GREAT/i);
    if (/G[O0QD]{2}D/i.test(line)) good = parseLine(line, /G[O0QD]{2}D/i);
    if (/BAD/i.test(line)) bad = parseLine(line, /BAD/i);
    if (/MISS/i.test(line)) miss = parseLine(line, /MISS/i);
  });
  return { perfect, great, good, bad, miss };
}

// コンボ数のテキストから最も桁数の多い数値を採用する(ラベル文字等の誤検出を避けるため)。
function parseComboText(text) {
  const matches = normalizeNumericText(text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) { if (m.length > best.length) best = m; }
  return parseInt(best, 10);
}

function pickBestNumericResult(results) {
  let best = null;
  for (const r of results) {
    const value = parseBestNumber(r.text);
    if (value === null) continue;
    const digits = extractDigits(r.text);
    const score = (r.confidence || 0) + Math.min(digits.length, 6) * 3;
    if (!best || score > best.score) {
      best = { value, score, text: r.text, confidence: r.confidence };
    }
  }
  return best ? best.value : 0;
}

function pickBestDifficultyResult(results) {
  let best = null;
  for (const r of results) {
    const scored = scoreDifficultyText(r.text);
    const candidate = {
      exact: scored.exact,
      dist: scored.score,
      confidence: r.confidence || 0,
      code: scored.code,
      text: r.text,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const a = best;
    const aDist = Number.isFinite(a.dist) ? a.dist : Infinity;
    const bDist = Number.isFinite(candidate.dist) ? candidate.dist : Infinity;
    const aRank = a.exact ? 3 : (Number.isFinite(a.dist) ? 2 : 0);
    const bRank = candidate.exact ? 3 : (Number.isFinite(candidate.dist) ? 2 : 0);
    if (bRank > aRank) { best = candidate; continue; }
    if (bRank < aRank) continue;
    if (bDist < aDist) { best = candidate; continue; }
    if (bDist > aDist) continue;
    if (candidate.confidence > a.confidence) best = candidate;
  }
  return best ? best.code : 'EX';
}

function scoreTitleCandidate(text) {
  const cleaned = (text || '').replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return null;

  const matchedMusic = findBestMatchMusic(cleaned);
  if (!matchedMusic) return {
    title: cleaned,
    musicId: null,
    score: Infinity,
    confidence: 0,
  };

  const target = normalizeString(cleaned);
  const dbTitleNorm = normalizeString(matchedMusic.title);
  const dist = levenshtein(target, dbTitleNorm) / Math.max(target.length, dbTitleNorm.length);
  return {
    title: matchedMusic.title,
    musicId: matchedMusic.id,
    score: dist,
    confidence: 0,
  };
}

function pickBestTitleResult(results) {
  let best = null;
  for (const r of results) {
    const scored = scoreTitleCandidate(r.text);
    if (!scored) continue;
    const candidate = {
      ...scored,
      rawText: r.text,
      confidence: r.confidence || 0,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.musicId !== null && best.musicId === null) { best = candidate; continue; }
    if (candidate.musicId === null && best.musicId !== null) continue;

    if (candidate.score < best.score) { best = candidate; continue; }
    if (candidate.score > best.score) continue;
    if (candidate.confidence > best.confidence) best = candidate;
  }
  return best || null;
}

async function analyzeDifficulty(imgElement, worker, region) {
  const variants = [
    { ...region, type: 'threshold-diff', scale: 2.0, padX: 0.010, padY: 0.006 },
    { ...region, type: 'threshold-diff', scale: 2.5, padX: 0.020, padY: 0.010 },
    { ...region, type: 'filter-standard', scale: 2.0, padX: 0.010, padY: 0.006 },
  ];
  const results = [];
  for (const v of variants) {
    const ret = await recognizeCrop(worker, imgElement, v, 'eng', v);
    results.push(ret);
  }
  return pickBestDifficultyResult(results);
}

async function analyzeTitle(imgElement, worker, region) {
  const variants = [
    { ...region, type: 'filter-standard', scale: 1.5, padX: 0.010, padY: 0.004 },
    { ...region, type: 'filter-standard', scale: 2.0, padX: 0.020, padY: 0.008 },
    { ...region, type: 'filter-standard', scale: 1.8, padX: 0.000, padY: 0.012 },
  ];
  const results = [];
  for (const v of variants) {
    const ret = await recognizeCrop(worker, imgElement, v, 'jpn', v);
    results.push(ret);
  }
  const best = pickBestTitleResult(results);
  if (!best) {
    return { title: '', musicId: null };
  }
  return {
    title: best.title,
    musicId: best.musicId,
  };
}

async function analyzeBreakdown(imgElement, worker, region) {
  const keys = ['perfect', 'great', 'good', 'bad', 'miss'];
  const rowH = region.h / 5;
  const result = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };
  const fallbackTexts = [];

  for (let i = 0; i < keys.length; i++) {
    const rowY = region.y + rowH * i;
    const candidates = [
      { x: region.x + region.w * 0.48, y: rowY + rowH * 0.05, w: region.w * 0.48, h: rowH * 0.88, type: 'threshold-diff', scale: 3.0 },
      { x: region.x + region.w * 0.38, y: rowY + rowH * 0.04, w: region.w * 0.58, h: rowH * 0.90, type: 'threshold-diff', scale: 2.5 },
      { x: region.x, y: rowY + rowH * 0.02, w: region.w, h: rowH * 0.96, type: 'filter-standard', scale: 2.0 },
    ];

    const ocrResults = [];
    for (const v of candidates) {
      const ret = await recognizeCrop(worker, imgElement, v, 'eng', v);
      ocrResults.push(ret);
      fallbackTexts.push(ret.text);
    }
    const value = pickBestNumericResult(ocrResults);
    result[keys[i]] = value;
  }

  const allZero = keys.every(k => result[k] === 0);
  if (allZero) {
    const fallback = parseBreakdownText(fallbackTexts.join('\\n'));
    if (fallback.perfect || fallback.great || fallback.good || fallback.bad || fallback.miss) {
      return fallback;
    }
  }

  return result;
}

async function analyzeCombo(imgElement, worker, region) {
  const variants = [
    { x: region.x + region.w * 0.42, y: region.y + region.h * 0.08, w: region.w * 0.52, h: region.h * 0.82, type: 'threshold-diff', scale: 3.0 },
    { x: region.x + region.w * 0.30, y: region.y + region.h * 0.06, w: region.w * 0.62, h: region.h * 0.86, type: 'threshold-diff', scale: 2.5 },
    { x: region.x, y: region.y, w: region.w, h: region.h, type: 'filter-standard', scale: 2.0 },
  ];

  const results = [];
  for (const v of variants) {
    const ret = await recognizeCrop(worker, imgElement, v, 'eng', v);
    results.push(ret);
  }
  const value = pickBestNumericResult(results);
  if (value !== 0) return value;

  const fallback = parseComboText(results.map(r => r.text).join('\\n'));
  return fallback || 0;
}

// 画像1枚を解析する。regions には { difficulty, title, breakdown, combo } (各 {x,y,w,h}) を渡す。
async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  try {
    const diffCode = await analyzeDifficulty(imgElement, worker, r.difficulty);
    const dbKey = getDiffDbKey(diffCode);

    const titleRes = await analyzeTitle(imgElement, worker, r.title);
    const finalTitle = titleRes.title;
    const musicId = titleRes.musicId;

    // レベル
    let level = "";
    if (musicId) level = getLevelFromDb(musicId, dbKey) || "";

    // 判定内訳 (PERFECT/GREAT/GOOD/BAD/MISS)
    const breakdown = await analyzeBreakdown(imgElement, worker, r.breakdown);

    // コンボ数
    const combo = await analyzeCombo(imgElement, worker, r.combo);

    return {
      title: finalTitle,
      level: level,
      diff: diffCode,
      perfect: breakdown.perfect,
      great: breakdown.great,
      good: breakdown.good,
      bad: breakdown.bad,
      miss: breakdown.miss,
      combo: combo,
      musicId: musicId
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}
