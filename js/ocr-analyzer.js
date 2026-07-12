/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取る範囲(座標)は「機種プロファイル」(device-profiles.js)から与えられ、
 * 設定ページで自由に調整できます。
 *
 * 改善:
 *   - 項目ごとに異なる前処理(グレースケール/二値化/反転/拡大)を適用
 *   - 1項目につき複数パターンを試し、OCR結果とDB情報を合わせて総合採用
 *   - 曲名が弱いときは、難易度・総ノーツ数・レベル情報で補完
 *   - 実測ログ(座標/前処理画像/OCR結果)を画面に出せるようにするための情報を返却
 * -----------------------------------------------------------------------
 */

const OCR_PRESETS = {
  difficulty: [
    { name: 'diff-bin', scale: 3.0, contrast: 2.3, brightness: 1.02, mode: 'binary', invert: false, threshold: 'otsu' },
    { name: 'diff-bin-inv', scale: 3.0, contrast: 2.4, brightness: 1.05, mode: 'binary', invert: true, threshold: 'otsu' },
  ],
  title: [
    { name: 'title-gray', scale: 3.0, contrast: 2.4, brightness: 1.08, mode: 'gray', invert: true },
    { name: 'title-bin', scale: 4.0, contrast: 2.6, brightness: 1.05, mode: 'binary', invert: true, threshold: 'otsu' },
  ],
  breakdown: [
    { name: 'breakdown-gray', scale: 3.0, contrast: 2.0, brightness: 1.05, mode: 'gray', invert: true },
    { name: 'breakdown-bin', scale: 3.5, contrast: 2.4, brightness: 1.03, mode: 'binary', invert: true, threshold: 'otsu' },
  ],
  combo: [
    { name: 'combo-gray', scale: 3.2, contrast: 2.2, brightness: 1.03, mode: 'gray', invert: true },
    { name: 'combo-bin', scale: 4.0, contrast: 2.6, brightness: 1.02, mode: 'binary', invert: true, threshold: 'otsu' },
  ],
};

function clamp01(v) { return clamp(v, 0, 1); }

function getRegionPxRect(imageElement, region, scale = 1) {
  const iw = imageElement.naturalWidth || 0;
  const ih = imageElement.naturalHeight || 0;
  const x = Math.max(0, Math.round(iw * clamp01(region.x)));
  const y = Math.max(0, Math.round(ih * clamp01(region.y)));
  const w = Math.max(1, Math.round(iw * clamp01(region.w)));
  const h = Math.max(1, Math.round(ih * clamp01(region.h)));
  return {
    x, y, w, h,
    scaledWidth: Math.max(1, Math.round(w * scale)),
    scaledHeight: Math.max(1, Math.round(h * scale)),
  };
}

function computeGrayHistogram(imageData) {
  const hist = new Array(256).fill(0);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    hist[gray]++;
  }
  return hist;
}

function computeOtsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = -1;
  let threshold = 128;

  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);

    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }
  return threshold;
}

function getImageStatsFromData(imageData) {
  const data = imageData.data;
  let min = 255;
  let max = 0;
  let sum = 0;
  let dark = 0;
  let bright = 0;
  const count = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    min = Math.min(min, gray);
    max = Math.max(max, gray);
    sum += gray;
    if (gray < 96) dark++;
    if (gray > 190) bright++;
  }
  return {
    min: Math.round(min),
    max: Math.round(max),
    mean: Math.round(sum / Math.max(count, 1)),
    darkRatio: count ? dark / count : 0,
    brightRatio: count ? bright / count : 0,
    contrast: Math.round(max - min),
  };
}

function applyModeToImageData(imageData, preset) {
  const data = imageData.data;
  const hist = computeGrayHistogram(imageData);
  const total = data.length / 4;
  let threshold = 0;

  if (preset.mode === 'binary') {
    threshold = preset.threshold === 'otsu' ? computeOtsuThreshold(hist, total) : 160;
  }

  // まずグレースケール化
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    let out = gray;
    if (preset.mode === 'binary') {
      const bin = gray >= threshold ? 255 : 0;
      out = preset.invert ? (255 - bin) : bin;
    } else if (preset.invert) {
      out = 255 - gray;
    }

    data[i] = data[i + 1] = data[i + 2] = out;
  }
  return { imageData, threshold };
}

async function canvasToBlob(canvas) {
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function buildPreprocessedCanvas(imageElement, region, preset) {
  const rect = getRegionPxRect(imageElement, region, preset.scale || 1);
  const canvas = document.createElement('canvas');
  canvas.width = rect.scaledWidth;
  canvas.height = rect.scaledHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.filter = `grayscale(100%) contrast(${preset.contrast || 1.5}) brightness(${preset.brightness || 1})`;
  ctx.drawImage(imageElement, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);

  let threshold = null;
  if (preset.mode === 'binary' || preset.invert) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const applied = applyModeToImageData(imageData, preset);
    threshold = applied.threshold;
    ctx.putImageData(applied.imageData, 0, 0);
  }

  const stats = getImageStatsFromData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  return { canvas, rect, stats, threshold };
}

function cropImage(imageElement, xRatio, yRatio, wRatio, hRatio, type = 'filter-standard') {
  const presets = {
    'threshold-diff': { scale: 3.0, contrast: 2.3, brightness: 1.02, mode: 'binary', invert: false, threshold: 'otsu' },
    'filter-standard': { scale: 2.5, contrast: 1.8, brightness: 1.05, mode: 'gray', invert: false },
  };
  const preset = presets[type] || presets['filter-standard'];
  const region = { x: xRatio, y: yRatio, w: wRatio, h: hRatio };
  const { canvas } = buildPreprocessedCanvas(imageElement, region, preset);
  return canvasToBlob(canvas);
}

const DIFF_WORD_TO_CODE = {
  EASY: 'EZ',
  NORMAL: 'NM',
  HARD: 'HD',
  EXPERT: 'EX',
  MASTER: 'MS',
  APPEND: 'AP',
};

function detectDifficultyCode(diffText) {
  const cleaned = (diffText || '').toUpperCase().replace(/[^A-Z]/g, '');
  const words = Object.keys(DIFF_WORD_TO_CODE);
  if (!cleaned) return 'EX';

  for (const word of words) {
    if (cleaned.includes(word)) return DIFF_WORD_TO_CODE[word];
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
  return DIFF_WORD_TO_CODE[bestWord];
}

function normalizeOcrLine(line) {
  return (line || '')
    .replace(/[ \t\r]/g, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .toUpperCase();
}

function parseBreakdownText(text) {
  const lines = (text || '').split('\n');
  let perfect = 0, great = 0, good = 0, bad = 0, miss = 0;

  const parseLine = (line) => {
    const nums = line.match(/\d+/g);
    return nums ? parseInt(nums[nums.length - 1], 10) : 0;
  };

  for (const rawLine of lines) {
    const line = normalizeOcrLine(rawLine);
    if (!line) continue;
    if (/PERF/.test(line)) perfect = parseLine(line);
    else if (/GREAT/.test(line)) great = parseLine(line);
    else if (/G[O0QD]{2}D/.test(line) || /GOOD/.test(line)) good = parseLine(line);
    else if (/BAD/.test(line)) bad = parseLine(line);
    else if (/MISS/.test(line)) miss = parseLine(line);
  }
  return { perfect, great, good, bad, miss };
}

function parseComboText(text) {
  const cleaned = (text || '').replace(/[,\s]/g, '');
  const matches = cleaned.match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) {
    if (m.length > best.length) best = m;
  }
  return parseInt(best, 10);
}

function ocrScoreForRegion(regionKey, text, confidence, extra) {
  const clean = (text || '').trim();
  const titleScore = extra && extra.titleMatchScore !== undefined ? extra.titleMatchScore : null;
  switch (regionKey) {
    case 'difficulty':
      return (confidence || 0) + (extra && extra.diffCode ? 40 : 0) + (clean.length ? 5 : 0);
    case 'title':
      return ((confidence || 0) * 0.35) + ((titleScore !== null && Number.isFinite(titleScore)) ? (1 - titleScore) * 100 : 0);
    case 'breakdown': {
      const parsed = extra && extra.parsed ? extra.parsed : null;
      const nonZero = parsed ? ['perfect', 'great', 'good', 'bad', 'miss'].reduce((n, k) => n + (parsed[k] > 0 ? 1 : 0), 0) : 0;
      return (confidence || 0) + nonZero * 12;
    }
    case 'combo':
      return (confidence || 0) + ((parseComboText(clean) > 0) ? 20 : 0);
    default:
      return confidence || 0;
  }
}

async function recognizeRegionVariants(imgElement, worker, region, regionKey, lang, presets) {
  const logs = [];
  let best = null;

  for (const preset of presets) {
    const built = buildPreprocessedCanvas(imgElement, region, preset);
    const blob = await canvasToBlob(built.canvas);
    const ret = await worker.recognize(blob, { lang });
    const rawText = ret?.data?.text || '';
    const text = rawText.replace(/\r/g, '').trim();
    const confidence = Number(ret?.data?.confidence || 0);

    let extra = {};
    if (regionKey === 'title') {
      const matched = findBestMatchMusicDetailed(text);
      extra.titleMatch = matched ? matched.music : null;
      extra.titleMatchScore = matched ? matched.score : null;
    } else if (regionKey === 'difficulty') {
      const diffCode = detectDifficultyCode(text.toUpperCase());
      extra.diffCode = diffCode;
    } else if (regionKey === 'breakdown') {
      extra.parsed = parseBreakdownText(text);
    } else if (regionKey === 'combo') {
      extra.parsedCombo = parseComboText(text);
    }

    const score = ocrScoreForRegion(regionKey, text, confidence, extra);
    const entry = {
      variant: preset.name,
      lang,
      text,
      confidence,
      score,
      threshold: built.threshold,
      rectPx: built.rect,
      stats: built.stats,
      previewDataUrl: built.canvas.toDataURL('image/png'),
      extra,
    };
    logs.push(entry);
    if (!best || entry.score > best.score) best = entry;
  }

  return { best, logs };
}

function buildRegionDebug(regionKey, region, result, finalValue) {
  return {
    regionKey,
    region,
    best: result.best,
    variants: result.logs,
    finalValue,
  };
}

async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  try {
    const diffRegion = r.difficulty;
    const diffResult = await recognizeRegionVariants(imgElement, worker, diffRegion, 'difficulty', 'eng', OCR_PRESETS.difficulty);
    const diffBest = diffResult.best || {};
    const diffText = diffBest.text || '';
    const diffCode = detectDifficultyCode(diffText.toUpperCase());
    const dbKey = getDiffDbKey(diffCode);

    const breakdownRegion = r.breakdown;
    const breakdownResult = await recognizeRegionVariants(imgElement, worker, breakdownRegion, 'breakdown', 'jpn', OCR_PRESETS.breakdown);
    const breakdownBest = breakdownResult.best || {};
    const breakdownText = breakdownBest.text || '';
    const breakdown = parseBreakdownText(breakdownText);
    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;

    const comboRegion = r.combo;
    const comboResult = await recognizeRegionVariants(imgElement, worker, comboRegion, 'combo', 'eng', OCR_PRESETS.combo);
    const comboBest = comboResult.best || {};
    const comboText = comboBest.text || '';
    const combo = parseComboText(comboText);

    const titleRegion = r.title;
    const titleResult = await recognizeRegionVariants(imgElement, worker, titleRegion, 'title', 'jpn', OCR_PRESETS.title);
    const titleBest = titleResult.best || {};
    const titleText = titleBest.text || '';
    const titleMatch = resolveMusicFromAnalysis({
      ocrText: titleText,
      ocrConfidence: titleBest.confidence || 0,
      diffCode,
      totalNotes,
    });

    let finalTitle = titleText.replace(/\r?\n/g, ' ').trim();
    let musicId = null;
    let musicScore = null;
    let matchMode = null;

    if (titleMatch && titleMatch.music) {
      finalTitle = titleMatch.music.title;
      musicId = titleMatch.music.id;
      musicScore = titleMatch.score ?? null;
      matchMode = titleMatch.mode || null;
    } else {
      const weakMatch = findBestMatchMusicDetailed(titleText);
      if (weakMatch && weakMatch.music) {
        finalTitle = weakMatch.music.title;
        musicId = weakMatch.music.id;
        musicScore = weakMatch.score ?? null;
        matchMode = 'title-only';
      }
    }

    // タイトルが弱いときは、難易度と総ノーツ数で再補完するためにもう一度候補を確認
    if ((!musicId || !finalTitle || finalTitle.length < 2) && totalNotes > 0) {
      const fallback = findBestMusicByContext({
        ocrText: titleText,
        ocrConfidence: titleBest.confidence || 0,
        diffCode,
        totalNotes,
      });
      if (fallback && fallback.music) {
        finalTitle = fallback.music.title;
        musicId = fallback.music.id;
        musicScore = fallback.score;
        matchMode = fallback.mode || 'context-only';
      }
    }

    let level = "";
    if (musicId) level = getLevelFromDb(musicId, dbKey) || "";

    const debug = {
      imageSize: {
        width: imgElement.naturalWidth || 0,
        height: imgElement.naturalHeight || 0,
      },
      diff: buildRegionDebug('difficulty', diffRegion, diffResult, diffCode),
      title: buildRegionDebug('title', titleRegion, titleResult, finalTitle),
      breakdown: buildRegionDebug('breakdown', breakdownRegion, breakdownResult, breakdown),
      combo: buildRegionDebug('combo', comboRegion, comboResult, combo),
      summary: {
        diffCode,
        level,
        titleMode: matchMode,
        titleScore: musicScore,
        musicId,
        totalNotes,
      },
    };

    return {
      title: finalTitle,
      level,
      diff: diffCode,
      perfect: breakdown.perfect,
      great: breakdown.great,
      good: breakdown.good,
      bad: breakdown.bad,
      miss: breakdown.miss,
      combo,
      totalNotes,
      musicId,
      debug,
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}
