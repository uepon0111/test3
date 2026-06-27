/**
 * upload.js — アップロード・登録ワークフロー
 */
const Upload = (() => {
  let _step         = 0;
  let _method       = 'auto';   // 'auto' | 'manual'
  let _files        = [];
  let _currentFile  = 0;
  let _ocrResults   = [];       // per-file OCR results
  let _confirmed    = [];       // confirmed entries
  let _profileId    = null;
  let _imgElement   = null;
  let _ocrCanvas    = null;

  /** Open upload modal */
  async function open() {
    reset();
    // Populate device select
    const sel = document.getElementById('upload-device-select');
    if (sel) {
      const profiles = await DB.getAllDeviceProfiles();
      sel.innerHTML = `<option value="">標準設定（デフォルト）</option>` +
        profiles.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`).join('');
    }
    document.getElementById('upload-modal').classList.remove('hidden');
    showStep(1);
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /** Reset state */
  function reset() {
    _step = 0; _method = 'auto'; _files = []; _currentFile = 0;
    _ocrResults = []; _confirmed = [];
    const fi = document.getElementById('file-input');
    if (fi) fi.value = '';
    const prev = document.getElementById('upload-preview');
    if (prev) { prev.innerHTML = ''; prev.classList.add('hidden'); }
    const ocrPrev = document.getElementById('ocr-preview');
    if (ocrPrev) ocrPrev.innerHTML = '';
    const step4 = document.getElementById('upload-step-4');
    if (step4) step4.innerHTML = '';
    document.querySelectorAll('.method-card').forEach(c => c.classList.remove('selected'));
  }

  /** Navigate steps */
  function showStep(n) {
    _step = n;
    document.querySelectorAll('.upload-step').forEach((el, i) => {
      el.classList.toggle('hidden', i + 1 !== n);
    });
    const backBtn   = document.getElementById('upload-back-btn');
    const nextBtn   = document.getElementById('upload-next-btn');
    const submitBtn = document.getElementById('upload-submit-btn');

    // Back: visible from step 2 onwards
    backBtn?.classList.toggle('hidden', n <= 1);
    // Next: visible only at step 2 (for auto: step 3 shows submit via OCR result)
    nextBtn?.classList.toggle('hidden', n !== 2);
    // Submit: hidden until OCR completes (auto) or step 4 shown (manual)
    if (n < 4 && n !== 3) submitBtn?.classList.add('hidden');
    if (n === 4)           submitBtn?.classList.remove('hidden');
    // Step 3: OCR runs async, submit shows via renderOCRResults
  }

  /** Method selection */
  function selectMethod(method) {
    _method = method;
    document.querySelectorAll('.method-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.method === method);
    });
  }

  /** Preview selected files */
  function previewFiles(files) {
    _files = Array.from(files);
    const previewEl = document.getElementById('upload-preview');
    previewEl.classList.remove('hidden');
    previewEl.innerHTML = _files.map((f, i) => `
      <div class="preview-item">
        <img src="${URL.createObjectURL(f)}" alt="preview ${i+1}" class="preview-thumb">
        <span class="preview-name">${f.name}</span>
        <button class="preview-remove icon-btn" data-idx="${i}">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
    `).join('');

    previewEl.querySelectorAll('.preview-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        _files.splice(parseInt(btn.dataset.idx), 1);
        previewFiles(_files); // re-render
      });
    });
  }

  /** Run OCR on all files */
  async function startOCR() {
    const container = document.getElementById('ocr-preview');
    if (!container) return;
    container.innerHTML = '<div class="ocr-loading"><div class="spinner"></div><p>画像を解析中…しばらくお待ちください</p></div>';
    // Show submit button now (will be updated after OCR)
    document.getElementById('upload-submit-btn')?.classList.add('hidden');

    const engine     = await DB.getSetting('ocr_engine') || 'tesseract';
    const apiKey     = await DB.getSetting('anthropic_api_key') || '';
    const profileId  = document.getElementById('upload-device-select')?.value || null;
    const regions    = await Settings.getActiveRegions(profileId);

    _ocrResults = [];

    for (let i = 0; i < _files.length; i++) {
      const file = _files[i];
      try {
        let parsed;
        if (engine === 'anthropic' && apiKey) {
          parsed = await OCR.analyzeWithClaude(file, apiKey);
        } else {
          const img = await fileToImage(file);
          _imgElement = img;
          parsed = await OCR.analyzeImage(img, regions);
        }

        // Find best title match
        const { music, score } = await MusicAPI.findBestMatch(parsed.titleRaw || parsed.title || '');

        let diffEntry = null, validated = false;
        let retried = false;

        if (music) {
          parsed.musicId       = music.id;
          parsed.title         = music.title;
          parsed.pronunciation = music.pronunciation || '';

          // Validate level + difficulty
          diffEntry = await MusicAPI.getDifficultyEntry(music.id, parsed.difficulty);
          if (diffEntry) {
            if (diffEntry.playLevel !== parsed.level) {
              // Mismatch — retry once
              if (!retried) {
                retried = true;
                // Force re-parse level from diffEntry if we trust the title+difficulty match
                if (parsed.difficulty) parsed.level = diffEntry.playLevel;
              }
            }
            validated = true;
            parsed.totalNoteCount = diffEntry.totalNoteCount;
          }
        }

        // Validate note sum
        const sum = (parsed.perfect||0)+(parsed.great||0)+(parsed.good||0)+(parsed.bad||0)+(parsed.miss||0);
        const notesMismatch = parsed.totalNoteCount && sum !== parsed.totalNoteCount;
        if (notesMismatch && !retried) {
          // Flag for manual review
          parsed._notesMismatch = true;
        }

        _ocrResults.push({
          file, parsed,
          music,
          diffEntry,
          validated,
          titleConfidence: score <= 3 ? 'high' : score <= 8 ? 'medium' : 'low',
          needsReview: !validated || (score > 3) || parsed._notesMismatch,
        });

      } catch(e) {
        _ocrResults.push({ file, parsed: {}, error: e.message, needsReview: true });
      }
    }

    renderOCRResults();
  }

  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload  = () => res(img);
      img.onerror = rej;
      img.src     = url;
    });
  }

  /** Render OCR results for review */
  function renderOCRResults() {
    const container = document.getElementById('ocr-preview');
    if (!container) return;

    if (_ocrResults.length === 0) {
      container.innerHTML = '<p class="text-muted">ファイルが選択されていません</p>';
      return;
    }

    container.innerHTML = _ocrResults.map((res, i) => {
      const p = res.parsed || {};
      const hasMismatch = res.needsReview || res.error;
      return `
      <div class="ocr-result-card ${hasMismatch ? 'needs-review' : 'validated'}" data-idx="${i}">
        <div class="ocr-result-header">
          <span class="material-symbols-outlined">${hasMismatch ? 'warning' : 'check_circle'}</span>
          <strong>${res.file?.name || ''}</strong>
          ${hasMismatch ? '<span class="badge badge-warning">要確認</span>' : '<span class="badge badge-success">自動認識</span>'}
        </div>
        <div class="ocr-image-wrap">
          <canvas class="ocr-region-canvas" id="ocr-canvas-${i}"></canvas>
        </div>
        <div class="ocr-fields">
          ${renderOCRField('title',   'タイトル',   p.title || '', i)}
          ${renderOCRField('pronunciation', '読み方', p.pronunciation || '', i)}
          <div class="ocr-row">
            ${renderOCRField('difficulty', '難易度', p.difficulty || '', i, 'difficulty-select')}
            ${renderOCRField('level',      'レベル',  p.level || '', i, 'number')}
          </div>
          <div class="ocr-row">
            ${renderOCRField('perfect', 'PERFECT', p.perfect ?? '', i, 'number')}
            ${renderOCRField('great',   'GREAT',   p.great   ?? '', i, 'number')}
            ${renderOCRField('good',    'GOOD',    p.good    ?? '', i, 'number')}
            ${renderOCRField('bad',     'BAD',     p.bad     ?? '', i, 'number')}
            ${renderOCRField('miss',    'MISS',    p.miss    ?? '', i, 'number')}
          </div>
          ${renderOCRField('combo', 'COMBO', p.combo ?? '', i, 'number')}
          ${res.error ? `<p class="error-msg"><span class="material-symbols-outlined">error</span>エラー: ${res.error}</p>` : ''}
          ${res.parsed?._notesMismatch ? '<p class="warning-msg"><span class="material-symbols-outlined">warning</span>ノーツ数が一致しません。値を確認してください。</p>' : ''}
        </div>
      </div>`;
    }).join('');

    // Draw region canvases
    _ocrResults.forEach(async (res, i) => {
      const c  = document.getElementById(`ocr-canvas-${i}`);
      if (!c || !res.file) return;
      const img = await fileToImage(res.file);
      const maxW = c.parentElement.clientWidth || 320;
      const scale = Math.min(1, maxW / img.width);
      c.width  = img.width  * scale;
      c.height = img.height * scale;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const profileId = await DB.getSetting('selected_device_profile');
      const regions   = await Settings.getActiveRegions(profileId);
      OCR.drawRegionOverlays(ctx, regions, c.width, c.height);
    });

    // Auto-advance to confirm form
    document.getElementById('upload-next-btn')?.classList.add('hidden');
    const submitBtn = document.getElementById('upload-submit-btn');
    if (submitBtn) {
      submitBtn.classList.remove('hidden');
      submitBtn.innerHTML = '<span class="material-symbols-outlined">check</span>登録する';
    }
  }

  function renderOCRField(name, label, value, idx, type = 'text') {
    if (type === 'difficulty-select') {
      return `
        <div class="form-group">
          <label>${label}</label>
          <select name="${name}" data-idx="${idx}" class="form-control ocr-field">
            ${CONFIG.DIFFICULTY_ORDER.map(d =>
              `<option value="${d}" ${d === value ? 'selected' : ''}>${d}</option>`
            ).join('')}
          </select>
        </div>`;
    }
    return `
      <div class="form-group">
        <label>${label}</label>
        <input type="${type}" name="${name}" data-idx="${idx}" value="${value}" class="form-control ocr-field" min="0">
      </div>`;
  }

  /** Render manual entry form */
  function renderManualForm() {
    const container = document.getElementById('upload-step-4');
    if (!container) return;
    container.innerHTML = `
      <div class="manual-form-grid">
        ${_files.map((f, i) => `
          <div class="manual-entry-card">
            <img src="${URL.createObjectURL(f)}" alt="preview" class="manual-preview-img">
            <div class="manual-fields">
              <div class="form-group">
                <label>タイトル</label>
                <input type="text" class="form-control" name="title" data-idx="${i}" placeholder="楽曲タイトル">
              </div>
              <div class="form-group">
                <label>読み方</label>
                <input type="text" class="form-control" name="pronunciation" data-idx="${i}" placeholder="読み方（ひらがな）">
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>難易度</label>
                  <select class="form-control" name="difficulty" data-idx="${i}">
                    ${CONFIG.DIFFICULTY_ORDER.map(d => `<option value="${d}">${d}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>レベル</label>
                  <input type="number" class="form-control" name="level" data-idx="${i}" min="1" max="50">
                </div>
              </div>
              <div class="form-row form-row-5">
                <div class="form-group"><label>PERFECT</label><input type="number" class="form-control" name="perfect" data-idx="${i}" min="0" value="0"></div>
                <div class="form-group"><label>GREAT</label><input type="number" class="form-control" name="great" data-idx="${i}" min="0" value="0"></div>
                <div class="form-group"><label>GOOD</label><input type="number" class="form-control" name="good" data-idx="${i}" min="0" value="0"></div>
                <div class="form-group"><label>BAD</label><input type="number" class="form-control" name="bad" data-idx="${i}" min="0" value="0"></div>
                <div class="form-group"><label>MISS</label><input type="number" class="form-control" name="miss" data-idx="${i}" min="0" value="0"></div>
              </div>
              <div class="form-group">
                <label>COMBO</label>
                <input type="number" class="form-control" name="combo" data-idx="${i}" min="0" value="0">
              </div>
            </div>
          </div>
        `).join('')}
      </div>`;
  }

  /** Render auto-confirm form (after OCR) */
  function renderConfirmForm() {
    const container = document.getElementById('upload-step-4');
    if (!container || !_ocrResults.length) return;

    container.innerHTML = `
      <div id="ocr-confirm-list">
        ${_ocrResults.map((res, i) => {
          const p = res.parsed || {};
          return `
          <div class="confirm-entry" data-idx="${i}">
            <img src="${URL.createObjectURL(res.file)}" class="confirm-thumb" alt="">
            <div class="confirm-fields">
              <div class="form-group">
                <label>タイトル</label>
                <input type="text" class="form-control" name="title" data-idx="${i}" value="${p.title || ''}">
              </div>
              <div class="form-group">
                <label>読み方</label>
                <input type="text" class="form-control" name="pronunciation" data-idx="${i}" value="${p.pronunciation || ''}">
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>難易度</label>
                  <select class="form-control" name="difficulty" data-idx="${i}">
                    ${CONFIG.DIFFICULTY_ORDER.map(d => `<option value="${d}" ${d === (p.difficulty||'') ? 'selected':''} >${d}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>レベル</label>
                  <input type="number" class="form-control" name="level" data-idx="${i}" min="1" max="50" value="${p.level || ''}">
                </div>
              </div>
              <div class="form-row form-row-5">
                <div class="form-group"><label>PERFECT</label><input type="number" class="form-control" name="perfect" data-idx="${i}" min="0" value="${p.perfect ?? 0}"></div>
                <div class="form-group"><label>GREAT</label><input type="number" class="form-control" name="great" data-idx="${i}" min="0" value="${p.great ?? 0}"></div>
                <div class="form-group"><label>GOOD</label><input type="number" class="form-control" name="good" data-idx="${i}" min="0" value="${p.good ?? 0}"></div>
                <div class="form-group"><label>BAD</label><input type="number" class="form-control" name="bad" data-idx="${i}" min="0" value="${p.bad ?? 0}"></div>
                <div class="form-group"><label>MISS</label><input type="number" class="form-control" name="miss" data-idx="${i}" min="0" value="${p.miss ?? 0}"></div>
              </div>
              <div class="form-group">
                <label>COMBO</label>
                <input type="number" class="form-control" name="combo" data-idx="${i}" min="0" value="${p.combo ?? 0}">
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  /** Collect form values for index i */
  function collectFormValues(i) {
    const getVal = (name) => {
      const el = document.querySelector(`[name="${name}"][data-idx="${i}"]`);
      return el ? el.value : '';
    };
    return {
      title:         getVal('title'),
      pronunciation: getVal('pronunciation'),
      difficulty:    getVal('difficulty'),
      level:         parseInt(getVal('level')) || 0,
      perfect:       parseInt(getVal('perfect')) || 0,
      great:         parseInt(getVal('great'))   || 0,
      good:          parseInt(getVal('good'))    || 0,
      bad:           parseInt(getVal('bad'))     || 0,
      miss:          parseInt(getVal('miss'))    || 0,
      combo:         parseInt(getVal('combo'))   || 0,
    };
  }

  /** Submit all entries */
  async function submitAll() {
    const btn = document.getElementById('upload-submit-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></div>登録中...'; }

    const srcFiles = _files;
    const total    = srcFiles.length;
    let success    = 0;

    const existingResults = await DB.getAllResults();

    for (let i = 0; i < total; i++) {
      try {
        const vals = collectFormValues(i);
        if (!vals.title) continue;

        // Find musicId if not set
        const ocr = _ocrResults[i];
        let musicId = ocr?.parsed?.musicId || null;
        if (!musicId) {
          const { music } = await MusicAPI.findBestMatch(vals.title);
          musicId = music?.id || null;
        }

        // Get totalNoteCount
        let totalNoteCount = null;
        if (musicId && vals.difficulty) {
          const de = await MusicAPI.getDifficultyEntry(musicId, vals.difficulty);
          if (de) totalNoteCount = de.totalNoteCount;
        }

        const file = srcFiles[i];
        let imageData   = '';
        let driveFileId = '';

        // Convert to base64 for storage
        imageData = await OCR.blobToBase64(file);

        // Upload to Drive if available
        if (await Drive.isAvailable()) {
          try {
            driveFileId = await Drive.uploadImage(file, `${crypto.randomUUID()}_${file.name}`);
          } catch(e) { /* Drive upload failed, continue */ }
        }

        const entry = {
          id:            crypto.randomUUID(),
          musicId,
          title:         vals.title,
          pronunciation: vals.pronunciation,
          difficulty:    vals.difficulty,
          level:         vals.level,
          perfect:       vals.perfect,
          great:         vals.great,
          good:          vals.good,
          bad:           vals.bad,
          miss:          vals.miss,
          combo:         vals.combo,
          totalNoteCount,
          imageData,
          driveFileId,
          addedAt:       new Date().toISOString(),
          updatedAt:     new Date().toISOString(),
        };

        await DB.addResult(entry);
        await Notification.checkPersonalBest(entry, existingResults);
        success++;

      } catch (e) {
        console.error('Entry error:', e);
        Notification.toast(`${i+1}件目の登録に失敗しました`, 'error');
      }
    }

    if (btn) { btn.disabled = false; btn.innerHTML = '<span class="material-symbols-outlined">check</span>登録する'; }

    if (success > 0) {
      Notification.toast(`${success}件を登録しました`, 'success');
      document.getElementById('upload-modal').classList.add('hidden');
      // Refresh gallery
      if (window.App) App.refreshGallery();
    }
  }

  /** Initialize upload events */
  function initEvents() {
    // Method cards
    document.querySelectorAll('.method-card').forEach(btn => {
      btn.addEventListener('click', () => {
        selectMethod(btn.dataset.method);
        showStep(2);
      });
    });

    // File drop zone
    const dropzone = document.getElementById('upload-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length) previewFiles(e.dataTransfer.files);
      });
    }

    document.getElementById('file-select-btn')?.addEventListener('click', () => {
      document.getElementById('file-input').click();
    });

    document.getElementById('file-input')?.addEventListener('change', (e) => {
      if (e.target.files.length) previewFiles(e.target.files);
    });

    // Navigation buttons
    document.getElementById('upload-next-btn')?.addEventListener('click', () => {
      if (_step === 2) {
        if (_files.length === 0) { Notification.toast('ファイルを選択してください', 'warning'); return; }
        if (_method === 'auto') {
          showStep(3);
          startOCR();
        } else {
          showStep(4);
          renderManualForm();
        }
      }
    });

    document.getElementById('upload-back-btn')?.addEventListener('click', () => {
      if (_step <= 2) showStep(1);
      else showStep(2);
    });

    document.getElementById('upload-submit-btn')?.addEventListener('click', submitAll);

    // Close modals
    document.querySelectorAll('#upload-modal .modal-close, #upload-modal .modal-overlay').forEach(el => {
      el.addEventListener('click', () => {
        document.getElementById('upload-modal').classList.add('hidden');
        reset();
      });
    });
  }

  return { open, initEvents };
})();
