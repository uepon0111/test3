/*
 * upload-editor.js
 * -----------------------------------------------------------------------
 * 「画像アップロード・編集」モーダルのロジック全体。
 *   - ドロップゾーン/ファイル選択でのキュー追加
 *   - 画像ごとの機種プロファイル自動選択(解像度・アスペクト比から)
 *   - OCR解析の実行 (PERFECT/GREAT/GOOD/BAD/MISS + コンボ数 + レベル)
 *   - フォーム編集 (曲名・レベル・難易度・判定内訳・コンボ・機種)
 *   - 保存実行 (新規アップロード / 既存レコードの更新) と自己ベスト通知への橋渡し
 *   - OCRの実測ログ表示
 * -----------------------------------------------------------------------
 */

function getItemById(id) {
  return editorQueue.find(q => q.id === id) || null;
}

function setItemStatus(id, status, label) {
  const item = getItemById(id);
  if (!item) return;
  item.status = status;
  const el = document.getElementById(`sb-status-${id}`);
  if (el) {
    el.innerText = label || status.toUpperCase();
    el.className = `upload-status ${status}`;
  }
}

function summarizeFieldLog(fieldLog) {
  if (!fieldLog) return '<div class="ocr-log-empty">ログなし</div>';
  const lines = [];
  lines.push(`<div class="ocr-log-summary-line"><strong>${escapeHtml(fieldLog.label || '')}</strong></div>`);
  if (fieldLog.parsed) {
    if (fieldLog.parsed.text !== undefined) {
      lines.push(`<div class="ocr-log-summary-line">OCR: <code>${escapeHtml(fieldLog.parsed.text)}</code></div>`);
    }
    if (fieldLog.parsed.value !== undefined && fieldLog.parsed.value !== null) {
      lines.push(`<div class="ocr-log-summary-line">値: <strong>${escapeHtml(fieldLog.parsed.value)}</strong></div>`);
    }
    if (fieldLog.parsed.code) {
      lines.push(`<div class="ocr-log-summary-line">コード: <strong>${escapeHtml(fieldLog.parsed.code)}</strong></div>`);
    }
    if (fieldLog.parsed.values) {
      const v = fieldLog.parsed.values;
      lines.push(`<div class="ocr-log-summary-line">内訳: P${v.perfect} / G${v.great} / Gd${v.good} / B${v.bad} / M${v.miss}</div>`);
      lines.push(`<div class="ocr-log-summary-line">総ノーツ数: <strong>${escapeHtml(fieldLog.parsed.totalNotes ?? '')}</strong></div>`);
    }
  }
  if (fieldLog.best) {
    lines.push(`<div class="ocr-log-summary-line">Best: ${escapeHtml(fieldLog.best.variant || '')} / conf ${Math.round(fieldLog.best.confidence || 0)}</div>`);
  }
  const previews = [];
  if (fieldLog.best?.preview) {
    previews.push(`<img src="${fieldLog.best.preview}" alt="${escapeHtml(fieldLog.label || '')} preview" class="ocr-log-image">`);
  }
  const variants = (fieldLog.variants || []).slice(0, 2).map(v => `
    <div class="ocr-log-variant">
      <div class="ocr-log-variant-head">${escapeHtml(v.name)} / conf ${Math.round(v.confidence || 0)}</div>
      <div class="ocr-log-variant-text">${escapeHtml(v.text || '')}</div>
      ${v.preview ? `<img src="${v.preview}" alt="${escapeHtml(v.name)}" class="ocr-log-image">` : ''}
    </div>
  `).join('');
  return `
    <div class="ocr-log-field">
      ${lines.join('')}
      <div class="ocr-log-previews">
        ${previews.join('')}
      </div>
      <div class="ocr-log-variants">${variants}</div>
    </div>
  `;
}

function renderAnalysisDebug(item) {
  const wrap = document.getElementById('ocr-debug-content');
  const meta = document.getElementById('ocr-debug-meta');
  if (!wrap || !meta) return;

  const profile = getDeviceProfileById(item?.data?.deviceProfileId) || getDeviceProfiles()[0] || null;
  const log = item?.analysisLog || null;

  const metaLines = [];
  metaLines.push(`機種: ${escapeHtml(profile ? profile.name : '未設定')}`);
  if (profile?.width && profile?.height) metaLines.push(`基準解像度: ${profile.width}×${profile.height}`);
  if (item?.data?.musicId) metaLines.push(`musicId: ${escapeHtml(item.data.musicId)}`);
  if (item?.data?.title) metaLines.push(`曲名候補: ${escapeHtml(item.data.title)}`);
  meta.innerHTML = metaLines.map(v => `<div>${v}</div>`).join('');

  if (!log) {
    wrap.innerHTML = '<div class="ocr-log-empty">まだ解析ログがありません。</div>';
    return;
  }

  const warnings = (log.warnings || []).map(w => `<li>${escapeHtml(w)}</li>`).join('');
  const candidate = log.candidate ? `
    <div class="ocr-candidate-box">
      <div><strong>${escapeHtml(log.candidate.title || '')}</strong> <span class="ocr-candidate-meta">Lv.${escapeHtml(log.candidate.playLevel ?? '')} / ${escapeHtml((DIFFICULTIES.find(d => d.dbKey === log.candidate.difficulty) || {}).label || log.candidate.difficulty || '')}</span></div>
      <div class="ocr-candidate-meta">score ${Number(log.candidate.score || 0).toFixed(3)} / note ${Number(log.candidate.totalNoteCount || 0)}</div>
      <div class="ocr-candidate-meta">title ${Number(log.candidate.titleScore || 0).toFixed(3)} / level ${Number(log.candidate.levelScore || 0).toFixed(3)} / note ${Number(log.candidate.noteScore || 0).toFixed(3)}</div>
      ${(log.candidate.alternatives || []).slice(1, 4).map(c => `
        <div class="ocr-candidate-alt">候補: ${escapeHtml(c.title)} / Lv.${escapeHtml(c.playLevel ?? '')} / ${escapeHtml((DIFFICULTIES.find(d => d.dbKey === c.diffKey) || {}).label || c.diffKey || '')} / score ${Number(c.score || 0).toFixed(3)}</div>
      `).join('')}
    </div>
  ` : '<div class="ocr-log-empty">DB候補なし</div>';

  wrap.innerHTML = `
    ${warnings ? `<div class="ocr-warning-box"><div class="ocr-warning-title">警告 / 補正</div><ul>${warnings}</ul></div>` : ''}
    ${candidate}
    <div class="ocr-log-grid">
      ${summarizeFieldLog(log.fields?.difficulty)}
      ${summarizeFieldLog(log.fields?.level)}
      ${summarizeFieldLog(log.fields?.title)}
      ${summarizeFieldLog(log.fields?.breakdown)}
      ${summarizeFieldLog(log.fields?.combo)}
    </div>
  `;
}

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
  renderAnalysisDebug(null);

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
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  });
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

    const dims = await getImageDimensions(imgUrl);
    const profile = findBestProfileForImage(dims.width, dims.height, profiles);

    const item = {
      id: qId,
      file: file,
      imgUrl: imgUrl,
      mimeType: file.type,
      status: 'pending',
      schema: null,
      analysisLog: null,
      data: {
        title: '',
        level: '',
        diff: 'MS',
        perfect: 0,
        great: 0,
        good: 0,
        bad: 0,
        missDetail: 0,
        totalMiss: 0,
        combo: 0,
        musicId: null,
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
      analysisLog: null,
      data: {
        title: rec.title,
        level: rec.level,
        diff: rec.difficultyRaw,
        perfect: rec.perfect,
        great: rec.great,
        good: rec.good,
        bad: rec.bad,
        missDetail: rec.miss,
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
  const item = getItemById(id);
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
  const item = getItemById(id);
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
  renderAnalysisDebug(item);
}

function updateCurrentItem(field, value) {
  if (!activeItemId) return;
  const item = getItemById(activeItemId);
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
  renderAnalysisDebug(item);
}

// 機種プロファイルを切り替えたら、その場で新しい読み取り範囲を使って再解析する
async function onDeviceProfileChange(newProfileId) {
  if (!activeItemId) return;
  const item = getItemById(activeItemId);
  if (!item) return;
  item.data.deviceProfileId = newProfileId;
  await reanalyzeCurrentItem();
}

function updateSidebarStatus(id) {
  const item = getItemById(id);
  if (!item) return;
  const statusEl = document.getElementById(`sb-status-${id}`);
  if (!statusEl) return;
  statusEl.innerText = "OK";
  statusEl.className = "upload-status done";
}

function removeBatchItem(e, id) {
  e.stopPropagation();
  editorQueue = editorQueue.filter(q => q.id !== id);
  const el = document.getElementById(`sb-${id}`);
  if (el) el.remove();
  if (activeItemId === id) {
    document.getElementById('batch-editor-container').style.display = 'none';
    document.getElementById('batch-empty-msg').style.display = 'block';
    activeItemId = null;
    renderAnalysisDebug(null);
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

  await ensureMusicDbLoaded();
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
        item.analysisLog = res.log;
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
      const titleEl = document.getElementById(`sb-title-${item.id}`);
      if (titleEl) titleEl.innerText = item.data.title;
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
  const item = getItemById(activeItemId);
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
      const el = document.getElementById(`sb-${item.id}`);
      if (el) el.remove();
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
      const el = document.getElementById(`sb-${item.id}`);
      if (el) el.remove();
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
