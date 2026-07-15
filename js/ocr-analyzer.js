/*
 * ocr-analyzer.js
 * -----------------------------------------------------------------------
 * リザルト画像から Tesseract.js (OCR) を使って情報を読み取る処理。
 * 読み取る範囲(座標)は「機種プロファイル」(device-profiles.js)から与えられ、
 * 設定画面で自由に調整できます。
 *
 * 読み取る項目:
 *   - 難易度 (EASY/NORMAL/HARD/EXPERT/MASTER/APPEND)
 *   - 楽曲レベル ※新規追加。「楽曲Lv.APD34」のようなバッジから数値を読み取り、
 *     あわせて英字部分(APD等)から難易度の参考シグナルも取り出す。
 *   - 曲名 (マスターDBとのファジーマッチングは music-db.js / result-reconciler.js 側で行う)
 *   - 判定内訳 (PERFECT/GREAT/GOOD/BAD/MISS)
 *   - コンボ数
 *
 * このファイルの責務は「画像の指定範囲を正しく読み取ってテキスト化する」ことに限定し、
 * 曲名の同定やDBとの突き合わせ・矛盾チェックといった「総合的な判断」は
 * result-reconciler.js に委ねています(関心の分離)。
 *
 * 二値化について:
 *   旧実装は難易度のみ固定しきい値(180)で二値化し、曲名・判定内訳・コンボ数は
 *   グレースケール+コントラスト強調のみ(二値化なし)でした。固定しきい値は
 *   バッジの色によっては(例: HARDの黄色は明度が高く白文字との差が僅かで、しばしば
 *   文字と背景が分離できなくなる)破綻するため、切り出した画像ごとに大津の二値化
 *   (Otsu's method)でしきい値を自動計算するようにしています。
 *
 *   さらに、難易度・楽曲レベルのバッジ(色付き/グラデーション背景+白文字)は、
 *   単純な明度(グレースケール)だけでは背景色によって白文字と分離しきれないことが
 *   実測で分かったため(例: APPENDバッジは紫→ピンクのグラデーションで、明度だけでは
 *   白文字と地の一部が同程度になってしまう)、「明度 − 彩度(色の鮮やかさ)」という
 *   “白さ” を表す値に対して大津の二値化を行っています。白文字は明るく無彩色(彩度が
 *   低い)なので高スコアになり、どんな色のバッジ背景でも安定して分離できます。
 *   曲名・判定内訳・コンボ数は単純な明度ベースの二値化で十分な精度が出ています
 *   (実測して比較のうえ、項目ごとに使い分けています)。
 *
 *   「文字/背景どちらが明側か」は、二値化後に少数派になる側を文字とみなして自動判定
 *   しています(文字は背景より面積が小さいという前提)。切り出し範囲の外周をサンプル
 *   する方式も試しましたが、バッジの角丸部分などが範囲に含まれると誤判定しやすいため
 *   採用していません。
 * -----------------------------------------------------------------------
 */

// Tesseract.js v5 の PSM (Page Segmentation Mode) 定数。
// グローバルの Tesseract.PSM を優先して使い、万一未定義な場合のみ既知の値で代替する。
const PSM = (typeof Tesseract !== 'undefined' && Tesseract.PSM) ? Tesseract.PSM : {
  SINGLE_BLOCK: '6', SINGLE_LINE: '7', SINGLE_WORD: '8', SPARSE_TEXT: '11',
};

// ============================================================
// 大津の二値化 (Otsu's method)
// ============================================================

// ヒストグラム(256階調)から、クラス間分散を最大化するしきい値を求める。
function computeOtsuThreshold(histogram, totalPixels) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = totalPixels - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

// 項目ごとの二値化チャンネル。
//   'luminance' : 単純な明度。曲名(暗文字/明背景)・判定内訳・コンボ数(明文字/暗背景)で使用。
//   'whiteness' : 明度から彩度を引いた「白さ」。難易度・楽曲レベルの色付きバッジ(白文字)で使用。
const BINARIZE_CHANNEL_BY_FIELD = { difficulty: 'whiteness', level: 'whiteness', title: 'luminance', breakdown: 'luminance', combo: 'luminance' };

// canvas(既に切り出し・拡大済み)を項目ごとに適切なチャンネル・向きで二値化する。
// 戻り値はログ表示用のしきい値情報。
function binarizeCanvasInPlace(canvas, ctx, channelType) {
  const w = canvas.width, h = canvas.height;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const channel = new Float64Array(w * h);
  const histogram = new Array(256).fill(0);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    let v = luminance;
    if (channelType === 'whiteness') {
      const chroma = Math.max(r, g, b) - Math.min(r, g, b); // 彩度の簡易指標(0=無彩色)
      v = Math.max(0, Math.min(255, luminance - chroma));
    }
    channel[p] = v;
    histogram[v | 0]++;
  }

  const threshold = computeOtsuThreshold(histogram, w * h);

  // しきい値で2クラスに分け、画素数が少ない側(=面積が小さい側)を文字とみなす。
  // クロップ範囲に多少の余白があっても(角丸バッジの外側など)安定して判定できる。
  let belowCount = 0;
  for (let p = 0; p < channel.length; p++) if (channel[p] < threshold) belowCount++;
  const aboveCount = channel.length - belowCount;
  const textIsBelowThreshold = belowCount <= aboveCount;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const isTextPixel = textIsBelowThreshold ? (channel[p] < threshold) : (channel[p] >= threshold);
    const v = isTextPixel ? 0 : 255; // 文字=黒(0), 背景=白(255) に統一
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return { threshold, channelType, textIsBelowThreshold };
}

// ============================================================
// 画像切り出し
// ============================================================

// 項目ごとの拡大率。文字が小さい/細い項目ほど大きめに拡大してからOCRにかける
// (Tesseract公式ドキュメントでも「十分な解像度が無い場合は拡大すると精度が上がる」と
// 案内されている)。
const UPSCALE_BY_FIELD = { difficulty: 3, level: 3, title: 2.2, breakdown: 2.2, combo: 3 };

// 画像の指定範囲(比率 x,y,w,h ∈ [0,1])を、項目名に応じた倍率で拡大しながら切り出す。
function cropRegionToCanvas(imageElement, region, fieldKey) {
  const w = imageElement.naturalWidth;
  const h = imageElement.naturalHeight;
  const sx = clamp(Math.round(w * region.x), 0, w - 1);
  const sy = clamp(Math.round(h * region.y), 0, h - 1);
  const sw = Math.max(1, Math.round(w * region.w));
  const sh = Math.max(1, Math.round(h * region.h));
  const upscale = UPSCALE_BY_FIELD[fieldKey] || 2.5;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * upscale));
  canvas.height = Math.max(1, Math.round(sh * upscale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imageElement, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx, srcRect: { x: sx, y: sy, w: sw, h: sh } };
}

// 切り出し+二値化をまとめて行い、実測ログに必要な情報一式を返す。
function prepareFieldImage(imageElement, region, fieldKey) {
  const { canvas, ctx, srcRect } = cropRegionToCanvas(imageElement, region, fieldKey);
  const channelType = BINARIZE_CHANNEL_BY_FIELD[fieldKey] || 'luminance';
  const { threshold, textIsBelowThreshold } = binarizeCanvasInPlace(canvas, ctx, channelType);
  return {
    canvas,
    dataUrl: canvas.toDataURL('image/png'),
    regionRatio: region,
    srcRect,
    threshold,
    channelType,
    textIsBelowThreshold,
  };
}

// ============================================================
// Tesseract呼び出し
// ============================================================
// Tesseract.js v5 の worker.recognize() は lang を都度切り替えるオプションを持たない
// (langはcreateWorker時に固定され、recognizeのoptionsは rectangle のみ有効)。
// そのため worker は jpn+eng を読み込んだものを1つ使い回し、項目ごとに
// setParameters() で pageseg_mode と文字ホワイトリストだけを切り替える。
// これにより数字onlyの項目は紛らわしい文字(O/0, l/1, S/5 など)を候補から除外でき、
// 英字onlyの項目は逆に数字を誤読しなくなる。
async function recognizeField(worker, canvas, { whitelist = '', psm = PSM.SINGLE_LINE } = {}) {
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: whitelist,
    });
    const ret = await worker.recognize(canvas);
    return { text: ret.data.text || '', confidence: Math.round(ret.data.confidence || 0), error: null };
  } catch (e) {
    console.error('OCR recognize failed', e);
    return { text: '', confidence: 0, error: String(e && e.message || e) };
  }
}

// ============================================================
// 難易度の判定
// ============================================================
// 完全一致(部分文字列として含む)を優先し、見つからない場合はレーベンシュタイン距離で
// 最も近い難易度名を採用する。matched=false の場合は「完全一致せず推定した」ことを示し、
// 呼び出し側で信頼度判定に使う。
const DIFF_WORD_TO_CODE = { EASY: 'EZ', NORMAL: 'NM', HARD: 'HD', EXPERT: 'EX', MASTER: 'MS', APPEND: 'AP' };
const DIFF_WORDS = Object.keys(DIFF_WORD_TO_CODE);

function detectDifficultyCode(diffText) {
  const cleaned = (diffText || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!cleaned) return { code: null, matched: false, distanceRatio: 1, ocrLetters: '' };

  for (const word of DIFF_WORDS) {
    if (cleaned.includes(word)) {
      return { code: DIFF_WORD_TO_CODE[word], matched: true, distanceRatio: 0, ocrLetters: cleaned };
    }
  }
  let bestWord = 'EXPERT', bestDist = Infinity;
  for (const word of DIFF_WORDS) {
    const dist = levenshtein(cleaned, word) / Math.max(cleaned.length, word.length);
    if (dist < bestDist) { bestDist = dist; bestWord = word; }
  }
  return { code: DIFF_WORD_TO_CODE[bestWord], matched: false, distanceRatio: bestDist, ocrLetters: cleaned };
}

// 「楽曲Lv.APD34」のようなレベルバッジのOCR文字列から、末尾の英字部分(APD等)を
// 抜き出して難易度の参考シグナルとして再利用する(「Lv」自体もA-Z文字なので誤検出
// しないよう、先に除去してから detectDifficultyCode に渡す)。
function parseLevelPillDifficultyHint(rawText) {
  const withoutLv = (rawText || '').toUpperCase().replace(/LV\.?/g, '');
  return detectDifficultyCode(withoutLv);
}

// レベルバッジのOCR文字列から楽曲レベル(数値)を取り出す。最も桁数の多い数字列を採用する
// (末尾に誤認識のノイズ数字が1桁だけ付くことがあるため、単純に最後の数字列を使うより
// 「最も長い数字列」を採用するほうが実測上ロバストだった)。
function parseLevelText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return null;
  let best = matches[0];
  for (const m of matches) { if (m.length > best.length) best = m; }
  const n = parseInt(best, 10);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// 判定内訳・コンボ数の解析
// ============================================================

// 判定内訳のテキストから PERFECT/GREAT/GOOD/BAD/MISS の数値を読み取る。
// found.* は各行が実際に認識できたかどうかのフラグで、呼び出し側の信頼度判定に使う。
function parseBreakdownText(text) {
  const lines = (text || '').split('\n');
  let perfect = 0, great = 0, good = 0, bad = 0, miss = 0;
  const found = { perfect: false, great: false, good: false, bad: false, miss: false };

  const extractTrailingNumber = (line) => {
    const nums = line.match(/\d+/g);
    return nums ? parseInt(nums[nums.length - 1], 10) : null;
  };

  lines.forEach(line => {
    let v;
    if (/PERFECT/i.test(line) && (v = extractTrailingNumber(line)) !== null) { perfect = v; found.perfect = true; }
    if (/GREAT/i.test(line) && (v = extractTrailingNumber(line)) !== null) { great = v; found.great = true; }
    if (/G[O0QD]{2}D/i.test(line) && (v = extractTrailingNumber(line)) !== null) { good = v; found.good = true; }
    if (/BAD/i.test(line) && (v = extractTrailingNumber(line)) !== null) { bad = v; found.bad = true; }
    if (/MISS/i.test(line) && (v = extractTrailingNumber(line)) !== null) { miss = v; found.miss = true; }
  });

  const allFound = found.perfect && found.great && found.good && found.bad && found.miss;
  return { perfect, great, good, bad, miss, found, allFound };
}

// コンボ数のテキストから最も桁数の多い数値を採用する(ラベル文字等の誤検出を避けるため)。
// ambiguous=true は、複数の数字グループが見つかった(=何か余計なものが写り込んでいる
// 可能性がある)ことを示す参考フラグ。
function parseComboText(text) {
  const matches = (text || '').match(/\d+/g);
  if (!matches || matches.length === 0) return { value: 0, ambiguous: false, groups: [] };
  let best = matches[0];
  for (const m of matches) { if (m.length > best.length) best = m; }
  return { value: parseInt(best, 10), ambiguous: matches.length > 1, groups: matches };
}

// ============================================================
// メイン解析処理
// ============================================================

// 画像1枚を解析する。regions には { difficulty, level, title, breakdown, combo }
// (各 {x,y,w,h}) を渡す。戻り値には項目ごとの実測ログ(切り出し範囲・二値化後画像・
// OCR結果・信頼度)を含む debugLog も含まれる。曲名のDB照合や矛盾チェックは行わず、
// 生のOCR結果を返すところまでがこの関数の責務(result-reconciler.js が続きを担う)。
async function analyzeLoadedImage(imgElement, worker, regions) {
  const r = regions || DEFAULT_REGIONS;
  const debugLog = {};

  function logField(key, prep, ocrResult, extra) {
    debugLog[key] = Object.assign({
      regionRatio: prep.regionRatio,
      srcRect: prep.srcRect,
      dataUrl: prep.dataUrl,
      threshold: prep.threshold,
      channelType: prep.channelType,
      textIsBelowThreshold: prep.textIsBelowThreshold,
      ocrText: ocrResult.text.trim(),
      confidence: ocrResult.confidence,
      ocrError: ocrResult.error,
    }, extra || {});
  }

  try {
    // --- 難易度 (例: "APPEND") ---
    const diffPrep = prepareFieldImage(imgElement, r.difficulty, 'difficulty');
    const diffOcr = await recognizeField(worker, diffPrep.canvas, { whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', psm: PSM.SINGLE_LINE });
    const diffDetect = detectDifficultyCode(diffOcr.text.toUpperCase());
    logField('difficulty', diffPrep, diffOcr, { detected: diffDetect });

    // --- 楽曲レベル (新規, 例: "楽曲Lv.APD34") ---
    const levelPrep = prepareFieldImage(imgElement, r.level, 'level');
    const levelOcr = await recognizeField(worker, levelPrep.canvas, { whitelist: '', psm: PSM.SINGLE_LINE });
    const levelValue = parseLevelText(levelOcr.text);
    const levelDiffHint = parseLevelPillDifficultyHint(levelOcr.text);
    logField('level', levelPrep, levelOcr, { value: levelValue, diffHint: levelDiffHint });

    // --- 曲名 ---
    const titlePrep = prepareFieldImage(imgElement, r.title, 'title');
    const titleOcr = await recognizeField(worker, titlePrep.canvas, { whitelist: '', psm: PSM.SINGLE_LINE });
    logField('title', titlePrep, titleOcr, {});

    // --- 判定内訳 (PERFECT/GREAT/GOOD/BAD/MISS) ---
    const bdPrep = prepareFieldImage(imgElement, r.breakdown, 'breakdown');
    const bdOcr = await recognizeField(worker, bdPrep.canvas, { whitelist: '', psm: PSM.SINGLE_BLOCK });
    const breakdown = parseBreakdownText(bdOcr.text);
    logField('breakdown', bdPrep, bdOcr, { parsed: breakdown });

    // --- コンボ数 ---
    const cbPrep = prepareFieldImage(imgElement, r.combo, 'combo');
    const cbOcr = await recognizeField(worker, cbPrep.canvas, { whitelist: '0123456789', psm: PSM.SINGLE_LINE });
    const combo = parseComboText(cbOcr.text);
    logField('combo', cbPrep, cbOcr, { parsed: combo });

    return {
      difficulty: {
        code: diffDetect.code, matched: diffDetect.matched, distanceRatio: diffDetect.distanceRatio,
        confidence: diffOcr.confidence, ocrText: diffOcr.text.trim(),
      },
      level: {
        value: levelValue, confidence: levelOcr.confidence, ocrText: levelOcr.text.trim(), diffHint: levelDiffHint,
      },
      title: { ocrText: titleOcr.text.replace(/\r?\n/g, '').trim(), confidence: titleOcr.confidence },
      breakdown: Object.assign({}, breakdown, { confidence: bdOcr.confidence }),
      combo: Object.assign({}, combo, { confidence: cbOcr.confidence }),
      debugLog,
    };
  } catch (e) {
    console.error('analyzeLoadedImage failed', e);
    return null;
  }
}
