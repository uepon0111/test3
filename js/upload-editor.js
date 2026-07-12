/*
 * upload-editor.js
 * -----------------------------------------------------------------------
 * 「画像アップロード・編集」モーダルのロジック全体。
 *   - ドロップゾーン/ファイル選択でのキュー追加
 *   - 画像ごとの機種プロファイル自動選択(解像度・アスペクト比から)
 *   - OCR解析の実行 (PERFECT/GREAT/GOOD/BAD/MISS + コンボ数を含む)
 *   - フォーム編集 (曲名・レベル・難易度・判定内訳・コンボ・機種)
 *   - 保存実行 (新規アップロード / 既存レコードの更新) と自己ベスト通知への橋渡し
 * -----------------------------------------------------------------------
 */

// ============================================================
// モーダルの開閉
// ============================================================

function openBatchModal(mode) {
  currentMode = mode;
  const modal = document.getElementById('batchModal');
  modal.style.display = 'flex';

  editorQueue = [];
  activeItemId = null;
  document.getElementById('batch-sidebar-list').innerHTML = "";
  document.getElementById('batch-editor-container').style.display = 'none';
  document.getElementById('batch-empty-msg').style.display = 'block';
  document.getElementById('batch-status-msg').innerText = "待機中...";
  document.getElementById('btn-exec-batch').disabled = true;

  if (mode === 'upload') {
    document.getElementById('batch-modal-title').innerHTML = '<span class="material-symbols-outlined">cloud_upload</span> 画像アップロード';
    document.getElementById('upload-initial').style.display = 'flex';
    document.getElementById('batch-workspace').style.display = 'none';
    document.getElementById('up-file').value = "";
    document.getElementById('btn-exec-batch').innerText = "全てアップロード";
  } else {
    document.getElementById('batch-modal-title').innerHTML = '<span class="material-symbols-outlined">edit_square</span> 編集・解析モード';
    document.getElementById('upload-initial').style.display = 'none';
    document.getElementById('batch-workspace').style.display = 'flex';
    document.getElementById('btn-exec-batch').innerText = "保存して反映";
  }
}

function closeBatchModal() {
  document.getElementById('batchModal').style.display = 'none';
}

// ============================================================
// ドロップゾーン/ファイル選択
// ============================================================

function initUploadEditor() {
  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); });
  document.getElementById('up-file').addEventListener('change', (e) => handleFiles(e.target.files));

  populateDifficultySelect(document.getElementById('up-diff'), { defaultValue: 'MS' });
}

function getImageDimensions(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

async function handleFiles(files) {
  if (files.length === 0) return;
  document.getElementById('upload-initial').style.display = 'none';
  document.getElementById('batch-workspace').style.display = 'flex';
  document.getElementById('batch-status-msg').innerText = "画像を処理中...";

  const profiles = getDeviceProfiles();
  const newItems = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const qId = "new_" + Date.now() + "_" + i;
    const imgUrl = URL.createObjectURL(file);

    // 画像の画素数・アスペクト比から、保存済みの機種プロファイルを自動選択する
    const dims = await getImageDimensions(imgUrl);
    const profile = findBestProfileForImage(dims.width, dims.height, profiles);

    const item = {
      id: qId,
      file: file,
      imgUrl: imgUrl,
      mimeType: file.type,
      status: 'pending',
      schema: null,
      data: {
        title: '', level: '', diff: 'MS',
        perfect: 0, great: 0, good: 0, bad: 0, missDetail: 0, totalMiss: 0,
        combo: 0, musicId: null,
        deviceProfileId: profile ? profile.id : null,
      },
      originalId: null,
      originalParent: null,
    };
    editorQueue.push(item);
    newItems.push(item);
    renderSidebarItem(qId);
  }

  await runBatchAnalysis(newItems);

  if (!activeItemId && editorQueue.length > 0) selectItem(editorQueue[0].id);
  checkBatchButton();
}

// ============================================================
// 編集モードのキュー初期化 (選択済みレコードから)
// ============================================================

// 記録済みの device(機種名)から一致するプロファイルを探す。見つからなければ先頭のプロファイルを使う。
function resolveDeviceProfileForRecord(rec) {
  const profiles = getDeviceProfiles();
  if (rec.device) {
    const byName = profiles.find(p => p.name === rec.device);
    if (byName) return byName;
  }
  return profiles[0] || null;
}

async function batchEdit() {
  if (selectedIds.size === 0) return;
  openBatchModal('edit');

  const targets = allRecords.filter(r => selectedIds.has(r.id));
  document.getElementById('batch-status-msg').innerText = "編集データを準備中...";

  for (const rec of targets) {
    const qId = "edit_" + rec.id;
    const highResUrl = rec.thumbnail ? rec.thumbnail.replace('=s220', '=w1600') : '';
    const profile = resolveDeviceProfileForRecord(rec);

    editorQueue.push({
      id: qId,
      file: null,
      imgUrl: highResUrl,
      mimeType: rec.mimeType || '',
      status: 'existing',
      schema: rec.schema,
      data: {
        title: rec.title, level: rec.level, diff: rec.difficultyRaw,
        // 新方式のレコードは実際の内訳が分かっているのでそのまま使う。
        // 旧方式のレコードは元々内訳を記録していないため0になる(rec側で既に0が入っている)。
        perfect: rec.perfect, great: rec.great, good: rec.good, bad: rec.bad, missDetail: rec.miss,
        totalMiss: rec.missCount,
        combo: rec.combo,
        musicId: rec.musicId,
        deviceProfileId: profile ? profile.id : null,
      },
      originalId: rec.id,
      originalParent: rec.parentId,
    });
    renderSidebarItem(qId);
  }
  if (editorQueue.length > 0) selectItem(editorQueue[0].id);
  checkBatchButton();
  document.getElementById('batch-status-msg').innerText = "編集準備完了";
}

// ============================================================
// サイドバー / フォーム表示
// ============================================================

function renderSidebarItem(id) {
  const item = editorQueue.find(q => q.id === id);
  const div = document.createElement('div');
  div.className = 'sidebar-item';
  div.id = `sb-${id}`;
  div.onclick = () => selectItem(id);

  div.innerHTML = `
      <img src="${item.imgUrl}" class="sidebar-thumb" crossorigin="anonymous">
      <div class="sidebar-info">
          <div class="sidebar-title" id="sb-title-${id}">${escapeHtml(item.data.title) || "名称未設定"}</div>
          <div class="sidebar-status">
              <span id="sb-status-${id}" class="upload-status ${item.status === 'existing' ? 'done' : item.status}">${item.status === 'existing' ? 'EXIST' : item.status}</span>
              <button class="btn-remove-side" onclick="removeBatchItem(event, '${id}')">
                  <span class="material-symbols-outlined" style="font-size:1rem;">delete</span>
              </button>
          </div>
      </div>
  `;
  document.getElementById('batch-sidebar-list').appendChild(div);
}

function populateDeviceSelect(selectedId) {
  const sel = document.getElementById('up-device');
  const profiles = getDeviceProfiles();
  sel.innerHTML = profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  if (selectedId && profiles.some(p => p.id === selectedId)) sel.value = selectedId;
}

function selectItem(id) {
  activeItemId = id;
  const item = editorQueue.find(q => q.id === id);
  if (!item) return;

  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
  const sbEl = document.getElementById(`sb-${id}`);
  if (sbEl) sbEl.classList.add('active');

  document.getElementById('batch-editor-container').style.display = 'flex';
  document.getElementById('batch-empty-msg').style.display = 'none';

  document.getElementById('batch-preview-img').src = item.imgUrl;

  document.getElementById('up-title').value = item.data.title;
  document.getElementById('up-level').value = item.data.level;
  document.getElementById('up-diff').value = item.data.diff;

  document.getElementById('up-perfect').value = item.data.perfect;
  document.getElementById('up-great').value = item.data.great;
  document.getElementById('up-good').value = item.data.good;
  document.getElementById('up-bad').value = item.data.bad;
  document.getElementById('up-miss-detail').value = item.data.missDetail;
  document.getElementById('up-total-miss').innerText = item.data.totalMiss;
  document.getElementById('up-combo').value = item.data.combo;

  populateDeviceSelect(item.data.deviceProfileId);
  renderDebugPanel(item);
}


function renderDebugPanel(item) {
  const panel = document.getElementById('ocr-debug-panel');
  const summary = document.getElementById('ocr-debug-summary');
  const grid = document.getElementById('ocr-debug-grid');
  if (!panel || !summary || !grid) return;

  if (!item || !item.debug) {
    panel.style.display = 'none';
    summary.innerHTML = '';
    grid.innerHTML = '';
    return;
  }

  const debug = item.debug;
  const regions = debug.regions || {};
  const totalNotes = debug.summary && Number.isFinite(debug.summary.totalNotes) ? debug.summary.totalNotes : null;
  const combo = debug.summary && Number.isFinite(debug.summary.combo) ? debug.summary.combo : item.data.combo;
  const comboWarn = totalNotes && combo > totalNotes ? '（総ノーツ超過のため補正済み）' : '';
  const bestCandidates = (debug.summary && Array.isArray(debug.summary.bestCandidates)) ? debug.summary.bestCandidates.slice(0, 5) : [];

  summary.innerHTML = `
    <div class="ocr-debug-summary-card">
      <div class="ocr-debug-summary-title">総合ログ</div>
      <div>画像サイズ: ${debug.imageSize.width || 0} × ${debug.imageSize.height || 0}</div>
      <div>採用曲名: <strong>${escapeHtml(item.data.title || '')}</strong></div>
      <div>採用難易度: <strong>${escapeHtml(item.data.diff || '')}</strong> / レベル <strong>${escapeHtml(item.data.level || '')}</strong></div>
      <div>総ミス数: ${item.data.totalMiss}</div>
      <div>コンボ: ${item.data.combo}${comboWarn ? ` <span class="ocr-debug-warn">${comboWarn}</span>` : ''}</div>
      <div>タイトル採用理由: ${escapeHtml(debug.summary?.titleResolutionReason || '')}</div>
    </div>
    <div class="ocr-debug-summary-card">
      <div class="ocr-debug-summary-title">OCR信頼度</div>
      <div>難易度: ${Math.round(debug.summary?.diffConfidence || 0)}%</div>
      <div>曲名: ${Math.round(debug.summary?.titleConfidence || 0)}%</div>
      <div>判定内訳: ${Math.round(debug.summary?.breakdownConfidence || 0)}%</div>
      <div>コンボ: ${Math.round(debug.summary?.comboConfidence || 0)}%</div>
      <div>総ノーツ推定: ${totalNotes !== null ? totalNotes : '—'}</div>
    </div>
    <div class="ocr-debug-summary-card">
      <div class="ocr-debug-summary-title">採用候補 上位5件</div>
      ${bestCandidates.length ? bestCandidates.map(c => `
        <div class="ocr-debug-candidate">
          <div class="ocr-debug-candidate-title">${escapeHtml(c.title)} <span class="ocr-debug-candidate-id">#${escapeHtml(String(c.musicId))}</span></div>
          <div>score: ${c.score} / title距離: ${c.titleDistance}</div>
          <div>想定レベル: ${escapeHtml(c.expectedLevel || '—')} / 想定総ノーツ: ${escapeHtml(c.expectedNotes === null || c.expectedNotes === undefined ? '—' : String(c.expectedNotes))}</div>
        </div>
      `).join('') : '<div class="ocr-debug-empty">候補なし</div>'}
    </div>
  `;

  const cards = [];
  for (const [key, info] of Object.entries(regions)) {
    const chosen = info.chosen || {};
    const crop = info.crop || {};
    const rawUrl = info.rawUrl || '';
    const processedUrl = info.processedUrl || rawUrl || '';
    const passes = info.ocrPasses || [];
    cards.push(`
      <section class="ocr-region-card">
        <div class="ocr-region-head">
          <div>
            <div class="ocr-region-title">${escapeHtml(key)}</div>
            <div class="ocr-region-meta">crop: ${crop.x ?? '—'}, ${crop.y ?? '—'}, ${crop.width ?? '—'}, ${crop.height ?? '—'} / 二値化: ${info.appliedInvert ? '反転あり' : '通常'} / mean: ${info.meanBrightness !== null && info.meanBrightness !== undefined ? info.meanBrightness.toFixed(1) : '—'}</div>
          </div>
          <div class="ocr-region-score">confidence ${Math.round(chosen.confidence || 0)}%</div>
        </div>
        <div class="ocr-region-images">
          <figure>
            <img src="${rawUrl}" alt="${escapeHtml(key)} raw">
            <figcaption>切り出し</figcaption>
          </figure>
          <figure>
            <img src="${processedUrl}" alt="${escapeHtml(key)} processed">
            <figcaption>前処理後</figcaption>
          </figure>
        </div>
        <div class="ocr-region-text">
          <div><strong>OCR</strong>: ${escapeHtml(chosen.text || '')}</div>
          <div><strong>採用候補</strong>: ${escapeHtml(chosen.label || '')}</div>
        </div>
        <details class="ocr-region-details">
          <summary>OCRパス (${passes.length})</summary>
          <div class="ocr-pass-list">
            ${passes.map(p => `
              <div class="ocr-pass-item">
                <div><strong>${escapeHtml(p.label || '')}</strong> / ${escapeHtml(p.lang || '')}</div>
                <div>confidence: ${Math.round(p.confidence || 0)} / score: ${Math.round((p.score || 0) * 10) / 10}</div>
                <div class="ocr-pass-text">${escapeHtml((p.text || '').replace(/\n/g, ' ⏎ '))}</div>
              </div>
            `).join('')}
          </div>
        </details>
      </section>
    `);
  }
  grid.innerHTML = cards.join('');
  panel.style.display = 'block';
}
function updateCurrentItem(field, value) {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (!item) return;

  if (['good', 'bad', 'missDetail', 'perfect', 'great', 'combo', 'level'].includes(field)) {
    item.data[field] = parseInt(value) || 0;
  } else {
    item.data[field] = value;
  }

  if (field === 'diff' && item.data.musicId) {
    const dbKey = getDiffDbKey(value);
    const newLvl = getLevelFromDb(item.data.musicId, dbKey);
    if (newLvl) { item.data.level = newLvl; document.getElementById('up-level').value = newLvl; }
  }

  if (['good', 'bad', 'missDetail'].includes(field)) {
    item.data.totalMiss = item.data.good + item.data.bad + item.data.missDetail;
    document.getElementById('up-total-miss').innerText = item.data.totalMiss;
  }

  if (field === 'title') {
    document.getElementById(`sb-title-${activeItemId}`).innerText = value || "名称未設定";
  }

  item.status = 'done';
  updateSidebarStatus(activeItemId);
}

// 機種プロファイルを切り替えたら、その場で新しい読み取り範囲を使って再解析する
async function onDeviceProfileChange(newProfileId) {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (!item) return;
  item.data.deviceProfileId = newProfileId;
  await reanalyzeCurrentItem();
}

function updateSidebarStatus(id) {
  const item = editorQueue.find(q => q.id === id);
  if (!item) return;
  const statusEl = document.getElementById(`sb-status-${id}`);
  statusEl.innerText = "OK";
  statusEl.className = "upload-status done";
}

function removeBatchItem(e, id) {
  e.stopPropagation();
  editorQueue = editorQueue.filter(q => q.id !== id);
  document.getElementById(`sb-${id}`).remove();
  if (activeItemId === id) {
    document.getElementById('batch-editor-container').style.display = 'none';
    document.getElementById('batch-empty-msg').style.display = 'block';
    activeItemId = null;
  }
  checkBatchButton();
}

function checkBatchButton() {
  const btn = document.getElementById('btn-exec-batch');
  btn.disabled = editorQueue.length === 0;
  const label = currentMode === 'upload' ? '全てアップロード' : '保存して反映';
  btn.innerText = editorQueue.length > 0 ? `${label} (${editorQueue.length}件)` : label;
}

// ============================================================
// OCR解析
// ============================================================

async function runBatchAnalysis(itemsToAnalyze) {
  if (itemsToAnalyze.length === 0) return;
  const statusMsg = document.getElementById('batch-status-msg');
  statusMsg.innerText = "解析中... (しばらくお待ちください)";

  const worker = await Tesseract.createWorker(['jpn', 'eng']);

  for (const item of itemsToAnalyze) {
    const el = document.getElementById(`sb-status-${item.id}`);
    if (el) { el.innerText = "解析中"; el.className = "upload-status processing"; }

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = item.imgUrl;
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const profile = getDeviceProfileById(item.data.deviceProfileId) || getDeviceProfiles()[0];
      const regions = getRegionsForProfile(profile);
      const res = await analyzeLoadedImage(img, worker, regions);
      if (res) {
        item.data.title = res.title;
        item.data.level = res.level;
        item.data.diff = res.diff;
        item.data.perfect = res.perfect;
        item.data.great = res.great;
        item.data.good = res.good;
        item.data.bad = res.bad;
        item.data.missDetail = res.miss;
        item.data.totalMiss = res.good + res.bad + res.miss;
        item.data.combo = res.combo;
        item.data.musicId = res.musicId;
        item.debug = res.debug || null;
        item.status = 'done';
      } else {
        item.status = 'error';
      }
    } catch (e) {
      console.error("Analysis Failed for " + item.id, e);
      item.status = 'error';
    }

    updateSidebarStatus(item.id);
    if (item.status === 'done') {
      document.getElementById(`sb-title-${item.id}`).innerText = item.data.title;
      if (activeItemId === item.id) selectItem(item.id);
    } else {
      const statEl = document.getElementById(`sb-status-${item.id}`);
      if (statEl) { statEl.innerText = "ERR"; statEl.className = "upload-status error"; }
    }
  }
  await worker.terminate();
  statusMsg.innerText = "処理完了";
}

async function reanalyzeCurrentItem() {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (item) await runBatchAnalysis([item]);
}

async function analyzeAllInBatch() {
  if (editorQueue.length === 0) return;
  await runBatchAnalysis(editorQueue);
}

// ============================================================
// 保存実行 (アップロード / 編集)
// ============================================================

async function handleBatchExecution() {
  const btn = document.getElementById('btn-exec-batch');
  btn.disabled = true;
  btn.innerText = "処理中...";

  if (currentMode === 'upload') {
    await executeUploads();
  } else {
    await executeEdits();
  }
}

// アップロード/編集した内容から、自己ベスト判定用の軽量なレコード情報を作る
function buildAchievementCandidate(data) {
  return {
    musicId: data.musicId,
    title: data.title,
    difficultyRaw: data.diff,
    missCount: data.totalMiss,
    combo: data.combo,
    createdTime: new Date().toISOString(),
  };
}

async function executeUploads() {
  let successCount = 0;
  const beforeSnapshot = allRecords.slice();
  const newlyAdded = [];

  for (const item of [...editorQueue]) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "送信中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      await createNewRecord(item.file, item.data);
      newlyAdded.push(buildAchievementCandidate(item.data));

      editorQueue = editorQueue.filter(q => q.id !== item.id);
      document.getElementById(`sb-${item.id}`).remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
  }
  finishExecution(successCount, "アップロード", beforeSnapshot, newlyAdded);
}

async function executeEdits() {
  let successCount = 0;
  const beforeSnapshot = allRecords.slice();
  const newlyAdded = [];

  for (const item of [...editorQueue]) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "保存中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      await updateExistingRecord(item);
      newlyAdded.push(buildAchievementCandidate(item.data));

      editorQueue = editorQueue.filter(q => q.id !== item.id);
      document.getElementById(`sb-${item.id}`).remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
  }
  finishExecution(successCount, "更新", beforeSnapshot, newlyAdded);
}

function finishExecution(count, actionName, beforeSnapshot, newlyAdded) {
  const achievements = detectNewBests(beforeSnapshot, newlyAdded);
  if (editorQueue.length === 0) {
    alert(`${actionName}完了 (${count}件)`);
    closeBatchModal();
    selectedIds.clear();
    updateSelectionUI();
    fetchDataFromDrive().then(() => showNewBestNotifications(achievements));
  } else {
    alert(`${count}件 ${actionName}成功。エラー分を確認してください。`);
    checkBatchButton();
  }
}
