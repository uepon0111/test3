/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 画面ごとに最適な前処理をかけ、OCR結果とマスターDB情報を突き合わせて
 * 最終結果を補正します。
 * -----------------------------------------------------------------------
 */

const OCR_PRESETS = {
  difficulty: [
    { name: 'diff-strong', scale: 3.5, contrast: 240, brightness: 1.05, threshold: 165, invert: 'auto', sharpen: false },
    { name: 'diff-soft',   scale: 3.0, contrast: 210, brightness: 1.00, threshold: 185, invert: 'auto', sharpen: false },
  ],
  title: [
    { name: 'title-strong', scale: 2.6, contrast: 200, brightness: 1.00, threshold: 178, invert: 'auto', sharpen: false },
    { name: 'title-soft',   scale: 2.0, contrast: 170, brightness: 1.02, threshold: null, invert: 'auto', sharpen: false },
  ],
  breakdown: [
    { name: 'breakdown-strong', scale: 3.2, contrast: 230, brightness: 1.00, threshold: 168, invert: 'auto', sharpen: false },
    { name: 'breakdown-soft',   scale: 2.5, contrast: 200, brightness: 1.00, threshold: 185, invert: 'auto', sharpen: false },
  ],
  combo: [
    { name: 'combo-strong', scale: 4.0, contrast: 250, brightness: 1.00, threshold: 170, invert: 'auto', sharpen: false },
    { name: 'combo-soft',   scale: 3.0, contrast: 220, brightness: 1.00, threshold: 188, invert: 'auto', sharpen: false },
  ],
};

function clampRegion(region) {
  const r = region || DEFAULT_REGIONS.difficulty;
  const x = clamp(r.x ?? 0, 0, 1);
  const y = clamp(r.y ?? 0, 0, 1);
  const w = clamp(r.w ?? 0, 0.001, 1 - x);
  const h = clamp(r.h ?? 0, 0.001, 1 - y);
  return { x, y, w, h };
}

function getCropCanvas(imageElement, region, preset) {
  const r = clampRegion(region);
  const imgW = imageElement.naturalWidth || imageElement.width || 0;
  const imgH = imageElement.naturalHeight || imageElement.height || 0;
  const scale = Math.max(1, preset?.scale || 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(imgW * r.w * scale));
  canvas.height = Math.max(1, Math.round(imgH * r.h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (!ctx) {
    throw new Error('Canvas context not available');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = `grayscale(100%) contrast(${preset?.contrast ?? 150}%) brightness(${Math.round((preset?.brightness ?? 1) * 100)}%)`;
  ctx.drawImage(
    imageElement,
    Math.round(imgW * r.x),
    Math.round(imgH * r.y),
    Math.max(1, Math.round(imgW * r.w)),
    Math.max(1, Math.round(imgH * r.h)),
    0,
    0,
    canvas.width,
    canvas.height
  );
  ctx.filter = 'none';

  return { canvas, ctx };
}

function getAverageLuminance(imageData) {
  const data = imageData.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  return count > 0 ? sum / count : 255;
}

function binarizeCanvas(canvas, ctx, preset) {
  if (!preset || preset.threshold === null || preset.threshold === undefined) return;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const avg = getAverageLuminance(imageData);
  const autoInvert = preset.invert === 'auto' ? (avg < 140) : !!preset.invert;
  const threshold = preset.threshold;

  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const isDark = gray < threshold;
    const value = autoInvert ? (isDark ? 255 : 0) : (isDark ? 0 : 255);
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

async function preprocessRegionToBlob(imageElement, region, preset) {
  const { canvas, ctx } = getCropCanvas(imageElement, region, preset);
  binarizeCanvas(canvas, ctx, preset);
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function normalizeOcrTextForField(text) {
  return (text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n');
}

function extractConfidence(data) {
  if (!data) return 0;
  const c = Number.isFinite(data.confidence) ? data.confidence : null;
  if (c !== null) return c;
  const words = Array.isArray(data.words) ? data.words : [];
  if (words.length === 0) return 0;
  const confs = words
    .map(w => Number(w.confidence))
    .filter(v => Number.isFinite(v));
  if (confs.length === 0) return 0;
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

function cleanupOcrText(text) {
  return normalizeOcrTextForField(text)
    .replace(/[｜|]/g, '')
    .replace(/[“”"']/g, '')
    .trim();
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

function parseBreakdownText(text) {
  const lines = normalizeOcrTextForField(text).split('\n');
  let perfect = 0, great = 0, good = 0, bad = 0, miss = 0;

  const parseLine = (line, regex) => {
    if (regex.test(line)) {
      const nums = line.match(/\d+/g);
      if (nums) return parseInt(nums[nums.length - 1], 10);
    }
    return 0;
  };

  lines.forEach(line => {
    const upper = line.toUpperCase().replace(/O/g, '0');
    if (/PERFECT/.test(upper)) perfect = parseLine(upper, /PERFECT/);
    if (/GREAT/.test(upper)) great = parseLine(upper, /GREAT/);
    if (/(GOOD|G00D|GO0D)/.test(upper)) good = parseLine(upper, /(GOOD|G00D|GO0D)/);
    if (/BAD/.test(upper)) bad = parseLine(upper, /BAD/);
    if (/MISS/.test(upper)) miss = parseLine(upper, /MISS/);
  });
  return { perfect, great, good, bad, miss };
}

function parseComboText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return 0;
  let best = matches[0];
  for (const m of matches) {
    if (m.length > best.length) best = m;
  }
  return parseInt(best, 10);
}

function scoreDiffCandidate(text, confidence) {
  const normalized = (text || '').toUpperCase().replace(/[^A-Z]/g, '');
  const direct = detectDifficultyCode(normalized);
  const directLabel = getDiffLabel(direct);
  const hasExact = Object.keys(DIFF_WORD_TO_CODE).some(word => normalized.includes(word));
  let score = 0;
  if (!hasExact) {
    const bestWord = Object.keys(DIFF_WORD_TO_CODE).reduce((acc, word) => {
      const dist = levenshtein(normalized, word) / Math.max(normalized.length || 1, word.length);
      return dist < acc.dist ? { word, dist } : acc;
    }, { word: 'EXPERT', dist: Infinity });
    score += bestWord.dist;
  }
  score += Math.max(0, (60 - (confidence || 0)) / 100);
  return { code: direct, label: directLabel, score };
}

async function recognizeVariant(worker, imageElement, region, preset, lang) {
  const blob = await preprocessRegionToBlob(imageElement, region, preset);
  if (!blob) throw new Error('OCR前処理に失敗しました');
  const result = await worker.recognize(blob, { lang });
  const text = result?.data?.text || '';
  const confidence = extractConfidence(result?.data);
  return {
    preset: preset.name,
    lang,
    text,
    cleanedText: cleanupOcrText(text),
    confidence,
    previewUrl: URL.createObjectURL(blob),
  };
}

async function recognizeRegionWithPresets(worker, imageElement, region, presets, lang) {
  const results = [];
  for (const preset of presets) {
    try {
      results.push(await recognizeVariant(worker, imageElement, region, preset, lang));
    } catch (e) {
      console.error('OCR variant failed', preset?.name, e);
      results.push({
        preset: preset.name,
        lang,
        text: '',
        cleanedText: '',
        confidence: 0,
        previewUrl: '',
        error: String(e?.message || e),
      });
    }
  }
  return results;
}

function pickBestDifficulty(diffResults) {
  let best = null;
  for (const r of diffResults) {
    const scored = scoreDiffCandidate(r.cleanedText || r.text, r.confidence);
    const score = scored.score - (r.confidence || 0) / 300;
    const candidate = { ...r, code: scored.code, label: scored.label, score };
    if (!best || candidate.score < best.score) best = candidate;
  }
  if (!best) return { code: 'EX', result: null, results: diffResults };
  return { code: best.code || 'EX', result: best, results: diffResults };
}

function buildTitleCandidateList(titleResults) {
  const list = [];
  for (const r of titleResults) {
    const cleaned = cleanupOcrText(r.cleanedText || r.text);
    if (cleaned) list.push({ ...r, candidateText: cleaned });
  }
  return list;
}

function resolveTitleFromCandidates(titleResults, diffCode, totalNotes, levelHint) {
  const candidates = buildTitleCandidateList(titleResults);
  const dbKey = getDiffDbKey(diffCode);
  const scored = [];

  for (const c of candidates) {
    const contextMatch = findBestMatchMusicByContext({
      ocrText: c.candidateText,
      diffKey: dbKey,
      totalNotes,
      levelHint,
    });
    const directMatch = findBestMatchMusic(c.candidateText);
    const contextMusic = contextMatch?.music || null;
    const directMusic = directMatch || null;
    const chosenMusic = contextMusic || directMusic || null;
    if (!chosenMusic) continue;

    const titleScore = contextMatch?.titleScore ?? scoreTitleAgainstMusicTitle(c.candidateText, chosenMusic.title);
    const ocrPenalty = Math.max(0, (55 - (c.confidence || 0)) / 100);
    const notePenalty = contextMatch?.noteDelta !== null && contextMatch?.noteDelta !== undefined
      ? Math.min(contextMatch.noteDelta / 100, 2.0)
      : 0;
    const finalScore = (1 - titleScore) * 2.2 + ocrPenalty + notePenalty + (contextMatch?.score || 0) * 0.15;
    scored.push({
      music: chosenMusic,
      musicId: chosenMusic.id,
      title: chosenMusic.title,
      candidateText: c.candidateText,
      confidence: c.confidence,
      score: finalScore,
      reason: contextMatch?.reason || 'ocr',
      previewUrl: c.previewUrl,
      preset: c.preset,
      titleScore,
      noteDelta: contextMatch?.noteDelta ?? null,
      allCandidates: contextMatch?.candidates || [],
    });
  }

  if (scored.length > 0) {
    scored.sort((a, b) => a.score - b.score || b.confidence - a.confidence);
    return scored[0];
  }

  const fallbackText = candidates[0]?.candidateText || '';
  return {
    music: null,
    musicId: null,
    title: fallbackText,
    candidateText: fallbackText,
    confidence: candidates[0]?.confidence || 0,
    score: 999,
    reason: 'raw',
    previewUrl: candidates[0]?.previewUrl || '',
    preset: candidates[0]?.preset || '',
    titleScore: 0,
    noteDelta: null,
    allCandidates: [],
  };
}

function clampComboToNotes(combo, totalNotes) {
  if (!Number.isFinite(combo) || combo < 0) return 0;
  if (Number.isFinite(totalNotes) && totalNotes > 0 && combo > totalNotes) return totalNotes;
  return combo;
}

async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  const debug = {
    image: {
      naturalWidth: imgElement.naturalWidth || 0,
      naturalHeight: imgElement.naturalHeight || 0,
    },
    regions: {},
  };

  try {
    const diffR = clampRegion(r.difficulty);
    const titleR = clampRegion(r.title);
    const bdR = clampRegion(r.breakdown);
    const cbR = clampRegion(r.combo);

    const diffResults = await recognizeRegionWithPresets(worker, imgElement, diffR, OCR_PRESETS.difficulty, 'eng');
    const diffPick = pickBestDifficulty(diffResults);
    const diffCode = diffPick.code || 'EX';
    const dbKey = getDiffDbKey(diffCode);

    debug.regions.difficulty = {
      region: diffR,
      selected: diffPick.result ? {
        preset: diffPick.result.preset,
        text: diffPick.result.text,
        cleanedText: diffPick.result.cleanedText,
        confidence: diffPick.result.confidence,
        previewUrl: diffPick.result.previewUrl,
      } : null,
      variants: diffResults.map(r => ({
        preset: r.preset, text: r.text, cleanedText: r.cleanedText, confidence: r.confidence, previewUrl: r.previewUrl, error: r.error || null,
      })),
      final: diffCode,
    };

    const titleResults = await recognizeRegionWithPresets(worker, imgElement, titleR, OCR_PRESETS.title, 'jpn');

    const bdResults = await recognizeRegionWithPresets(worker, imgElement, bdR, OCR_PRESETS.breakdown, 'jpn');
    const bestBreakdown = bdResults.reduce((best, cur) => {
      const quality = (cur.confidence || 0) + (cur.cleanedText ? 10 : 0);
      if (!best || quality > best.quality) return { ...cur, quality };
      return best;
    }, null);
    const breakdown = parseBreakdownText(bestBreakdown?.cleanedText || bestBreakdown?.text || '');
    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;

    const cbResults = await recognizeRegionWithPresets(worker, imgElement, cbR, OCR_PRESETS.combo, 'eng');
    const bestCombo = cbResults.reduce((best, cur) => {
      const quality = (cur.confidence || 0) + (cur.cleanedText ? 10 : 0);
      if (!best || quality > best.quality) return { ...cur, quality };
      return best;
    }, null);
    const rawCombo = parseComboText(bestCombo?.cleanedText || bestCombo?.text || '');
    const combo = clampComboToNotes(rawCombo, totalNotes);

    const titlePick = resolveTitleFromCandidates(titleResults, diffCode, totalNotes, '');
    const musicId = titlePick.musicId || null;
    const finalTitle = titlePick.music ? titlePick.music.title : (titlePick.title || '');

    let level = '';
    if (musicId && dbKey) {
      level = getLevelFromDb(musicId, dbKey) || '';
    }

    debug.regions.title = {
      region: titleR,
      selected: {
        preset: titlePick.preset,
        text: titlePick.candidateText,
        confidence: titlePick.confidence,
        previewUrl: titlePick.previewUrl,
        titleScore: titlePick.titleScore,
        reason: titlePick.reason,
      },
      variants: titleResults.map(r => ({
        preset: r.preset, text: r.text, cleanedText: r.cleanedText, confidence: r.confidence, previewUrl: r.previewUrl, error: r.error || null,
      })),
      final: {
        title: finalTitle,
        musicId,
      },
    };

    debug.regions.breakdown = {
      region: bdR,
      selected: {
        preset: bestBreakdown?.preset || '',
        text: bestBreakdown?.text || '',
        cleanedText: bestBreakdown?.cleanedText || '',
        confidence: bestBreakdown?.confidence || 0,
        previewUrl: bestBreakdown?.previewUrl || '',
      },
      variants: bdResults.map(r => ({
        preset: r.preset, text: r.text, cleanedText: r.cleanedText, confidence: r.confidence, previewUrl: r.previewUrl, error: r.error || null,
      })),
      parsed: breakdown,
      totalNotes,
    };

    debug.regions.combo = {
      region: cbR,
      selected: {
        preset: bestCombo?.preset || '',
        text: bestCombo?.text || '',
        cleanedText: bestCombo?.cleanedText || '',
        confidence: bestCombo?.confidence || 0,
        previewUrl: bestCombo?.previewUrl || '',
      },
      variants: cbResults.map(r => ({
        preset: r.preset, text: r.text, cleanedText: r.cleanedText, confidence: r.confidence, previewUrl: r.previewUrl, error: r.error || null,
      })),
      rawCombo,
      finalCombo: combo,
      corrected: rawCombo !== combo,
    };

    debug.summary = {
      diffCode,
      level,
      title: finalTitle,
      musicId,
      totalNotes,
      rawCombo,
      combo,
      breakdown,
    };

    return {
      title: finalTitle,
      level: level,
      diff: diffCode,
      perfect: breakdown.perfect,
      great: breakdown.great,
      good: breakdown.good,
      bad: breakdown.bad,
      miss: breakdown.miss,
      totalNotes,
      combo,
      musicId,
      debug,
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}
