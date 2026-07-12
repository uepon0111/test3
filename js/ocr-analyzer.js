/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取る範囲(座標)は「機種プロファイル」(device-profiles.js)から与えられ、
 * 設定ページで自由に調整できます。
 *
 * ここでは、項目ごとに前処理を変えた複数のOCR候補を比較し、
 * 難易度・曲名・判定内訳・コンボ数を総合的に判定します。
 * 曲名が曖昧な場合は、難易度・総ノーツ数・DB上の曲情報を併用して補正します。
 * また、設定画面ではこの解析の実測ログ(座標 / 二値化後画像 / OCR結果 / 採用理由)を
 * 表示できるようにしています。
 * -----------------------------------------------------------------------
 */

function regionToPixelRect(imageElement, region) {
  const w = imageElement.naturalWidth || 0;
  const h = imageElement.naturalHeight || 0;
  return {
    left: Math.max(0, Math.round(w * region.x)),
    top: Math.max(0, Math.round(h * region.y)),
    width: Math.max(1, Math.round(w * region.w)),
    height: Math.max(1, Math.round(h * region.h)),
  };
}

function canvasToBlobPromise(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function createCropCanvas(imageElement, region, scale = 1) {
  const w = imageElement.naturalWidth || 0;
  const h = imageElement.naturalHeight || 0;
  const rect = regionToPixelRect(imageElement, region);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    imageElement,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return { canvas, rect };
}

function grayscaleAndContrast(canvas, contrast = 1.6) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const g = clamp((gray - 128) * contrast + 128, 0, 255);
    data[i] = data[i + 1] = data[i + 2] = g;
  }
  ctx.putImageData(imageData, 0, 0);
}

function computeOtsuThreshold(imageData) {
  const hist = new Array(256).fill(0);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    hist[gray]++;
  }

  const total = imageData.width * imageData.height;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let maxVar = -1;
  let threshold = 180;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
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

function applyBinaryThreshold(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : computeOtsuThreshold(imageData);
  const invert = !!opts.invert;
  const soften = opts.soften ? 14 : 0;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const isForeground = gray > threshold;
    const v = (invert ? !isForeground : isForeground) ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }

  if (soften > 0) {
    // 1px程度の軽いぼかしで、ジャギーが強すぎる場合を緩和する。
    ctx.putImageData(imageData, 0, 0);
    ctx.globalAlpha = 0.45;
    ctx.filter = `blur(${soften / 10}px)`;
    ctx.drawImage(canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    return;
  }

  ctx.putImageData(imageData, 0, 0);
}

async function buildCropVariant(imageElement, region, config) {
  const { canvas, rect } = createCropCanvas(imageElement, region, config.scale || 1);
  if (config.preprocess === 'standard') {
    grayscaleAndContrast(canvas, config.contrast || 1.55);
  } else if (config.preprocess === 'binary') {
    applyBinaryThreshold(canvas, { threshold: config.threshold, invert: config.invert, soften: config.soften });
  } else if (config.preprocess === 'binary-strong') {
    grayscaleAndContrast(canvas, config.contrast || 1.8);
    applyBinaryThreshold(canvas, { threshold: config.threshold, invert: config.invert, soften: config.soften });
  }
  const blob = await canvasToBlobPromise(canvas);
  return {
    name: config.name,
    blob,
    previewUrl: config.preview !== false ? canvas.toDataURL('image/png') : null,
    rect,
    scale: config.scale || 1,
    threshold: config.threshold,
    invert: !!config.invert,
  };
}

// 画像の指定範囲(比率 x,y,w,h ∈ [0,1])を切り出してCanvas化する。
// 互換維持のため、従来どおり Blob を返します。
async function cropImage(imageElement, xRatio, yRatio, wRatio, hRatio, type = 'filter-standard') {
  const canvas = document.createElement('canvas');
  const w = imageElement.naturalWidth;
  const h = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');

  if (type === 'threshold-diff') {
    const scale = 1.5;
    canvas.width = w * wRatio * scale;
    canvas.height = h * hRatio * scale;
    ctx.drawImage(imageElement, w * xRatio, h * yRatio, w * wRatio, h * hRatio, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i] = data[i + 1] = data[i + 2] = (gray > 180) ? 0 : 255;
    }
    ctx.putImageData(imageData, 0, 0);
  } else {
    canvas.width = w * wRatio;
    canvas.height = h * hRatio;
    ctx.filter = 'grayscale(100%) contrast(150%)';
    ctx.drawImage(imageElement, w * xRatio, h * yRatio, w * wRatio, h * hRatio, 0, 0, canvas.width, canvas.height);
  }
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// OCRで読み取った文字列から難易度を判定する。
const DIFF_WORD_TO_CODE = { EASY: 'EZ', NORMAL: 'NM', HARD: 'HD', EXPERT: 'EX', MASTER: 'MS', APPEND: 'AP' };

function detectDifficultyCode(diffText) {
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

// 判定内訳のテキストから PERFECT/GREAT/GOOD/BAD/MISS の数値を読み取る。
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

// コンボ数のテキストから最も桁数の多い数値を採用する。
function parseComboText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) { if (m.length > best.length) best = m; }
  return parseInt(best, 10);
}

function cleanOcrText(text) {
  return (text || '').replace(/\r/g, '').trim().replace(/[\t ]+/g, ' ');
}

function isStrongDiffText(text) {
  const cleaned = (text || '').toUpperCase().replace(/[^A-Z]/g, '');
  return Object.keys(DIFF_WORD_TO_CODE).some(word => cleaned.includes(word));
}

function fieldVariantSet(field) {
  switch (field) {
    case 'difficulty':
      return [
        { name: 'diff-strong', preprocess: 'binary-strong', scale: 2.2, threshold: 176, invert: false },
        { name: 'diff-standard', preprocess: 'standard', scale: 2.0 },
        { name: 'diff-invert', preprocess: 'binary', scale: 2.2, threshold: 176, invert: true },
      ];
    case 'title':
      return [
        { name: 'title-standard', preprocess: 'standard', scale: 2.0 },
        { name: 'title-binary', preprocess: 'binary-strong', scale: 2.0, threshold: 182, invert: false },
        { name: 'title-invert', preprocess: 'binary', scale: 2.0, threshold: 182, invert: true },
      ];
    case 'breakdown':
      return [
        { name: 'breakdown-strong', preprocess: 'binary-strong', scale: 2.0, threshold: 178, invert: false },
        { name: 'breakdown-standard', preprocess: 'standard', scale: 1.8 },
        { name: 'breakdown-invert', preprocess: 'binary', scale: 2.0, threshold: 178, invert: true },
      ];
    case 'combo':
      return [
        { name: 'combo-strong', preprocess: 'binary-strong', scale: 2.6, threshold: 180, invert: false },
        { name: 'combo-standard', preprocess: 'standard', scale: 2.2 },
        { name: 'combo-invert', preprocess: 'binary', scale: 2.6, threshold: 180, invert: true },
      ];
    default:
      return [
        { name: 'default-standard', preprocess: 'standard', scale: 2.0 },
        { name: 'default-binary', preprocess: 'binary', scale: 2.0, threshold: 180, invert: false },
      ];
  }
}

async function recognizeVariant(worker, variant, lang) {
  const ret = await worker.recognize(variant.blob, { lang: lang });
  const text = cleanOcrText(ret && ret.data ? ret.data.text : '');
  const confidence = Number(ret && ret.data ? ret.data.confidence : 0) || 0;
  return {
    name: variant.name,
    text,
    confidence,
    previewUrl: variant.previewUrl,
    rect: variant.rect,
    scale: variant.scale,
    threshold: variant.threshold,
    invert: variant.invert,
  };
}

function titleCandidateScore(candidate, variantText, confidence, context) {
  const base = candidate ? candidate.score : 1;
  const confBoost = confidence >= 80 ? -0.14 : confidence >= 60 ? -0.08 : confidence >= 40 ? -0.03 : 0;
  const contextBoost = context && context.totalNotes ? -0.03 : 0;
  return base + confBoost + contextBoost + (variantText ? 0 : 0.12);
}

async function evaluateFieldVariants(worker, imageElement, region, field, lang, options = {}) {
  const variants = fieldVariantSet(field);
  const logs = [];
  let best = null;

  for (let i = 0; i < variants.length; i++) {
    const variantDef = variants[i];
    const built = await buildCropVariant(imageElement, region, { ...variantDef, preview: !!options.collectDebug });
    const ocr = await recognizeVariant(worker, built, lang);
    let parsed = null;
    let score = -ocr.confidence / 100;

    if (field === 'difficulty') {
      const code = detectDifficultyCode(ocr.text);
      parsed = { code, valid: isStrongDiffText(ocr.text) };
      score += parsed.valid ? -0.45 : 0.15;
      score += ocr.text.length > 0 ? -0.05 : 0.2;
    } else if (field === 'breakdown') {
      const breakdown = parseBreakdownText(ocr.text);
      const total = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;
      parsed = { breakdown, total };
      score += total > 0 ? -Math.min(total / 1000, 0.25) : 0.25;
    } else if (field === 'combo') {
      const combo = parseComboText(ocr.text);
      parsed = { combo };
      score += combo > 0 ? -0.2 : 0.2;
    } else if (field === 'title') {
      parsed = { title: ocr.text };
      score += ocr.text ? -0.03 : 0.12;
    }

    const entry = { ...ocr, ...parsed, score, variant: built.name, field };
    logs.push(entry);
    if (!best || entry.score < best.score) best = entry;

    // かなり有力な結果が出たら早めに打ち切る(速度確保)。
    if (field === 'difficulty' && parsed.valid && ocr.confidence >= 72) break;
    if (field === 'combo' && parsed.combo > 0 && ocr.confidence >= 70) break;
    if (field === 'breakdown' && parsed.total > 0 && ocr.confidence >= 60) break;
    if (field === 'title' && ocr.confidence >= 80 && ocr.text.length >= 2) break;
  }

  return { best, logs };
}

function summarizeRegion(imageElement, region) {
  const rect = regionToPixelRect(imageElement, region);
  const naturalW = imageElement.naturalWidth || 0;
  const naturalH = imageElement.naturalHeight || 0;
  return {
    rectPx: rect,
    rectRatio: {
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
    },
    imageSize: { width: naturalW, height: naturalH },
  };
}

async function analyzeLoadedImageDetailed(imgElement, worker, regions, options = {}) {
  const r = regions || DEFAULT_REGIONS;
  const debug = options.collectDebug ? { imageSize: { width: imgElement.naturalWidth, height: imgElement.naturalHeight }, fields: [] } : null;

  try {
    // 難易度
    const diffEval = await evaluateFieldVariants(worker, imgElement, r.difficulty, 'difficulty', 'eng', options);
    const diffResult = diffEval.best || {};
    const diffCode = diffResult.code || detectDifficultyCode(diffResult.text);
    const diffDbKey = getDiffDbKey(diffCode);

    if (debug) {
      debug.fields.push({
        key: 'difficulty',
        label: '難易度',
        summary: summarizeRegion(imgElement, r.difficulty),
        chosen: diffResult,
        variants: diffEval.logs,
      });
    }

    // 曲名
    const titleEval = await evaluateFieldVariants(worker, imgElement, r.title, 'title', 'jpn', options);
    const titleConfidence = titleEval.best ? titleEval.best.confidence : 0;
    const firstTitleText = titleEval.best ? titleEval.best.text : '';
    const initialTitleText = firstTitleText || '';
    const titleMatch = inferMusicByContext(initialTitleText, {
      diffKey: diffDbKey,
      totalNotes: null,
      titleConfidence,
    });
    const titleResult = titleEval.best || {};
    let chosenTitleText = initialTitleText;
    let musicId = null;
    let titleReason = 'ocr-only';

    // OCRがかなり強い場合だけ初回候補を採用し、弱い場合は後段の総ノーツ補正を待つ。
    if (titleMatch.music && titleConfidence >= 70 && titleMatch.score <= 0.45) {
      chosenTitleText = titleMatch.music.title;
      musicId = titleMatch.music.id;
      titleReason = 'title-ocr-strong';
    }

    if (debug) {
      debug.fields.push({
        key: 'title',
        label: '曲名',
        summary: summarizeRegion(imgElement, r.title),
        chosen: {
          ...titleResult,
          matchedMusic: titleMatch.music ? { id: titleMatch.music.id, title: titleMatch.music.title, score: titleMatch.score } : null,
          resolvedText: chosenTitleText,
          reason: titleReason,
        },
        variants: titleEval.logs,
        candidates: titleMatch.candidates || [],
      });
    }

    // 判定内訳
    const breakdownEval = await evaluateFieldVariants(worker, imgElement, r.breakdown, 'breakdown', 'eng', options);
    const breakdownResult = breakdownEval.best || {};
    const breakdown = breakdownResult.breakdown || parseBreakdownText(breakdownResult.text);
    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;

    // 総ノーツ数が分かったので、曲名候補を再評価(曲名が曖昧なケースを補正)。
    const titleMatch2 = inferMusicByContext(initialTitleText || chosenTitleText, {
      diffKey: diffDbKey,
      totalNotes,
      titleConfidence,
    });
    if (titleMatch2.music && (!musicId || titleMatch2.score <= titleMatch.score + 0.08 || titleConfidence < 70)) {
      titleMatch = titleMatch2;
      chosenTitleText = titleMatch2.music.title;
      musicId = titleMatch2.music.id;
      titleReason = 'context-refined';
    } else if (!musicId && titleMatch.music && titleConfidence >= 60) {
      chosenTitleText = titleMatch.music.title;
      musicId = titleMatch.music.id;
      titleReason = 'title-ocr-match';
    }

    const level = musicId ? (getLevelFromDb(musicId, diffDbKey) || '') : '';

    if (debug) {
      debug.fields.push({
        key: 'breakdown',
        label: '判定内訳',
        summary: summarizeRegion(imgElement, r.breakdown),
        chosen: {
          ...breakdownResult,
          breakdown,
          totalNotes,
        },
        variants: breakdownEval.logs,
      });
      debug.summary = {
        diffCode,
        diffLabel: getDiffLabel(diffCode),
        title: chosenTitleText,
        musicId,
        level,
        totalNotes,
        titleReason,
      };
    }

    // コンボ数
    const comboEval = await evaluateFieldVariants(worker, imgElement, r.combo, 'combo', 'eng', options);
    const comboResult = comboEval.best || {};
    const combo = comboResult.combo || parseComboText(comboResult.text);

    if (debug) {
      debug.fields.push({
        key: 'combo',
        label: 'コンボ数',
        summary: summarizeRegion(imgElement, r.combo),
        chosen: {
          ...comboResult,
          combo,
        },
        variants: comboEval.logs,
      });
    }

    return {
      result: {
        title: chosenTitleText,
        level: level,
        diff: diffCode,
        perfect: breakdown.perfect,
        great: breakdown.great,
        good: breakdown.good,
        bad: breakdown.bad,
        miss: breakdown.miss,
        combo: combo,
        musicId: musicId,
      },
      debug,
    };
  } catch (e) {
    console.error(e);
    if (debug) debug.error = String(e && e.message ? e.message : e);
    return { result: null, debug };
  }
}

// 既存呼び出し互換: 結果オブジェクトのみ返す。
async function analyzeLoadedImage(imgElement, worker, regions) {
  const analyzed = await analyzeLoadedImageDetailed(imgElement, worker, regions, { collectDebug: false });
  return analyzed.result;
}
