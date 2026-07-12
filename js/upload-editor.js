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
  cleanupEditorQueueResources(editorQueue);

  const modal = document.getElementById('batchModal');
  modal.style.display = 'flex';

  editorQueue = [];
  activeItemId = null;
  document.getElementById('batch-sidebar-list').innerHTML = "";
  document.getElementById('batch-editor-container').style.display = 'none';
  document.getElementById('batch-empty-msg').style.display = 'block';
  document.getElementById('batch-status-msg').innerText = "待機中...";
  document.getElementById('btn-exec-batch').disabled = true;
  renderOcrDebugPanel(null);

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
  cleanupEditorQueueResources(editorQueue);
  document.getElementById('batchModal').style.display = 'none';
  renderOcrDebugPanel(null);
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
        ocrDebug: null,
        totalNotes: 0,
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
        ocrDebug: null,
        totalNotes: rec.totalNotes || 0,
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
  renderOcrDebugPanel(item);
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

function releaseObjectUrl(url) {
  if (!url || typeof url !== 'string') return;
  try { URL.revokeObjectURL(url); } catch (_) {}
}

function releaseOcrDebugResources(debugLog) {
  if (!debugLog) return;
  const regions = debugLog.regions || {};
  Object.values(regions).forEach(region => {
    (region.variants || []).forEach(v => releaseObjectUrl(v.previewUrl));
    if (region.selected) releaseObjectUrl(region.selected.previewUrl);
  });
}

function cleanupEditorQueueResources(list) {
  (list || []).forEach(item => {
    releaseObjectUrl(item?.imgUrl);
    releaseOcrDebugResources(item?.data?.ocrDebug);
  });
}

function renderOcrDebugPanel(item) {
  const panel = document.getElementById('ocr-debug-panel');
  if (!panel) return;

  const debug = item?.data?.ocrDebug;
  if (!debug) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const regionOrder = ['difficulty', 'title', 'breakdown', 'combo'];
  const regionHtml = regionOrder.map(key => {
    const region = debug.regions?.[key];
    if (!region) return '';
    const title = REGION_DEFS.find(d => d.key === key)?.label || key;
    const selected = region.selected || {};
    const variants = region.variants || [];
    const preview = selected.previewUrl ? `<img src="${selected.previewUrl}" alt="${title} 二値化プレビュー" style="width:100%; max-height:150px; object-fit:contain; background:#111; border-radius:8px;">` : '<div style="padding:18px; text-align:center; color:#aaa; background:#111; border-radius:8px;">プレビューなし</div>';
    const variantList = variants.map(v => `
      <div style="padding:8px 10px; border:1px solid #eee; border-radius:8px; background:#fff;">
        <div style="display:flex; justify-content:space-between; gap:8px; font-size:0.78rem; color:#666;">
          <span>${escapeHtml(v.preset || '')}</span>
          <span>${Number.isFinite(v.confidence) ? v.confidence.toFixed(1) : '0.0'}</span>
        </div>
        <div style="white-space:pre-wrap; font-size:0.85rem; margin-top:4px;">${escapeHtml(v.cleanedText || v.text || '') || '（空）'}</div>
      </div>`).join('');
    const selectedText = selected.cleanedText || selected.text || '';
    return `
      <details open style="border:1px solid #e6e6e6; border-radius:12px; padding:10px; background:#fafafa;">
        <summary style="cursor:pointer; font-weight:700; margin-bottom:8px;">${escapeHtml(title)}</summary>
        <div style="display:grid; grid-template-columns: minmax(160px, 1fr) minmax(0, 1fr); gap:10px; align-items:start;">
          <div>
            ${preview}
            <div style="margin-top:8px; font-size:0.78rem; color:#666;">
              <div>範囲: x=${Math.round(region.region.x * (debug.image?.naturalWidth || 0))}, y=${Math.round(region.region.y * (debug.image?.naturalHeight || 0))}, w=${Math.round(region.region.w * (debug.image?.naturalWidth || 0))}, h=${Math.round(region.region.h * (debug.image?.naturalHeight || 0))}</div>
              <div>採用: ${escapeHtml(selected.preset || '')} / 信頼度 ${Number.isFinite(selected.confidence) ? selected.confidence.toFixed(1) : '0.0'}</div>
              <div style="margin-top:4px; white-space:pre-wrap;">${escapeHtml(selectedText || '') || '（空）'}</div>
            </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${variantList || '<div style="color:#888;">候補なし</div>'}
          </div>
        </div>
      </details>`;
  }).join('');

  const summary = debug.summary || {};
  panel.style.display = 'block';
  panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:10px;">
      <div style="font-weight:700;">OCR実測ログ</div>
      <button type="button" class="btn-reanalyze" style="margin:0;" onclick="downloadCurrentOcrDebugLog()">
        <span class="material-symbols-outlined" style="font-size:1rem;">download</span> JSON保存
      </button>
    </div>
    <div style="display:grid; gap:10px; margin-bottom:12px; font-size:0.85rem; color:#555;">
      <div>曲名: <b>${escapeHtml(summary.title || '')}</b> / 難易度: <b>${escapeHtml(summary.diffCode || '')}</b> / レベル: <b>${escapeHtml(summary.level || '')}</b></div>
      <div>総ノーツ数: <b>${escapeHtml(summary.totalNotes ?? '')}</b> / コンボ: <b>${escapeHtml(summary.combo ?? '')}</b> ${summary.rawCombo !== summary.combo ? `（生値: ${escapeHtml(summary.rawCombo ?? '')} → 補正済み）` : ''}</div>
      <div>musicId: <b>${escapeHtml(summary.musicId ?? '')}</b></div>
    </div>
    <div style="display:grid; gap:12px;">${regionHtml}</div>
    <textarea id="ocr-debug-json" readonly style="width:100%; min-height:160px; margin-top:12px; box-sizing:border-box; font-family:monospace; font-size:0.8rem; border:1px solid #ddd; border-radius:10px; padding:10px; background:#fff;"></textarea>
  `;
  const jsonEl = panel.querySelector('#ocr-debug-json');
  if (jsonEl) jsonEl.value = JSON.stringify(debug, null, 2);
}

function downloadCurrentOcrDebugLog() {
  const item = editorQueue.find(q => q.id === activeItemId);
  const debug = item?.data?.ocrDebug;
  if (!debug) return;
  const blob = new Blob([JSON.stringify(debug, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ocr-debug-${activeItemId || 'log'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
        if (item.data.ocrDebug) releaseOcrDebugResources(item.data.ocrDebug);
        item.data.title = res.title;
        item.data.level = res.level;
        item.data.diff = res.diff;
        item.data.perfect = res.perfect;
        item.data.great = res.great;
        item.data.good = res.good;
        item.data.bad = res.bad;
        item.data.missDetail = res.miss;
        item.data.totalMiss = res.good + res.bad + res.miss;
        item.data.totalNotes = res.totalNotes || (res.perfect + res.great + res.good + res.bad + res.miss);
        item.data.combo = res.combo;
        item.data.musicId = res.musicId;
        item.data.ocrDebug = res.debug || null;
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
