/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取り時は、項目ごとに前処理を分け、複数パターンのOCR結果を比較して
 * より信頼できる結果を採用します。
 *
 * 読み取る項目:
 *   - 難易度 (EASY/NORMAL/HARD/EXPERT/MASTER/APPEND)
 *   - 曲名 (マスターDBとの照合で補正)
 *   - 判定内訳 (PERFECT/GREAT/GOOD/BAD/MISS)
 *   - コンボ数
 *
 * さらに、実測ログとして以下を保持します。
 *   - 元の座標範囲(px/比率)
 *   - 切り出し画像
 *   - 前処理後(二値化後)画像
 *   - OCR結果(text / confidence)
 *   - 採用候補と採用理由
 * -----------------------------------------------------------------------
 */

function clamp01(v) {
  return clamp(v, 0, 1);
}

function regionToPixels(imageElement, region) {
  const w = imageElement.naturalWidth || 0;
  const h = imageElement.naturalHeight || 0;
  const x = Math.round(w * region.x);
  const y = Math.round(h * region.y);
  const rw = Math.round(w * region.w);
  const rh = Math.round(h * region.h);
  return { x, y, width: rw, height: rh, imageWidth: w, imageHeight: h };
}

function normalizeCropRegion(region, pad) {
  const p = pad || {};
  let x = clamp01((region.x || 0) - (p.left || 0));
  let y = clamp01((region.y || 0) - (p.top || 0));
  let w = clamp01((region.w || 0) + (p.left || 0) + (p.right || 0));
  let h = clamp01((region.h || 0) + (p.top || 0) + (p.bottom || 0));

  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  return { x, y, w: Math.max(0.01, w), h: Math.max(0.01, h) };
}

function createCanvasForCrop(imageElement, region, scale) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = imageElement.naturalWidth || 0;
  const h = imageElement.naturalHeight || 0;
  const crop = regionToPixels(imageElement, region);

  const outW = Math.max(1, Math.round(crop.width * scale));
  const outH = Math.max(1, Math.round(crop.height * scale));
  canvas.width = outW;
  canvas.height = outH;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    imageElement,
    crop.x, crop.y, crop.width, crop.height,
    0, 0, outW, outH
  );
  return { canvas, ctx, crop };
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function canvasToDataUrl(canvas) {
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    return '';
  }
}

function applySharpen(ctx, width, height, amount) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const src = new Uint8ClampedArray(imageData.data);
  const dst = imageData.data;
  const a = amount === undefined ? 1.2 : amount;
  const k = [
    0, -a, 0,
    -a, 1 + 4 * a, -a,
    0, -a, 0,
  ];

  const idx = (x, y) => (y * width + x) * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = idx(x, y);
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          const sy = Math.min(height - 1, Math.max(0, y + ky));
          for (let kx = -1; kx <= 1; kx++) {
            const sx = Math.min(width - 1, Math.max(0, x + kx));
            sum += src[idx(sx, sy) + c] * k[ki++];
          }
        }
        dst[base + c] = clamp(Math.round(sum), 0, 255);
      }
      dst[base + 3] = src[base + 3];
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function toGrayArray(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8ClampedArray(width * height);
  let sum = 0;
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p++) {
    const g = Math.round(0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2]);
    gray[p] = g;
    sum += g;
  }
  return { imageData, gray, mean: gray.length ? (sum / gray.length) : 0 };
}

function applyOtsuThreshold(gray, width, height, invert) {
  const histogram = new Array(256).fill(0);
  for (const v of gray) histogram[v]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;

  for (let i = 0; i < 256; i++) {
    wB += histogram[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * histogram[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = i;
    }
  }

  const out = new Uint8ClampedArray(total * 4);
  let darkPixels = 0;
  for (let i = 0; i < total; i++) {
    const isDark = gray[i] <= threshold;
    let v = isDark ? 0 : 255;
    if (invert) v = 255 - v;
    if (v === 0) darkPixels++;
    const j = i * 4;
    out[j] = out[j + 1] = out[j + 2] = v;
    out[j + 3] = 255;
  }
  return { data: out, threshold, darkRatio: total ? darkPixels / total : 0 };
}

function applyAdaptiveThreshold(gray, width, height, invert, windowSize) {
  const rad = Math.max(2, Math.floor((windowSize || 17) / 2));
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += gray[(y - 1) * width + (x - 1)];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  let darkPixels = 0;

  const sumRegion = (x1, y1, x2, y2) => {
    const A = integral[y1 * stride + x1];
    const B = integral[y1 * stride + (x2 + 1)];
    const C = integral[(y2 + 1) * stride + x1];
    const D = integral[(y2 + 1) * stride + (x2 + 1)];
    return D - B - C + A;
  };

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - rad);
    const y2 = Math.min(height - 1, y + rad);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - rad);
      const x2 = Math.min(width - 1, x + rad);
      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const localMean = sumRegion(x1, y1, x2, y2) / area;
      const idx = y * width + x;
      const bias = 14;
      let v = gray[idx] > (localMean - bias) ? 255 : 0;
      if (invert) v = 255 - v;
      if (v === 0) darkPixels++;
      const j = idx * 4;
      out[j] = out[j + 1] = out[j + 2] = v;
      out[j + 3] = 255;
    }
  }
  return { data: out, darkRatio: width * height ? darkPixels / (width * height) : 0 };
}

function writeProcessedDataToCanvas(canvas, processedData) {
  const ctx = canvas.getContext('2d');
  const img = new ImageData(processedData, canvas.width, canvas.height);
  ctx.putImageData(img, 0, 0);
}

function createRegionDebugEntry(regionKey, region, crop, preprocessName, rawUrl, processedUrl, ocrPasses) {
  return {
    key: regionKey,
    region: { ...region },
    crop,
    preprocessName,
    rawUrl,
    processedUrl,
    ocrPasses,
  };
}

function getOcrScoreBonus(text, kind) {
  const t = (text || '').trim();
  if (!t) return -20;
  switch (kind) {
    case 'diff':
      return /(EASY|NORMAL|HARD|EXPERT|MASTER|APPEND)/i.test(t) ? 30 : 0;
    case 'breakdown':
      return /(PERFECT|GREAT|GOOD|BAD|MISS)/i.test(t) ? 25 : 0;
    case 'combo':
      return /\d/.test(t) ? 20 : 0;
    default:
      return Math.min(10, Math.max(0, t.length / 2));
  }
}

async function runOcrPass(worker, canvas, lang, kind, label) {
  const blob = await canvasToBlob(canvas);
  const ret = await worker.recognize(blob, { lang });
  const text = (ret && ret.data && typeof ret.data.text === 'string') ? ret.data.text : '';
  const confidence = ret && ret.data && Number.isFinite(ret.data.confidence) ? ret.data.confidence : 0;
  const score = confidence + getOcrScoreBonus(text, kind);
  return {
    label,
    lang,
    text,
    confidence,
    score,
    blob,
  };
}

function pickBestPass(passes) {
  let best = null;
  for (const p of passes) {
    if (!best || p.score > best.score) best = p;
  }
  return best || passes[0] || null;
}

function guessShouldInvert(meanBrightness, kind) {
  if (kind === 'title') return meanBrightness < 145;
  if (kind === 'breakdown' || kind === 'combo') return meanBrightness < 150;
  if (kind === 'diff') return meanBrightness < 165;
  return meanBrightness < 150;
}

function buildPreprocessVariants(regionKey) {
  switch (regionKey) {
    case 'difficulty':
      return [
        { name: 'diff-binary', scale: 3.2, kind: 'binary', lang: 'eng', ocrKind: 'diff', pad: { top: 0.01, bottom: 0.01, left: 0.005, right: 0.005 }, sharpen: 0.9 },
      ];
    case 'title':
      return [
        { name: 'title-soft', scale: 2.3, kind: 'soft', lang: 'jpn', ocrKind: 'title', pad: { top: 0.01, bottom: 0.008, left: 0.01, right: 0.01 }, sharpen: 1.25 },
        { name: 'title-binary', scale: 3.0, kind: 'binary', lang: 'jpn', ocrKind: 'title', pad: { top: 0.008, bottom: 0.008, left: 0.01, right: 0.01 }, sharpen: 0.85 },
      ];
    case 'breakdown':
      return [
        { name: 'breakdown-binary', scale: 2.8, kind: 'binary', lang: 'jpn', ocrKind: 'breakdown', pad: { top: 0.01, bottom: 0.01, left: 0.005, right: 0.005 }, sharpen: 0.9 },
        { name: 'breakdown-invert', scale: 2.8, kind: 'binary', lang: 'jpn', ocrKind: 'breakdown', pad: { top: 0.01, bottom: 0.01, left: 0.005, right: 0.005 }, sharpen: 0.9, forceInvert: true },
      ];
    case 'combo':
      return [
        { name: 'combo-binary', scale: 3.0, kind: 'binary', lang: 'eng', ocrKind: 'combo', pad: { top: 0.01, bottom: 0.012, left: 0.005, right: 0.005 }, sharpen: 0.8 },
      ];
    default:
      return [
        { name: `${regionKey}-binary`, scale: 2.5, kind: 'binary', lang: 'eng', ocrKind: regionKey, pad: { top: 0, bottom: 0, left: 0, right: 0 }, sharpen: 0.8 },
      ];
  }
}

async function preprocessCrop(imageElement, regionKey, region, variant) {
  const normalized = normalizeCropRegion(region, variant.pad);
  const { canvas, ctx, crop } = createCanvasForCrop(imageElement, normalized, variant.scale || 1);

  let rawPreview = canvasToDataUrl(canvas);
  let processedPreview = rawPreview;
  let appliedInvert = false;
  let threshold = null;
  let meanBrightness = null;

  if (variant.kind === 'soft') {
    ctx.filter = 'grayscale(100%) contrast(180%)';
    ctx.drawImage(
      imageElement,
      crop.x, crop.y, crop.width, crop.height,
      0, 0, canvas.width, canvas.height
    );
    if (variant.sharpen) applySharpen(ctx, canvas.width, canvas.height, variant.sharpen);
    processedPreview = canvasToDataUrl(canvas);
  } else {
    const grayCtx = canvas.getContext('2d', { willReadFrequently: true });
    const { gray, mean } = toGrayArray(grayCtx, canvas.width, canvas.height);
    meanBrightness = mean;
    const invert = typeof variant.forceInvert === 'boolean'
      ? variant.forceInvert
      : guessShouldInvert(meanBrightness, variant.ocrKind);
    appliedInvert = invert;

    const res = applyAdaptiveThreshold(gray, canvas.width, canvas.height, invert, 17);
    threshold = null;
    writeProcessedDataToCanvas(canvas, res.data);
    processedPreview = canvasToDataUrl(canvas);
  }

  const blob = await canvasToBlob(canvas);
  return {
    blob,
    rawPreview,
    processedPreview,
    appliedInvert,
    threshold,
    meanBrightness,
    crop,
    region: normalized,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
}

async function analyzeRegion(imageElement, worker, regionKey, region) {
  const variants = buildPreprocessVariants(regionKey);
  const ocrPasses = [];
  let bestArtifact = null;

  for (const variant of variants) {
    const art = await preprocessCrop(imageElement, regionKey, region, variant);
    if (!bestArtifact) bestArtifact = art;
    const ret = await worker.recognize(art.blob, { lang: variant.lang });
    const text = (ret && ret.data && typeof ret.data.text === 'string') ? ret.data.text : '';
    const confidence = ret && ret.data && Number.isFinite(ret.data.confidence) ? ret.data.confidence : 0;
    const score = confidence + getOcrScoreBonus(text, variant.ocrKind);
    ocrPasses.push({
      label: variant.name,
      lang: variant.lang,
      text,
      confidence,
      score,
      appliedInvert: art.appliedInvert,
      meanBrightness: art.meanBrightness,
      crop: art.crop,
      canvasWidth: art.canvasWidth,
      canvasHeight: art.canvasHeight,
    });
    if (!bestArtifact || score >= (bestArtifact.score || -Infinity)) {
      bestArtifact = { ...art, score, variant };
    }
  }

  const bestPass = pickBestPass(ocrPasses);
  return {
    bestPass,
    ocrPasses,
    artifact: bestArtifact,
  };
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

function parseComboText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) { if (m.length > best.length) best = m; }
  return parseInt(best, 10);
}

function detectDifficultyCode(diffText) {
  const DIFF_WORD_TO_CODE = { EASY: 'EZ', NORMAL: 'NM', HARD: 'HD', EXPERT: 'EX', MASTER: 'MS', APPEND: 'AP' };
  const cleaned = (diffText || '').toUpperCase().replace(/[^A-Z]/g, '');
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

function extractNumericField(obj, preferredKeys) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = Array.isArray(preferredKeys) ? preferredKeys : [];
  for (const key of keys) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') continue;
    const n = Number(obj[key]);
    if (Number.isFinite(n)) return n;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!/note|count|level|combo/i.test(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getMusicLevelEntry(musicId, diffKey) {
  if (!musicId || !diffKey || !Array.isArray(dbDiffs)) return null;
  return dbDiffs.find(d => d.musicId === musicId && d.musicDifficulty === diffKey) || null;
}

function getExpectedPlayLevel(musicId, diffKey) {
  const entry = getMusicLevelEntry(musicId, diffKey);
  if (!entry) return null;
  const level = extractNumericField(entry, ['playLevel', 'level', 'difficultyLevel']);
  return level !== null ? String(level) : (entry.playLevel !== undefined ? String(entry.playLevel) : null);
}

function getExpectedNoteCount(musicId, diffKey) {
  const entry = getMusicLevelEntry(musicId, diffKey);
  if (!entry) return null;
  return extractNumericField(entry, [
    'totalNotes', 'noteCount', 'notes', 'allNotes', 'noteCnt', 'note_total', 'noteTotal',
    'totalNoteCount', 'scoreNotes', 'noteNum',
  ]);
}

function getMusicLevelValue(musicId, diffKey) {
  const level = getExpectedPlayLevel(musicId, diffKey);
  if (level === null || level === undefined) return null;
  const n = parseFloat(level);
  return Number.isFinite(n) ? n : null;
}

function buildTitleCandidateList(ocrTitleText) {
  const target = normalizeString(ocrTitleText || '');
  if (!Array.isArray(dbMusics) || dbMusics.length === 0) return [];
  const list = [];
  for (const music of dbMusics) {
    const normalized = normalizeString(music.title || '');
    const dist = target ? levenshtein(target, normalized) / Math.max(target.length, normalized.length || 1) : 1;
    list.push({ music, normalized, titleDistance: dist });
  }
  list.sort((a, b) => a.titleDistance - b.titleDistance);
  return list;
}

function scoreMusicCandidate(candidate, options) {
  const {
    ocrTitleNorm,
    titleConfidence,
    diffCode,
    levelHint,
    totalNotes,
    combo,
  } = options;

  const music = candidate.music;
  const candidateTitleNorm = candidate.normalized;
  let score = 0;

  if (ocrTitleNorm) {
    const titleDist = levenshtein(ocrTitleNorm, candidateTitleNorm) / Math.max(ocrTitleNorm.length, candidateTitleNorm.length || 1);
    const titleWeight = Math.max(0.15, Math.min(1, (titleConfidence || 0) / 100));
    score += titleDist * (1.2 - titleWeight);
    score += titleDist * 0.8 * titleWeight;
  } else {
    score += 0.35;
  }

  if (diffCode) {
    const expectedLevel = getExpectedPlayLevel(music.id, diffCode);
    const expectedLevelValue = expectedLevel !== null && expectedLevel !== undefined ? parseFloat(expectedLevel) : null;
    if (levelHint !== null && expectedLevelValue !== null && Number.isFinite(levelHint) && Number.isFinite(expectedLevelValue)) {
      score += Math.abs(levelHint - expectedLevelValue) * 0.08;
    } else if (levelHint !== null && expectedLevelValue === null) {
      score += 0.05;
    }

    const expectedNotes = getExpectedNoteCount(music.id, diffCode);
    if (totalNotes !== null && expectedNotes !== null) {
      score += Math.abs(totalNotes - expectedNotes) / Math.max(totalNotes, expectedNotes, 1) * 0.9;
    } else if (totalNotes !== null && expectedNotes === null) {
      score += 0.04;
    }

    if (combo !== null && totalNotes !== null && combo > totalNotes) {
      score += 0.5;
    }
  } else {
    if (totalNotes !== null && combo !== null && combo > totalNotes) {
      score += 0.3;
    }
  }

  return score;
}

function resolveMusicByEvidence({ ocrTitleText, titleConfidence, diffCode, levelHint, totalNotes, combo }) {
  const candidates = buildTitleCandidateList(ocrTitleText);
  if (candidates.length === 0) {
    return {
      music: null,
      musicId: null,
      title: (ocrTitleText || '').replace(/\r?\n/g, '').trim(),
      level: levelHint !== null && levelHint !== undefined ? String(levelHint) : '',
      candidates: [],
      reason: 'music-db-empty',
    };
  }

  const ocrTitleNorm = normalizeString(ocrTitleText || '');
  const scored = candidates.map(candidate => ({
    ...candidate,
    score: scoreMusicCandidate(candidate, { ocrTitleNorm, titleConfidence, diffCode, levelHint, totalNotes, combo }),
    expectedLevel: diffCode ? getExpectedPlayLevel(candidate.music.id, diffCode) : null,
    expectedNotes: diffCode ? getExpectedNoteCount(candidate.music.id, diffCode) : null,
  }));
  scored.sort((a, b) => a.score - b.score);

  const best = scored[0];
  const second = scored[1] || null;
  const title = best ? best.music.title : (ocrTitleText || '').replace(/\r?\n/g, '').trim();
  const musicId = best ? best.music.id : null;

  let level = '';
  if (musicId && diffCode) {
    level = getExpectedPlayLevel(musicId, diffCode) || '';
  } else if (levelHint !== null && levelHint !== undefined) {
    level = String(levelHint);
  }

  return {
    music: best ? best.music : null,
    musicId,
    title,
    level,
    candidates: scored.slice(0, 8).map(item => ({
      musicId: item.music.id,
      title: item.music.title,
      score: Number(item.score.toFixed(4)),
      titleDistance: Number(item.titleDistance.toFixed(4)),
      expectedLevel: item.expectedLevel,
      expectedNotes: item.expectedNotes,
    })),
    reason: best
      ? (ocrTitleNorm ? (best.score + 0.05 < (second ? second.score : Infinity) ? 'ocr+metadata' : 'ambiguous-metadata') : 'metadata-fallback')
      : 'no-match',
  };
}

function pickBestTitleText(passes) {
  const ordered = [...passes].sort((a, b) => b.score - a.score);
  return ordered[0] || { text: '', confidence: 0, score: 0 };
}

function buildRegionResult(regionKey, analysis, imageElement) {
  const bestPass = pickBestTitleText(analysis.ocrPasses);
  const rawText = (bestPass.text || '').replace(/\r?\n/g, '\n');
  const cleanedText = rawText.trim();

  return {
    bestPass,
    rawText,
    cleanedText,
    analysis,
  };
}

async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  try {
    const debug = {
      imageSize: {
        width: imgElement.naturalWidth || 0,
        height: imgElement.naturalHeight || 0,
      },
      regions: {},
      summary: {},
    };

    // 難易度
    const diffAnalysis = await analyzeRegion(imgElement, worker, 'difficulty', r.difficulty);
    const diffBest = diffAnalysis.bestPass || { text: '', confidence: 0, score: 0 };
    const diffCode = detectDifficultyCode(diffBest.text);
    const diffText = (diffBest.text || '').toUpperCase();
    const dbKey = getDiffDbKey(diffCode);
    debug.regions.difficulty = {
      ...diffAnalysis.artifact,
      ocrPasses: diffAnalysis.ocrPasses,
      chosen: diffBest,
      text: diffText,
      code: diffCode,
      dbKey,
    };

    // 曲名 (OCRの信頼度が低い場合は、難易度・レベル・総ノーツ数も加味して補正)
    const titleAnalysis = await analyzeRegion(imgElement, worker, 'title', r.title);
    const titleBest = titleAnalysis.bestPass || { text: '', confidence: 0, score: 0 };
    const titleText = (titleBest.text || '').replace(/\r?\n/g, ' ').trim();
    debug.regions.title = {
      ...titleAnalysis.artifact,
      ocrPasses: titleAnalysis.ocrPasses,
      chosen: titleBest,
      text: titleText,
    };

    // 判定内訳
    const breakdownAnalysis = await analyzeRegion(imgElement, worker, 'breakdown', r.breakdown);
    const breakdownBest = breakdownAnalysis.bestPass || { text: '', confidence: 0, score: 0 };
    const breakdown = parseBreakdownText(breakdownBest.text);
    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;
    debug.regions.breakdown = {
      ...breakdownAnalysis.artifact,
      ocrPasses: breakdownAnalysis.ocrPasses,
      chosen: breakdownBest,
      text: breakdownBest.text || '',
      parsed: breakdown,
      totalNotes,
    };

    // コンボ数
    const comboAnalysis = await analyzeRegion(imgElement, worker, 'combo', r.combo);
    const comboBest = comboAnalysis.bestPass || { text: '', confidence: 0, score: 0 };
    let combo = parseComboText(comboBest.text);
    debug.regions.combo = {
      ...comboAnalysis.artifact,
      ocrPasses: comboAnalysis.ocrPasses,
      chosen: comboBest,
      text: comboBest.text || '',
      parsed: combo,
    };

    // タイトル・レベルの採用候補を総合判定
    const levelHint = null;
    const resolved = resolveMusicByEvidence({
      ocrTitleText: titleText,
      titleConfidence: titleBest.confidence || 0,
      diffCode,
      levelHint,
      totalNotes,
      combo,
    });

    // レベルは曲名と難易度から補正。OCRのレベルが無い分、DB一致を優先する。
    let level = '';
    if (resolved.musicId && diffCode) {
      level = getExpectedPlayLevel(resolved.musicId, dbKey) || '';
    }
    if (!level && resolved.level) level = resolved.level;
    if (!level && resolved.music) {
      level = getExpectedPlayLevel(resolved.music.id, dbKey) || '';
    }

    // コンボ数が総ノーツ数を超えるのは不自然なので、明らかな誤認識は丸める
    let comboAdjusted = combo;
    if (totalNotes > 0 && comboAdjusted > totalNotes) comboAdjusted = totalNotes;

    debug.summary = {
      diffConfidence: diffBest.confidence || 0,
      titleConfidence: titleBest.confidence || 0,
      breakdownConfidence: breakdownBest.confidence || 0,
      comboConfidence: comboBest.confidence || 0,
      totalNotes,
      combo: comboAdjusted,
      comboOverTotalNotes: totalNotes > 0 ? combo > totalNotes : false,
      titleResolutionReason: resolved.reason,
      bestCandidates: resolved.candidates,
    };

    return {
      title: resolved.title || titleText,
      level: level || '',
      diff: diffCode,
      perfect: breakdown.perfect,
      great: breakdown.great,
      good: breakdown.good,
      bad: breakdown.bad,
      miss: breakdown.miss,
      combo: comboAdjusted,
      musicId: resolved.musicId,
      debug,
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}
