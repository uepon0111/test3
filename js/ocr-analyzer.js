/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取る範囲(座標)は「機種プロファイル」(device-profiles.js)から与えられ、
 * 設定ページで自由に調整できます。
 * -----------------------------------------------------------------------
 */

function regionToPixels(imageElement, region) {
  const iw = imageElement.naturalWidth || 0;
  const ih = imageElement.naturalHeight || 0;
  return {
    x: Math.max(0, Math.round(iw * region.x)),
    y: Math.max(0, Math.round(ih * region.y)),
    w: Math.max(1, Math.round(iw * region.w)),
    h: Math.max(1, Math.round(ih * region.h)),
  };
}

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

function computeOtsuThreshold(grayValues) {
  const hist = new Array(256).fill(0);
  for (const g of grayValues) hist[Math.max(0, Math.min(255, g))]++;

  const total = grayValues.length;
  if (!total) return 128;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise(resolve => canvas.toBlob(resolve, type));
}

function preprocessCrop(imageElement, region, opts = {}) {
  const { x, y, w, h } = regionToPixels(imageElement, region);
  const scale = opts.scale || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(imageElement, x, y, w, h, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const grayValues = new Uint8ClampedArray((data.length / 4) | 0);

  const brightness = opts.brightness ?? 0;
  const contrast = opts.contrast ?? 1;
  const threshold = opts.threshold;
  const invert = !!opts.invert;
  const sharpen = !!opts.sharpen;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (contrast !== 1) {
      r = clamp255((r - 128) * contrast + 128);
      g = clamp255((g - 128) * contrast + 128);
      b = clamp255((b - 128) * contrast + 128);
    }
    if (brightness !== 0) {
      r = clamp255(r + brightness);
      g = clamp255(g + brightness);
      b = clamp255(b + brightness);
    }
    const gray = clamp255(0.299 * r + 0.587 * g + 0.114 * b);
    grayValues[p] = gray;
    data[i] = data[i + 1] = data[i + 2] = gray;
    data[i + 3] = 255;
  }

  if (threshold !== null && threshold !== undefined) {
    const th = threshold === 'otsu' ? computeOtsuThreshold(grayValues) : threshold;
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i];
      const isWhite = gray >= th;
      const value = invert ? (isWhite ? 0 : 255) : (isWhite ? 255 : 0);
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  } else if (invert) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
      data[i + 3] = 255;
    }
  }

  if (sharpen) {
    const src = new Uint8ClampedArray(data);
    const kernel = [
      0, -1, 0,
      -1, 5, -1,
      0, -1, 0,
    ];
    const w2 = canvas.width;
    const h2 = canvas.height;
    const at = (x, y, c) => src[(y * w2 + x) * 4 + c];
    for (let y = 1; y < h2 - 1; y++) {
      for (let x = 1; x < w2 - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          let k = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              sum += at(x + kx, y + ky, c) * kernel[k++];
            }
          }
          data[(y * w2 + x) * 4 + c] = clamp255(sum);
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return { canvas, regionPx: { x, y, w, h } };
}

async function recognizeCanvas(worker, canvas, lang) {
  const blob = await canvasToBlob(canvas);
  const ret = await worker.recognize(blob, { lang });
  return {
    text: ret?.data?.text || '',
    confidence: typeof ret?.data?.confidence === 'number' ? ret.data.confidence : 0,
    blob,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

function normalizeOcrLines(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function cleanDisplayText(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\u3000/g, ' ').trim();
}

function parseLevelText(text) {
  const raw = String(text || '').replace(/\r/g, ' ');
  const digits = raw.match(/\d{1,3}/g);
  if (!digits || digits.length === 0) return null;
  const numbers = digits.map(v => parseInt(v, 10)).filter(v => Number.isFinite(v) && v >= 1 && v <= 99);
  if (numbers.length === 0) return null;
  numbers.sort((a, b) => Math.abs(a - 30) - Math.abs(b - 30));
  return numbers[0];
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
  const cleaned = normalizeString(diffText || '').toUpperCase().replace(/[^A-Z]/g, '');
  const words = Object.keys(DIFF_WORD_TO_CODE);
  if (!cleaned) return 'EX';

  for (const word of words) {
    if (cleaned.includes(word)) return DIFF_WORD_TO_CODE[word];
  }
  let bestWord = 'EXPERT', bestDist = Infinity;
  for (const word of words) {
    const dist = levenshtein(cleaned, word) / Math.max(cleaned.length, word.length);
    if (dist < bestDist) { bestDist = dist; bestWord = word; }
  }
  return DIFF_WORD_TO_CODE[bestWord];
}

function parseBreakdownText(text) {
  const lines = normalizeOcrLines(text);
  const result = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };

  const labelCandidates = [
    { key: 'perfect', words: ['perfect', 'pefect', 'perfact', 'perfec'] },
    { key: 'great', words: ['great', 'grea', 'gret'] },
    { key: 'good', words: ['good', 'g00d', 'go0d'] },
    { key: 'bad', words: ['bad'] },
    { key: 'miss', words: ['miss', 'mis'] },
  ];

  for (const line of lines) {
    const cleaned = normalizeString(line).replace(/[^a-z0-9]/g, '');
    let key = null;
    for (const cand of labelCandidates) {
      if (cand.words.some(w => cleaned.includes(w))) {
        key = cand.key;
        break;
      }
    }
    if (!key) {
      let best = null;
      let bestScore = Infinity;
      for (const cand of labelCandidates) {
        const score = levenshtein(cleaned, cand.key) / Math.max(cleaned.length || 1, cand.key.length);
        if (score < bestScore) {
          bestScore = score;
          best = cand.key;
        }
      }
      if (bestScore <= 0.45) key = best;
    }
    if (!key) continue;

    const nums = String(line).match(/\d+/g);
    if (nums && nums.length > 0) {
      result[key] = parseInt(nums[nums.length - 1], 10) || 0;
    }
  }

  return result;
}

function parseComboText(text) {
  const matches = String(text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) {
    if (m.length > best.length) best = m;
  }
  return parseInt(best, 10) || 0;
}

function normalizeTitleText(text) {
  return cleanDisplayText(String(text || '').replace(/\r/g, ' '));
}

function guessFieldVariants(field) {
  const presets = {
    difficulty: [
      { name: 'threshold', scale: 4, grayscale: true, contrast: 2.0, threshold: 180 },
      { name: 'otsu', scale: 4, grayscale: true, contrast: 2.2, threshold: 'otsu' },
    ],
    level: [
      { name: 'gray', scale: 5, grayscale: true, contrast: 2.2 },
      { name: 'threshold', scale: 5, grayscale: true, contrast: 2.4, threshold: 'otsu' },
    ],
    title: [
      { name: 'gray', scale: 4, grayscale: true, contrast: 1.8 },
      { name: 'threshold', scale: 4, grayscale: true, contrast: 2.0, threshold: 'otsu' },
    ],
    breakdown: [
      { name: 'threshold', scale: 3, grayscale: true, contrast: 2.0, threshold: 'otsu' },
      { name: 'inverse', scale: 3, grayscale: true, contrast: 2.0, threshold: 'otsu', invert: true },
    ],
    combo: [
      { name: 'threshold', scale: 4, grayscale: true, contrast: 2.2, threshold: 'otsu' },
      { name: 'inverse', scale: 4, grayscale: true, contrast: 2.2, threshold: 'otsu', invert: true },
    ],
  };
  return presets[field] || presets.title;
}

async function recognizeRegionVariants(worker, imgElement, field, region, lang) {
  const variants = [];
  const variantDefs = guessFieldVariants(field);
  for (const def of variantDefs) {
    const prep = preprocessCrop(imgElement, region, def);
    const rec = await recognizeCanvas(worker, prep.canvas, lang);
    variants.push({
      name: def.name,
      ...rec,
      regionPx: prep.regionPx,
    });
  }
  variants.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return String(b.text || '').length - String(a.text || '').length;
  });
  return {
    best: variants[0] || { text: '', confidence: 0, dataUrl: '', regionPx: regionToPixels(imgElement, region), name: 'none' },
    variants,
  };
}

function scoreTitleMatch(ocrTitle, candidateTitle) {
  const a = normalizeString(ocrTitle || '');
  const b = normalizeString(candidateTitle || '');
  if (!a || !b) return 1;
  return levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  const log = {
    image: { width: imgElement.naturalWidth, height: imgElement.naturalHeight },
    fields: {},
    candidate: null,
    warnings: [],
  };

  try {
    const diffAnalysis = await recognizeRegionVariants(worker, imgElement, 'difficulty', r.difficulty, 'eng');
    const diffText = cleanDisplayText(diffAnalysis.best.text);
    const diffCode = detectDifficultyCode(diffText);
    log.fields.difficulty = {
      label: '難易度',
      region: regionToPixels(imgElement, r.difficulty),
      best: {
        text: diffAnalysis.best.text,
        confidence: diffAnalysis.best.confidence,
        preview: diffAnalysis.best.dataUrl,
        variant: diffAnalysis.best.name,
      },
      variants: diffAnalysis.variants.map(v => ({
        name: v.name,
        text: v.text,
        confidence: v.confidence,
        preview: v.dataUrl,
      })),
      parsed: { text: diffText, code: diffCode },
    };

    const levelAnalysis = await recognizeRegionVariants(worker, imgElement, 'level', r.level, 'eng');
    const levelText = cleanDisplayText(levelAnalysis.best.text);
    const ocrLevel = parseLevelText(levelText);
    log.fields.level = {
      label: 'レベル',
      region: regionToPixels(imgElement, r.level),
      best: {
        text: levelAnalysis.best.text,
        confidence: levelAnalysis.best.confidence,
        preview: levelAnalysis.best.dataUrl,
        variant: levelAnalysis.best.name,
      },
      variants: levelAnalysis.variants.map(v => ({
        name: v.name,
        text: v.text,
        confidence: v.confidence,
        preview: v.dataUrl,
      })),
      parsed: { text: levelText, value: ocrLevel },
    };

    const titleAnalysis = await recognizeRegionVariants(worker, imgElement, 'title', r.title, 'jpn');
    const titleText = normalizeTitleText(titleAnalysis.best.text);
    const titleConfidence = titleAnalysis.best.confidence || 0;
    log.fields.title = {
      label: '曲名',
      region: regionToPixels(imgElement, r.title),
      best: {
        text: titleAnalysis.best.text,
        confidence: titleConfidence,
        preview: titleAnalysis.best.dataUrl,
        variant: titleAnalysis.best.name,
      },
      variants: titleAnalysis.variants.map(v => ({
        name: v.name,
        text: v.text,
        confidence: v.confidence,
        preview: v.dataUrl,
      })),
      parsed: { text: titleText },
    };

    const breakdownAnalysis = await recognizeRegionVariants(worker, imgElement, 'breakdown', r.breakdown, 'jpn');
    const breakdownText = cleanDisplayText(breakdownAnalysis.best.text);
    const breakdown = parseBreakdownText(breakdownText);
    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;
    log.fields.breakdown = {
      label: '判定内訳',
      region: regionToPixels(imgElement, r.breakdown),
      best: {
        text: breakdownAnalysis.best.text,
        confidence: breakdownAnalysis.best.confidence,
        preview: breakdownAnalysis.best.dataUrl,
        variant: breakdownAnalysis.best.name,
      },
      variants: breakdownAnalysis.variants.map(v => ({
        name: v.name,
        text: v.text,
        confidence: v.confidence,
        preview: v.dataUrl,
      })),
      parsed: { text: breakdownText, values: breakdown, totalNotes },
    };

    const comboAnalysis = await recognizeRegionVariants(worker, imgElement, 'combo', r.combo, 'eng');
    const comboText = cleanDisplayText(comboAnalysis.best.text);
    let combo = parseComboText(comboText);
    log.fields.combo = {
      label: 'コンボ数',
      region: regionToPixels(imgElement, r.combo),
      best: {
        text: comboAnalysis.best.text,
        confidence: comboAnalysis.best.confidence,
        preview: comboAnalysis.best.dataUrl,
        variant: comboAnalysis.best.name,
      },
      variants: comboAnalysis.variants.map(v => ({
        name: v.name,
        text: v.text,
        confidence: v.confidence,
        preview: v.dataUrl,
      })),
      parsed: { text: comboText, value: combo },
    };

    const diffKey = getDiffDbKey(diffCode);
    const inferred = inferMusicFromEvidence({
      titleText,
      titleConfidence,
      diffKey,
      level: ocrLevel,
      totalNotes,
    });

    let finalTitle = titleText;
    let finalLevel = ocrLevel !== null && ocrLevel !== undefined ? String(ocrLevel) : '';
    let finalMusicId = null;

    if (inferred) {
      finalMusicId = inferred.musicId;
      const titleSimilarity = scoreTitleMatch(titleText, inferred.title);
      const trustTitle = titleConfidence >= 65 && titleText && titleSimilarity <= 0.35;
      if (!trustTitle || !titleText) {
        finalTitle = inferred.title;
      }
      if (finalLevel === '' || titleConfidence < 55) {
        finalLevel = String(inferred.playLevel ?? finalLevel);
      }
      log.candidate = {
        musicId: inferred.musicId,
        title: inferred.title,
        difficulty: inferred.diffKey,
        playLevel: inferred.playLevel,
        totalNoteCount: inferred.totalNoteCount,
        score: inferred.score,
        titleScore: inferred.titleScore,
        levelScore: inferred.levelScore,
        noteScore: inferred.noteScore,
        exactDifficulty: inferred.exactDifficulty,
        alternatives: inferred.candidates || [],
      };
      if (titleText && titleSimilarity > 0.65) {
        log.warnings.push('曲名OCRの信頼度が低いため、DB候補を優先しました。');
      }
    } else {
      log.warnings.push('楽曲DB候補を決定できませんでした。');
    }

    if (finalMusicId && totalNotes > 0 && combo > totalNotes) {
      log.warnings.push(`コンボ数(${combo})が総ノーツ数(${totalNotes})を超えていたため、総ノーツ数に合わせて補正しました。`);
      combo = totalNotes;
    }

    if (finalMusicId && finalLevel === '') {
      const fallbackLevel = getLevelFromDb(finalMusicId, diffKey);
      if (fallbackLevel) finalLevel = String(fallbackLevel);
    }

    return {
      title: finalTitle,
      level: finalLevel,
      diff: diffCode,
      perfect: breakdown.perfect,
      great: breakdown.great,
      good: breakdown.good,
      bad: breakdown.bad,
      miss: breakdown.miss,
      combo: combo,
      musicId: finalMusicId,
      log,
      totalNotes,
    };
  } catch (e) {
    console.error(e);
    log.warnings.push(`解析失敗: ${e?.message || e}`);
    return null;
  }
}
