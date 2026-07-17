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
  hideBatchProgress();
  clearTitleSuggestions();
  const batchWarn = document.getElementById('batch-warning-banner');
  if (batchWarn) { batchWarn.style.display = 'none'; batchWarn.innerHTML = ''; }

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
  cleanupEditorQueueUrls();
  document.getElementById('batchModal').style.display = 'none';
}



function setBatchProgress(label, percent, visible = true) {
  const area = document.getElementById('batch-progress-area');
  const bar = document.getElementById('batch-progress-bar');
  const labelEl = document.getElementById('batch-progress-label');
  if (!area || !bar || !labelEl) return;
  area.style.display = visible ? 'block' : 'none';
  labelEl.innerText = label || '';
  bar.style.width = `${clamp(percent, 0, 100)}%`;
}

function hideBatchProgress() {
  setBatchProgress('', 0, false);
}

function cleanupEditorQueueUrls() {
  for (const item of editorQueue) {
    if (item && typeof item.imgUrl === 'string' && item.imgUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(item.imgUrl); } catch (_) {}
    }
  }
}

function clearTitleSuggestions() {
  const panel = document.getElementById('title-suggestions');
  if (!panel) return;
  panel.innerHTML = '';
  panel.style.display = 'none';
}

function renderTitleSuggestions(query) {
  const panel = document.getElementById('title-suggestions');
  if (!panel) return;
  const list = findMusicTitleCandidates(query, 8);
  if (!query || list.length === 0) {
    clearTitleSuggestions();
    return;
  }
  panel.innerHTML = list.map((cand, idx) => `
    <div class="autocomplete-item ${idx === 0 ? 'active' : ''}" data-music-id="${cand.music.id}">
      <div class="autocomplete-item-title">${escapeHtml(cand.music.title)}</div>
      <div class="autocomplete-item-pron">${escapeHtml(cand.music.pronunciation || '')}</div>
    </div>
  `).join('');
  panel.style.display = 'block';
  panel.querySelectorAll('.autocomplete-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseMusicSuggestion(el.dataset.musicId);
    });
  });
}

function chooseMusicSuggestion(musicId) {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  const music = getMusicById(toInt(musicId, null));
  if (!item || !music) return;
  item.data.title = music.title;
  item.data.musicId = music.id;
  const diffKey = getDiffDbKey(item.data.diff);
  const dbLevel = getLevelFromDb(music.id, diffKey);
  if (dbLevel != null) item.data.level = dbLevel;
  document.getElementById('up-title').value = music.title;
  document.getElementById('up-level').value = item.data.level;
  clearTitleSuggestions();
  reconcileEditedItem(item);
  updateSidebarTitleAndWarnings(item);
  showBatchWarningSummary();
}

function updateSidebarTitleAndWarnings(item) {
  if (!item) return;
  const titleEl = document.getElementById(`sb-title-${item.id}`);
  if (titleEl) titleEl.innerText = item.data.title || '名称未設定';
  updateSidebarStatus(item.id);
  renderFormWarnings(item);
}

function getItemTotalNotes(item) {
  return toInt(item?.data?.perfect, 0) + toInt(item?.data?.great, 0) + toInt(item?.data?.good, 0) + toInt(item?.data?.bad, 0) + toInt(item?.data?.missDetail, 0);
}

function reconcileEditedItem(item) {
  const inheritedWarnings = Array.isArray(item.warnings) ? item.warnings.slice() : [];
  const warnings = [];
  const data = item.data;
  const titleQuery = data.title || '';
  const candidate = findBestMusicInputMatch(titleQuery);
  if (candidate) {
    data.musicId = candidate.music.id;
    data.title = candidate.music.title;
    const diffKey = getDiffDbKey(data.diff);
    const dbLevel = getLevelFromDb(data.musicId, diffKey);
    if (dbLevel != null) data.level = dbLevel;
  } else if (!titleQuery.trim()) {
    data.musicId = null;
  } else if (data.musicId) {
    const actual = getMusicById(data.musicId);
    if (actual && normalizeString(actual.title) !== normalizeString(titleQuery)) {
      data.musicId = null;
    }
  }

  if (data.musicId) {
    const music = getMusicById(data.musicId);
    if (music && data.title !== music.title) data.title = music.title;
    const diffKey = getDiffDbKey(data.diff);
    const dbLevel = getLevelFromDb(data.musicId, diffKey);
    if (dbLevel != null && data.level !== dbLevel) {
      data.level = dbLevel;
      warnings.push({ level: 'info', field: 'level', message: `楽曲マスターに合わせてレベルを ${dbLevel} に修正しました。` });
    }
  } else if (titleQuery.trim()) {
    warnings.push({ level: 'warn', field: 'title', message: '曲名候補を自動確定できませんでした。候補から選択するか、曲名を確認してください。' });
  }

  const totalNotes = getItemTotalNotes(item);
  if (totalNotes > 0 && data.combo > totalNotes) {
    warnings.push({ level: 'error', field: 'combo', message: `コンボ数(${data.combo})が総ノーツ数(${totalNotes})を超えています。` });
  }
  if (totalNotes > 0 && data.bad === 0 && data.missDetail === 0 && data.combo !== totalNotes) {
    warnings.push({ level: 'warn', field: 'combo', message: `フルコンボ相当ですが、コンボ数(${data.combo})と総ノーツ数(${totalNotes})が一致していません。` });
  }
  if (data.musicId) {
    const diffKey = getDiffDbKey(data.diff);
    const dbLevel = getLevelFromDb(data.musicId, diffKey);
    if (dbLevel != null && String(data.level) !== String(dbLevel)) {
      warnings.push({ level: 'info', field: 'level', message: `選択中の曲に合わせてレベルを ${dbLevel} に更新しました。` });
    }
  }
  const merged = [...inheritedWarnings, ...warnings];
  const seen = new Set();
  item.warnings = merged.filter(w => {
    const key = `${w.level}|${w.field}|${w.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  item.status = 'done';
  return item.warnings;
}

function previewItemImageUrl(item, url) {
  item.imgUrl = url;
  const img = document.querySelector(`#sb-${item.id} .sidebar-thumb`);
  if (img) img.src = url;
  if (activeItemId === item.id) {
    const preview = document.getElementById('batch-preview-img');
    if (preview) preview.src = url;
  }
}

function showBatchWarningSummary() {
  const banner = document.getElementById('batch-warning-banner');
  if (!banner) return;
  const issues = editorQueue.flatMap(item => (item.warnings || []).map(w => ({ item, warning: w }))).filter(x => x.warning.level === 'warn' || x.warning.level === 'error');
  if (issues.length === 0) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }
  const top = issues[0];
  banner.style.display = 'flex';
  banner.className = 'form-warnings-banner banner-warn';
  banner.innerHTML = `<span class="material-symbols-outlined">warning</span><span>注意が必要な項目があります。アップロード前に確認してください。</span>`;
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

  const titleInput = document.getElementById('up-title');
  titleInput.addEventListener('input', () => {
    renderTitleSuggestions(titleInput.value);
  });
  titleInput.addEventListener('blur', () => setTimeout(clearTitleSuggestions, 150));
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('title-suggestions');
    const wrap = document.querySelector('.autocomplete-wrap');
    if (panel && wrap && !wrap.contains(e.target)) clearTitleSuggestions();
  });

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
  document.getElementById('batch-status-msg').innerText = "画像をページに読み込み中...";
  setBatchProgress('画像をページに読み込み中...', 0, true);

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
    setBatchProgress(`画像をページに読み込み中... (${i + 1}/${files.length})`, ((i + 1) / files.length) * 100, true);
    await new Promise(requestAnimationFrame);
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
  setBatchProgress('画像をページに読み込み中...', 0, true);

  const imageLoads = [];
  for (const [index, rec] of targets.entries()) {
    const qId = "edit_" + rec.id;
    const profile = resolveDeviceProfileForRecord(rec);

    const item = {
      id: qId,
      file: null,
      imgUrl: rec.thumbnail || '',
      mimeType: rec.mimeType || '',
      status: 'existing',
      schema: rec.schema,
      data: {
        title: rec.title, level: rec.level, diff: rec.difficultyRaw,
        perfect: rec.perfect, great: rec.great, good: rec.good, bad: rec.bad, missDetail: rec.miss,
        totalMiss: rec.missCount,
        combo: rec.combo,
        musicId: rec.musicId,
        deviceProfileId: profile ? profile.id : null,
      },
      originalId: rec.id,
      originalParent: rec.parentId,
    };
    editorQueue.push(item);
    renderSidebarItem(qId);

    const promise = (async () => {
      try {
        const url = await createDriveObjectUrl(rec.id);
        previewItemImageUrl(item, url);
      } catch (e) {
        console.warn('Drive 画像の取得に失敗しました', rec.id, e);
      } finally {
        setBatchProgress(`画像をページに読み込み中... (${index + 1}/${targets.length})`, ((index + 1) / targets.length) * 100, true);
      }
    })();
    imageLoads.push(promise);
  }
  await Promise.allSettled(imageLoads);
  editorQueue.forEach(item => {
    reconcileEditedItem(item);
    updateSidebarStatus(item.id);
  });
  if (editorQueue.length > 0) selectItem(editorQueue[0].id);
  checkBatchButton();
  document.getElementById('batch-status-msg').innerText = "編集準備完了";
  showBatchWarningSummary();
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
  clearTitleSuggestions();

  document.getElementById('up-perfect').value = item.data.perfect;
  document.getElementById('up-great').value = item.data.great;
  document.getElementById('up-good').value = item.data.good;
  document.getElementById('up-bad').value = item.data.bad;
  document.getElementById('up-miss-detail').value = item.data.missDetail;
  document.getElementById('up-total-miss').innerText = item.data.totalMiss;
  document.getElementById('up-combo').value = item.data.combo;

  populateDeviceSelect(item.data.deviceProfileId);
  renderFormWarnings(item);
}

// 実測ログ・矛盾チェックの結果を、フォーム上部の小さなバナーとして表示する。
// 詳細(切り出し画像・OCRテキスト等)は「実測ログを見る」ボタンからモーダルで確認できる。
function renderFormWarnings(item) {
  const banner = document.getElementById('form-warnings-banner');
  const logBtn = document.getElementById('btn-view-log');
  if (!banner || !logBtn) return;

  logBtn.disabled = !item.debugLog;

  const warnings = item.warnings || [];
  const hasError = warnings.some(w => w.level === 'error');
  const hasWarn = warnings.some(w => w.level === 'warn');
  const hasInfo = warnings.some(w => w.level === 'info');

  if (!warnings.length) {
    banner.style.display = 'flex';
    banner.className = 'form-warnings-banner banner-ok';
    banner.innerHTML = `<span class="material-symbols-outlined">check_circle</span><span>目立った矛盾は検出されませんでした</span>`;
    return;
  }

  banner.style.display = 'flex';
  const icon = hasError ? 'error' : (hasWarn ? 'warning' : 'info');
  const cls = hasError ? 'banner-error' : (hasWarn ? 'banner-warn' : 'banner-info');
  const extra = warnings.length > 1 ? ` (他${warnings.length - 1}件)` : '';
  banner.className = 'form-warnings-banner ' + cls;
  banner.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${escapeHtml(warnings[0].message)}${extra}</span>`;
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

  if (field === 'title') {
    item.data.musicId = null;
    const candidate = findBestMusicInputMatch(value);
    if (candidate) {
      item.data.musicId = candidate.music.id;
      item.data.title = candidate.music.title;
      document.getElementById('up-title').value = candidate.music.title;
      clearTitleSuggestions();
      const diffKey = getDiffDbKey(item.data.diff);
      const newLvl = getLevelFromDb(item.data.musicId, diffKey);
      if (newLvl != null) {
        item.data.level = newLvl;
        document.getElementById('up-level').value = newLvl;
      }
    } else {
      renderTitleSuggestions(value);
    }
  }

  if (field === 'diff' && item.data.musicId) {
    const dbKey = getDiffDbKey(value);
    const newLvl = getLevelFromDb(item.data.musicId, dbKey);
    if (newLvl != null) { item.data.level = newLvl; document.getElementById('up-level').value = newLvl; }
  }

  if (['good', 'bad', 'missDetail'].includes(field)) {
    item.data.totalMiss = item.data.good + item.data.bad + item.data.missDetail;
    document.getElementById('up-total-miss').innerText = item.data.totalMiss;
  }

  if (field === 'title') {
    document.getElementById(`sb-title-${activeItemId}`).innerText = item.data.title || '名称未設定';
  }

  reconcileEditedItem(item);
  updateSidebarTitleAndWarnings(item);
  showBatchWarningSummary();
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
  const warnings = item.warnings || [];
  const hasError = warnings.some(w => w.level === 'error');
  const hasWarn = warnings.some(w => w.level === 'warn');

  if (hasError) { statusEl.innerText = "要確認"; statusEl.className = "upload-status warn-error"; }
  else if (hasWarn) { statusEl.innerText = "確認"; statusEl.className = "upload-status warn"; }
  else { statusEl.innerText = "OK"; statusEl.className = "upload-status done"; }
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
  setBatchProgress('画像を解析中...', 0, true);

  const worker = await Tesseract.createWorker(['jpn', 'eng']);

  for (const [idx, item] of itemsToAnalyze.entries()) {
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
      // analyzeLoadedImage: 画像から各項目を読み取る(知覚)。
      // reconcileOcrResult: 曲名/難易度/レベル/総ノーツ数をDBと突き合わせ、
      //   自信が無い項目を他の情報から補いつつ最終値を決定する(判断)。
      const raw = await analyzeLoadedImage(img, worker, regions);
      if (raw) {
        const reconciled = reconcileOcrResult(raw);
        Object.assign(item.data, reconciled.data);
        item.debugLog = raw.debugLog;
        item.warnings = reconciled.warnings;
        item.reasoning = reconciled.reasoning;
        item.confidence = reconciled.confidence;
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
      reconcileEditedItem(item);
      if (activeItemId === item.id) selectItem(item.id);
    } else {
      const statEl = document.getElementById(`sb-status-${item.id}`);
      if (statEl) { statEl.innerText = "ERR"; statEl.className = "upload-status error"; }
    }
    setBatchProgress(`画像を解析中... (${idx + 1}/${itemsToAnalyze.length})`, ((idx + 1) / itemsToAnalyze.length) * 100, true);
  }
  await worker.terminate();
  statusMsg.innerText = "処理完了";
  hideBatchProgress();
  showBatchWarningSummary();
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
    const issues = editorQueue.flatMap(item => (item.warnings || []).filter(w => w.level === 'warn' || w.level === 'error').map(w => `${item.data.title || '名称未設定'}: ${w.message}`));
    if (issues.length > 0) {
      const preview = issues.slice(0, 4).join('\n');
      const suffix = issues.length > 4 ? `\n...他${issues.length - 4}件` : '';
      const ok = confirm(`注意が必要な項目があります。\n\n${preview}${suffix}\n\nこのままGoogle Driveへアップロードしますか？`);
      if (!ok) {
        checkBatchButton();
        btn.innerText = editorQueue.length > 0 ? `全てアップロード (${editorQueue.length}件)` : '全てアップロード';
        return;
      }
    }
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

  const total = editorQueue.length || 1;
  setBatchProgress('Google Drive にアップロード中...', 0, true);

  for (const [idx, item] of [...editorQueue].entries()) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "送信中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      await createNewRecord(item.file, item.data, (uploadRatio) => {
        const progress = ((idx + uploadRatio) / total) * 100;
        setBatchProgress(`Google Drive にアップロード中... (${idx + 1}/${total})`, progress, true);
      });
      newlyAdded.push(buildAchievementCandidate(item.data));

      editorQueue = editorQueue.filter(q => q.id !== item.id);
      const sb = document.getElementById(`sb-${item.id}`);
      if (sb) sb.remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
  }
  hideBatchProgress();
  finishExecution(successCount, "アップロード", beforeSnapshot, newlyAdded);
}


async function executeEdits() {
  let successCount = 0;
  const beforeSnapshot = allRecords.slice();
  const newlyAdded = [];

  setBatchProgress('保存中...', 0, true);

  for (const [idx, item] of [...editorQueue].entries()) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "保存中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      await updateExistingRecord(item);
      newlyAdded.push(buildAchievementCandidate(item.data));

      editorQueue = editorQueue.filter(q => q.id !== item.id);
      const sb = document.getElementById(`sb-${item.id}`);
      if (sb) sb.remove();
      successCount++;
      setBatchProgress(`保存中... (${idx + 1}/${beforeSnapshot.length})`, ((idx + 1) / Math.max(beforeSnapshot.length, 1)) * 100, true);
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
  }
  hideBatchProgress();
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
    showBatchWarningSummary();
  }
}
