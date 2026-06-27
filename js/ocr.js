/**
 * ocr.js — 画像OCR処理（Tesseract.js + canvas 領域抽出）
 */
const OCR = (() => {
  let _worker = null;
  let _workerReady = false;
  let _initPromise = null;

  /** Initialize Tesseract worker */
  async function initWorker() {
    if (_workerReady) return;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      try {
        _worker = await Tesseract.createWorker(['eng', 'jpn'], 1, {
          logger: () => {},
          errorHandler: () => {},
        });
        _workerReady = true;
      } catch (e) {
        // Try English only if Japanese fails to load
        try {
          _worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
          _workerReady = true;
        } catch(e2) {
          console.warn('Tesseract init failed:', e2);
        }
      }
    })();
    return _initPromise;
  }

  /** Preprocess canvas region for better OCR */
  function preprocessRegion(srcCanvas, x, y, w, h) {
    const out = document.createElement('canvas');
    const scale = 3; // upscale for better OCR
    out.width  = w * scale;
    out.height = h * scale;
    const ctx = out.getContext('2d');

    // Draw upscaled region
    ctx.drawImage(srcCanvas, x, y, w, h, 0, 0, w * scale, h * scale);

    // Convert to grayscale + increase contrast
    const imgData = ctx.getImageData(0, 0, out.width, out.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      // Grayscale
      const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      // Increase contrast
      const c = ((g - 128) * 1.8 + 128);
      const v = Math.min(255, Math.max(0, c));
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    return out;
  }

  /** Run Tesseract on a canvas */
  async function recognizeCanvas(canvas, psm = 6) {
    if (!_workerReady) await initWorker();
    if (!_worker) return '';
    try {
      await _worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await _worker.recognize(canvas);
      return data.text || '';
    } catch (e) {
      console.warn('OCR error:', e);
      return '';
    }
  }

  /** Draw region overlays on a canvas */
  function drawRegionOverlays(ctx, regions, imgW, imgH) {
    const colors = CONFIG.REGION_COLORS;
    const labels = {
      title:      'タイトル',
      difficulty: '難易度',
      level:      'レベル',
      result:     'リザルト',
      combo:      'コンボ',
    };

    ctx.save();
    ctx.lineWidth = 3;
    ctx.font = 'bold 14px sans-serif';

    for (const [key, reg] of Object.entries(regions)) {
      const px = reg.x * imgW, py = reg.y * imgH;
      const pw = reg.w * imgW, ph = reg.h * imgH;
      const color = colors[key] || '#ffffff';

      ctx.strokeStyle = color;
      ctx.fillStyle   = color + '22';
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillRect(px, py, pw, ph);

      // Label
      ctx.fillStyle = color;
      ctx.fillRect(px, py - 20, ctx.measureText(labels[key] || key).width + 8, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(labels[key] || key, px + 4, py - 4);
    }
    ctx.restore();
  }

  /** Load image onto a canvas and return canvas + context */
  function imageToCanvas(imgElement) {
    const c   = document.createElement('canvas');
    c.width   = imgElement.naturalWidth  || imgElement.width;
    c.height  = imgElement.naturalHeight || imgElement.height;
    c.getContext('2d').drawImage(imgElement, 0, 0);
    return c;
  }

  /** Extract region canvas from a source canvas */
  function extractRegion(srcCanvas, reg) {
    const x = Math.floor(reg.x * srcCanvas.width);
    const y = Math.floor(reg.y * srcCanvas.height);
    const w = Math.ceil(reg.w  * srcCanvas.width);
    const h = Math.ceil(reg.h  * srcCanvas.height);
    return preprocessRegion(srcCanvas, x, y, w, h);
  }

  /** Parse result numbers from OCR text */
  function parseResultText(text) {
    const clean = text.replace(/[Oo]/g, '0').replace(/[Il|]/g,'1').replace(/\s+/g,' ');
    const grab = (pat) => {
      const m = clean.match(pat);
      return m ? parseInt(m[1]) : null;
    };
    return {
      perfect: grab(/PERFECT\s*[:\-]?\s*(\d+)/i),
      great:   grab(/GREAT\s*[:\-]?\s*(\d+)/i),
      good:    grab(/GOOD\s*[:\-]?\s*(\d+)/i),
      bad:     grab(/BAD\s*[:\-]?\s*(\d+)/i),
      miss:    grab(/MISS\s*[:\-]?\s*(\d+)/i),
    };
  }

  /** Parse combo text */
  function parseComboText(text) {
    const clean = text.replace(/[Oo]/g,'0');
    const m = clean.match(/COMBO\s*[:\-]?\s*(\d+)/i)
           || clean.match(/(\d{3,})/);
    return m ? parseInt(m[1]) : null;
  }

  /** Parse level text (楽曲Lv.APDxx or 楽曲Lv.xx) */
  function parseLevelText(text) {
    const m = text.match(/Lv\.?(?:APD)?\s*(\d+)/i)
           || text.match(/(\d{2})/);
    return m ? parseInt(m[1]) : null;
  }

  /** Parse difficulty from text */
  function parseDifficultyText(text) {
    const up = text.toUpperCase();
    for (const d of CONFIG.DIFFICULTY_ORDER) {
      if (up.includes(d)) return d;
    }
    return null;
  }

  /** Main: analyze a result image */
  async function analyzeImage(imgElement, regions) {
    await initWorker();
    const canvas = imageToCanvas(imgElement);

    // Title
    const titleCanvas = extractRegion(canvas, regions.title);
    const titleText   = await recognizeCanvas(titleCanvas, 6);

    // Level
    const levelCanvas = extractRegion(canvas, regions.level);
    const levelText   = await recognizeCanvas(levelCanvas, 7);

    // Difficulty
    const diffCanvas  = extractRegion(canvas, regions.difficulty);
    const diffText    = await recognizeCanvas(diffCanvas, 7);

    // Result
    const resultCanvas = extractRegion(canvas, regions.result);
    const resultText   = await recognizeCanvas(resultCanvas, 6);

    // Combo
    const comboCanvas = extractRegion(canvas, regions.combo);
    const comboText   = await recognizeCanvas(comboCanvas, 7);

    const parsed = {
      titleRaw:   titleText.trim(),
      level:      parseLevelText(levelText),
      difficulty: parseDifficultyText(diffText + ' ' + levelText),
      ...parseResultText(resultText),
      combo:      parseComboText(comboText),
    };

    return parsed;
  }

  /** Use Claude API for OCR (if API key configured) */
  async function analyzeWithClaude(imageBlob, apiKey) {
    const base64 = await blobToBase64(imageBlob);
    const dataUrl = base64;
    const b64data = base64.split(',')[1];
    const mimeType = imageBlob.type || 'image/png';

    const prompt = `このプロジェクトセカイのリザルト画像から以下の情報を読み取り、JSONで返してください。
フィールド: title(タイトル), pronunciation(読み方), level(楽曲レベル数字), difficulty(EASY/NORMAL/HARD/EXPERT/MASTER/APPENDのいずれか), perfect, great, good, bad, miss, combo
注意: 数字は先頭のゼロを除いた整数で返してください。JSONのみ出力してください。`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64data } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Claude response parse error');
    return JSON.parse(json);
  }

  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  return {
    initWorker, analyzeImage, analyzeWithClaude,
    drawRegionOverlays, imageToCanvas, extractRegion, blobToBase64,
    parseResultText, parseLevelText, parseDifficultyText, parseComboText,
  };
})();
