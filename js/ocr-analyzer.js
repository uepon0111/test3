/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 項目ごとに前処理を切り替え、タイトル/難易度/楽曲Lv/判定内訳/コンボ数を
 * 個別に解析したうえで、曲マスターDBの情報も使って総合的に補正します。
 * -----------------------------------------------------------------------
 */

function imageDataToBinary(imageData, mode, threshold) {
  const data = imageData.data;
  const t = Number.isFinite(threshold) ? threshold : 170;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const v = mode === 'light-on-dark'
      ? (gray > t ? 0 : 255)
      : (gray > t ? 255 : 0);
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return imageData;
}

function computeOtsuThreshold(imageData) {
  const data = imageData.data;
  const hist = new Array(256).fill(0);
  let pixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    hist[gray]++;
    pixels++;
  }
  if (pixels === 0) return 170;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 170;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    wF = pixels - wB;
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

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function cropImage(imageElement, xRatio, yRatio, wRatio, hRatio, preset = 'title', debugStore) {
  const canvas = document.createElement('canvas');
  const srcW = imageElement.naturalWidth;
  const srcH = imageElement.naturalHeight;
  const ctx = canvas.getContext('2d');
  const presetMap = {
    difficulty: { scale: 3.0, mode: 'light-on-dark', threshold: 178, filter: 'grayscale(100%) contrast(260%) brightness(120%)' },
    level:      { scale: 3.5, mode: 'light-on-dark', threshold: 170, filter: 'grayscale(100%) contrast(280%) brightness(120%)' },
    title:      { scale: 2.2, mode: 'dark-on-light',  threshold: 185, filter: 'grayscale(100%) contrast(240%) brightness(110%)' },
    breakdown:  { scale: 3.2, mode: 'light-on-dark',  threshold: 172, filter: 'grayscale(100%) contrast(250%) brightness(125%)' },
    combo:      { scale: 3.0, mode: 'light-on-dark',  threshold: 172, filter: 'grayscale(100%) contrast(250%) brightness(125%)' },
    default:    { scale: 2.0, mode: 'dark-on-light',  threshold: 180, filter: 'grayscale(100%) contrast(220%)' },
  };
  const opt = presetMap[preset] || presetMap.default;

  canvas.width = Math.max(1, Math.round(srcW * wRatio * opt.scale));
  canvas.height = Math.max(1, Math.round(srcH * hRatio * opt.scale));
  ctx.filter = opt.filter;
  ctx.drawImage(imageElement, srcW * xRatio, srcH * yRatio, srcW * wRatio, srcH * hRatio, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const threshold = computeOtsuThreshold(imageData);
  imageDataToBinary(imageData, opt.mode, Number.isFinite(opt.threshold) ? opt.threshold : threshold);
  ctx.putImageData(imageData, 0, 0);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (debugStore) {
    debugStore.cropSize = { width: canvas.width, height: canvas.height };
    debugStore.threshold = Number.isFinite(opt.threshold) ? opt.threshold : threshold;
  }
  return blob;
}

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

function parseLevelText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return '';
  let best = matches[0];
  for (const m of matches) {
    if (m.length > best.length) best = m;
  }
  return String(parseInt(best, 10));
}

async function recognizeField(worker, blob, lang) {
  const ret = await worker.recognize(blob, { lang });
  return {
    text: ret.data && typeof ret.data.text === 'string' ? ret.data.text : '',
    confidence: ret.data && Number.isFinite(ret.data.confidence) ? ret.data.confidence : null,
    raw: ret,
  };
}

async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  try {
    const debug = { fields: {}, summary: {} };

    const diffR = r.difficulty;
    const diffBlob = await cropImage(imgElement, diffR.x, diffR.y, diffR.w, diffR.h, 'difficulty', debug.fields.difficulty = { region: diffR });
    const diffRet = await recognizeField(worker, diffBlob, 'eng');
    const diffCode = detectDifficultyCode(diffRet.text.toUpperCase());
    debug.fields.difficulty.rawText = diffRet.text;
    debug.fields.difficulty.confidence = diffRet.confidence;
    debug.fields.difficulty.parsed = diffCode;
    debug.fields.difficulty.blobUrl = URL.createObjectURL(diffBlob);

    const titleR = r.title;
    const titleDebug = debug.fields.title = { region: titleR };
    const titleBlob = await cropImage(imgElement, titleR.x, titleR.y, titleR.w, titleR.h, 'title', titleDebug);
    const titleRet = await recognizeField(worker, titleBlob, 'jpn');
    debug.fields.title.rawText = titleRet.text;
    debug.fields.title.confidence = titleRet.confidence;
    debug.fields.title.blobUrl = URL.createObjectURL(titleBlob);

    const levelR = r.level || r.difficulty;
    const levelDebug = debug.fields.level = { region: levelR };
    const levelBlob = await cropImage(imgElement, levelR.x, levelR.y, levelR.w, levelR.h, 'level', levelDebug);
    const levelRet = await recognizeField(worker, levelBlob, 'eng');
    const levelText = parseLevelText(levelRet.text);
    debug.fields.level.rawText = levelRet.text;
    debug.fields.level.confidence = levelRet.confidence;
    debug.fields.level.parsed = levelText;
    debug.fields.level.blobUrl = URL.createObjectURL(levelBlob);

    const bdR = r.breakdown;
    const bdDebug = debug.fields.breakdown = { region: bdR };
    const bdBlob = await cropImage(imgElement, bdR.x, bdR.y, bdR.w, bdR.h, 'breakdown', bdDebug);
    const bdRet = await recognizeField(worker, bdBlob, 'jpn');
    const breakdown = parseBreakdownText(bdRet.text);
    debug.fields.breakdown.rawText = bdRet.text;
    debug.fields.breakdown.confidence = bdRet.confidence;
    debug.fields.breakdown.parsed = breakdown;
    debug.fields.breakdown.blobUrl = URL.createObjectURL(bdBlob);

    const totalNotes = breakdown.perfect + breakdown.great + breakdown.good + breakdown.bad + breakdown.miss;

    const cbR = r.combo;
    const cbDebug = debug.fields.combo = { region: cbR };
    const cbBlob = await cropImage(imgElement, cbR.x, cbR.y, cbR.w, cbR.h, 'combo', cbDebug);
    const cbRet = await recognizeField(worker, cbBlob, 'eng');
    let combo = parseComboText(cbRet.text);
    if (Number.isFinite(totalNotes) && totalNotes > 0 && combo > totalNotes) {
      combo = totalNotes;
      debug.fields.combo.correctedBy = 'totalNotes';
    }
    debug.fields.combo.rawText = cbRet.text;
    debug.fields.combo.confidence = cbRet.confidence;
    debug.fields.combo.parsed = combo;
    debug.fields.combo.blobUrl = URL.createObjectURL(cbBlob);

    const titleCandidates = rankMusicCandidates({
      ocrTitle: titleRet.text,
      diffCode,
      levelText,
      totalNotes,
      titleConfidence: titleRet.confidence,
      limit: 8,
    });
    debug.summary.titleCandidates = titleCandidates.map(c => ({
      title: c.music.title,
      score: Math.round(c.score * 100) / 100,
      playLevel: c.playLevel,
      noteCount: c.noteCount,
      reasons: c.reasons,
      id: c.music.id,
    }));

    let matchedMusic = titleCandidates.length > 0 ? titleCandidates[0].music : findBestMatchMusic(titleRet.text);
    const matchedByHints = titleCandidates.length > 0;
    const rawTitleText = titleRet.text.replace(/\r?\n/g, ' ').trim();
    const normalizedTitle = rawTitleText || (matchedMusic ? matchedMusic.title : '');
    let finalTitle = normalizedTitle;
    if (matchedMusic) finalTitle = matchedMusic.title;

    // タイトルOCRの信頼度が低いときは、難易度・レベル・ノーツ数の条件が揃う候補を優先する。
    if (matchedByHints) {
      const best = titleCandidates[0];
      const second = titleCandidates[1];
      const shouldPreferHint =
        titleRet.confidence === null ||
        titleRet.confidence < 70 ||
        (second && (second.score - best.score) > 7) ||
        !rawTitleText ||
        best.score < 45;
      if (shouldPreferHint) {
        finalTitle = best.music.title;
        matchedMusic = best.music;
      }
    }

    const musicId = matchedMusic ? matchedMusic.id : null;
    let level = '';
    if (musicId) {
      const dbKey = getDiffDbKey(diffCode);
      level = getLevelFromDb(musicId, dbKey) || '';
    }
    if (!level && levelText) level = levelText;

    debug.summary.selected = {
      title: finalTitle,
      musicId,
      diff: diffCode,
      level,
      totalNotes,
      combo,
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
      combo: combo,
      musicId: musicId,
      totalNotes,
      debug,
    };
  } catch (e) {
    console.error(e);
    return null;
  }
}
