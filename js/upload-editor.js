/*
 * upload-editor.js
 * -----------------------------------------------------------------------
 * 「画像アップロード・編集」モーダルのロジック全体。
 *   - ドロップゾーン/ファイル選択でのキュー追加(読み込み進捗を表示)
 *   - 編集モードでは、Drive上の画像本体を認証済みAPI経由で取得してプレビュー表示・
 *     OCR解析できるようにする(thumbnailLinkをcrossorigin付きで読み込むと表示・解析の
 *     両方が失敗していた不具合の修正。ensureItemImageLoaded/loadFullImageForItem を参照)
 *   - 画像ごとの機種プロファイル自動選択(解像度・アスペクト比から)
 *   - OCR解析の実行 (PERFECT/GREAT/GOOD/BAD/MISS + コンボ数を含む)
 *   - フォーム編集 (曲名・レベル・難易度・判定内訳・コンボ・機種)。曲名はマスターDBからの
 *     リアルタイム候補(ひらがな読み対応)を選択でき、手動編集のたびに矛盾を再チェックする
 *   - Google Driveへの保存実行時、矛盾/警告が残っていれば確認ダイアログを挟む
 *   - 保存実行 (新規アップロード / 既存レコードの更新。アップロードはバイト単位の進捗を表示) と
 *     自己ベスト通知への橋渡し
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
  setPreviewLoading(false);

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
  // blob: URL(ローカル選択ファイル・Driveから取得した画像の両方)を解放してメモリを開放する。
  editorQueue.forEach(revokeQueueItemBlobUrl);
}

function revokeQueueItemBlobUrl(item) {
  if (item && item.imgUrl && item.imgUrl.indexOf('blob:') === 0) {
    try { URL.revokeObjectURL(item.imgUrl); } catch (e) { /* noop */ }
  }
}

// ============================================================
// 進捗バー (画像の読み込み・解析・Driveアップロードで共通利用)
// ============================================================

function showBatchProgress(percent, label) {
  const wrap = document.getElementById('batch-progress-wrap');
  const bar = document.getElementById('batch-progress-bar');
  if (wrap) wrap.style.display = 'block';
  if (bar) bar.style.width = clamp(percent, 0, 100) + '%';
  if (label) document.getElementById('batch-status-msg').innerText = label;
}

function hideBatchProgress() {
  const wrap = document.getElementById('batch-progress-wrap');
  const bar = document.getElementById('batch-progress-bar');
  if (bar) bar.style.width = '0%';
  if (wrap) wrap.style.display = 'none';
}

function setPreviewLoading(isLoading) {
  const overlay = document.getElementById('batch-preview-loading');
  if (overlay) overlay.style.display = isLoading ? 'flex' : 'none';
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

  // 曲名の手動入力欄: マスターDBからのリアルタイム候補 (ひらがな読み対応)。
  attachAutocomplete(document.getElementById('up-title'), {
    getSuggestions: (q) => searchMusicCandidates(q, 8),
    getPrimaryText: (m) => m.title,
    getSecondaryText: (m) => m.pronunciation || '',
    onSelect: (m) => applyTitleSelection(m),
    emptyText: '一致する楽曲が見つかりません',
  });
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

  const profiles = getDeviceProfiles();
  const newItems = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    showBatchProgress((i / total) * 100, `画像を読み込み中... (${i + 1}/${total})`);

    const qId = "new_" + Date.now() + "_" + i;
    const imgUrl = URL.createObjectURL(file);

    // 画像の画素数・アスペクト比から、保存済みの機種プロファイルを自動選択する
    const dims = await getImageDimensions(imgUrl);
    const profile = findBestProfileForImage(dims.width, dims.height, profiles);

    const item = {
      id: qId,
      file: file,
      imgUrl: imgUrl,
      thumbUrl: imgUrl,
      imageLoadStatus: 'ready', // ローカル選択ファイルはblob URLが即座に使えるので最初からready
      mimeType: file.type,
      status: 'pending',
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
  showBatchProgress(100, `画像の読み込みが完了しました (${total}件)`);

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
    // サイドバーの小さいプレビューには軽量なDriveサムネイル(thumbnailLink)をそのまま使う
    // (crossorigin無しでの表示は、Googleのログインセッションに依存する形で問題なく機能する)。
    // 編集・OCR解析用の高解像度画像は fetchDriveFileBytesAsBlobUrl 経由で別途取得する
    // (「画像一覧からの編集で画像が表示されず解析もできない」不具合の修正。詳細は
    // drive-client.js の fetchDriveFileBytesAsBlobUrl コメントを参照)。
    const thumbUrl = rec.thumbnail ? rec.thumbnail.replace('=s220', '=w400') : '';
    const profile = resolveDeviceProfileForRecord(rec);

    const item = {
      id: qId,
      file: null,
      imgUrl: null,
      thumbUrl: thumbUrl,
      imageLoadStatus: 'loading',
      mimeType: rec.mimeType || '',
      status: 'existing',
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
    revalidateItem(item); // 保存済みデータに既に矛盾が無いかを、編集開始時点で可視化する
  }
  if (editorQueue.length > 0) selectItem(editorQueue[0].id);
  checkBatchButton();
  document.getElementById('batch-status-msg').innerText = "編集準備完了";

  await prepareEditQueueImages(editorQueue.slice());
}

// 編集モードで選択した全レコードの画像本体を、進捗表示付きでまとめて取得する。
// Drive APIを同時に叩きすぎないよう、ゆるい同時実行数制限をかけている。
async function prepareEditQueueImages(items) {
  if (items.length === 0) return;
  const total = items.length;
  let done = 0;
  showBatchProgress(0, `画像を取得中... (0/${total})`);

  const concurrency = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try { await ensureItemImageLoaded(item); } catch (e) { /* エラー状態はitem側(サイドバー)に反映済み */ }
      done++;
      showBatchProgress((done / total) * 100, `画像を取得中... (${done}/${total})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  showBatchProgress(100, `画像の取得が完了しました (${total}件)`);
  setTimeout(hideBatchProgress, 600);
}

// item.imgUrl がまだ用意できていない(編集モードでDriveからの取得が未完了)場合に完了を待つ。
// 取得中でなければ新たに取得を開始する。同一itemに対して複数回呼ばれても再取得はしない。
function ensureItemImageLoaded(item) {
  if (item.imageLoadStatus === 'ready' && item.imgUrl) return Promise.resolve();
  if (!item._imageLoadPromise) item._imageLoadPromise = loadFullImageForItem(item);
  return item._imageLoadPromise;
}

async function loadFullImageForItem(item) {
  if (!item.originalId) return; // アップロードモードの項目(ローカルファイル)は対象外
  item.imageLoadStatus = 'loading';
  updateSidebarStatus(item.id);
  if (activeItemId === item.id) setPreviewLoading(true);
  try {
    const blobUrl = await fetchDriveFileBytesAsBlobUrl(item.originalId);
    item.imgUrl = blobUrl;
    item.imageLoadStatus = 'ready';
    if (activeItemId === item.id) {
      document.getElementById('batch-preview-img').src = blobUrl;
      setPreviewLoading(false);
    }
  } catch (e) {
    console.error('画像の取得に失敗しました', item.id, e);
    item.imageLoadStatus = 'error';
    if (activeItemId === item.id) setPreviewLoading(false);
    throw e;
  } finally {
    item._imageLoadPromise = null;
    updateSidebarStatus(item.id);
  }
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

  const previewSrc = item.thumbUrl || item.imgUrl || '';
  const initialLabel = item.status === 'existing' ? 'EXIST' : item.status;
  div.innerHTML = `
      <img src="${previewSrc}" class="sidebar-thumb">
      <div class="sidebar-info">
          <div class="sidebar-title" id="sb-title-${id}">${escapeHtml(item.data.title) || "名称未設定"}</div>
          <div class="sidebar-status">
              <span id="sb-status-${id}" class="upload-status ${item.status === 'existing' ? 'done' : item.status}">${initialLabel}</span>
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

  if (item.imageLoadStatus === 'ready' && item.imgUrl) {
    document.getElementById('batch-preview-img').src = item.imgUrl;
    setPreviewLoading(false);
  } else {
    document.getElementById('batch-preview-img').removeAttribute('src');
    setPreviewLoading(item.imageLoadStatus !== 'error');
    ensureItemImageLoaded(item).catch(() => {}); // エラー状態はサイドバー側で表示するのでここでは握りつぶす
  }

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
  renderFormWarnings(item);
}

// 実測ログ・矛盾チェックの結果を、フォーム上部の小さなバナーとして表示する。
// item.warnings が未設定(=OCR解析も手動チェックもまだ行っていない)の間はバナー自体を
// 出さない。判定済み(0件を含む)であれば、0件でも「矛盾なし」を積極的に表示する。
// 詳細(切り出し画像・OCRテキスト等)は「実測ログを見る」ボタンから確認できる。
function renderFormWarnings(item) {
  const banner = document.getElementById('form-warnings-banner');
  const logBtn = document.getElementById('btn-view-log');
  if (!banner || !logBtn) return;

  logBtn.disabled = !item.debugLog;

  if (!item.warnings) {
    banner.style.display = 'none';
    banner.innerHTML = '';
    return;
  }

  if (item.warnings.length === 0) {
    banner.style.display = 'flex';
    banner.className = 'form-warnings-banner banner-ok';
    banner.innerHTML = `<span class="material-symbols-outlined">check_circle</span><span>目立った矛盾は検出されませんでした</span>`;
    return;
  }

  banner.style.display = 'flex';
  const hasError = item.warnings.some(w => w.level === 'error');
  const hasWarn = item.warnings.some(w => w.level === 'warn');
  const icon = hasError ? 'error' : (hasWarn ? 'warning' : 'info');
  const cls = hasError ? 'banner-error' : (hasWarn ? 'banner-warn' : 'banner-info');
  const extra = item.warnings.length > 1 ? ` (他${item.warnings.length - 1}件)` : '';
  banner.className = 'form-warnings-banner ' + cls;
  banner.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${escapeHtml(item.warnings[0].message)}${extra}</span>`;
}

// itemの現在のdata(手動編集後の値を含む)を再チェックし、矛盾があれば item.warnings に
// 反映する。フォームの各入力欄の編集イベント、および編集キュー構築時(既存データの矛盾を
// 可視化するため)から呼ばれる(改善要望「手動修正するとリアルタイムで矛盾検知」への対応)。
function revalidateItem(item) {
  const result = checkManualEditWarnings(item.data);
  item.warnings = result.warnings;
  if (activeItemId === item.id) renderFormWarnings(item);
  updateSidebarStatus(item.id);
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
    // 候補選択で紐付けたmusicIdと文字列が食い違う状態になったら紐付けを外す
    // (紐付いたままだと無関係な楽曲のノーツ数・レベルと突き合わせてしまうため)。
    if (item.data.musicId) {
      const m = getMusicById(item.data.musicId);
      if (!m || m.title !== value) item.data.musicId = null;
    }
  }

  item.status = 'done';
  revalidateItem(item);
}

// 曲名候補ドロップダウンで曲を選んだ際の反映処理 (autocomplete.js から呼ばれる)。
function applyTitleSelection(music) {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (!item) return;

  item.data.title = music.title;
  item.data.musicId = music.id;
  document.getElementById('up-title').value = music.title;
  document.getElementById(`sb-title-${activeItemId}`).innerText = music.title;

  // レベルはDBの値を優先して自動入力する(難易度切替時の挙動と揃える)
  const dbKey = getDiffDbKey(item.data.diff);
  const dbLevel = getLevelFromDb(music.id, dbKey);
  if (dbLevel != null) {
    item.data.level = dbLevel;
    document.getElementById('up-level').value = dbLevel;
  }

  item.status = 'done';
  revalidateItem(item);
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
  if (!statusEl) return;

  if (item.imageLoadStatus === 'loading') {
    statusEl.innerText = "画像取得中"; statusEl.className = "upload-status processing";
    return;
  }
  if (item.imageLoadStatus === 'error') {
    statusEl.innerText = "画像取得失敗"; statusEl.className = "upload-status error";
    return;
  }
  if (!item.warnings) {
    const label = item.status === 'existing' ? 'EXIST' : (item.status || 'pending');
    statusEl.innerText = label;
    statusEl.className = `upload-status ${item.status === 'existing' ? 'done' : (item.status || 'pending')}`;
    return;
  }

  const hasError = item.warnings.some(w => w.level === 'error');
  const hasWarn = item.warnings.some(w => w.level === 'warn');

  if (hasError) { statusEl.innerText = "要確認"; statusEl.className = "upload-status warn-error"; }
  else if (hasWarn) { statusEl.innerText = "確認"; statusEl.className = "upload-status warn"; }
  else { statusEl.innerText = "OK"; statusEl.className = "upload-status done"; }
}

function removeBatchItem(e, id) {
  e.stopPropagation();
  const item = editorQueue.find(q => q.id === id);
  revokeQueueItemBlobUrl(item);
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
  const total = itemsToAnalyze.length;
  showBatchProgress(0, `解析中... (0/${total})`);

  const worker = await Tesseract.createWorker(['jpn', 'eng']);

  for (let i = 0; i < itemsToAnalyze.length; i++) {
    const item = itemsToAnalyze[i];
    const el = document.getElementById(`sb-status-${item.id}`);
    if (el) { el.innerText = "解析中"; el.className = "upload-status processing"; }
    showBatchProgress((i / total) * 100, `解析中... (${i + 1}/${total})`);

    try {
      // 編集モードの項目で画像本体(blob URL)がまだ無ければ先に取得する。
      await ensureItemImageLoaded(item);

      const img = new Image();
      img.src = item.imgUrl; // blob: URLなので同一オリジン扱い(crossOrigin指定は不要)
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
      if (activeItemId === item.id) selectItem(item.id);
    } else {
      const statEl = document.getElementById(`sb-status-${item.id}`);
      if (statEl) { statEl.innerText = "ERR"; statEl.className = "upload-status error"; }
    }
  }
  await worker.terminate();
  showBatchProgress(100, `処理完了 (${total}件)`);
  setTimeout(hideBatchProgress, 600);
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

// 矛盾/警告が残っている項目があれば、確認ダイアログを挟んでから実行する。
function handleBatchExecution() {
  const itemsWithIssues = editorQueue.filter(it => (it.warnings || []).length > 0);
  if (itemsWithIssues.length > 0) {
    showWarningsConfirmModal(itemsWithIssues);
    return;
  }
  runQueuedExecution();
}

function showWarningsConfirmModal(items) {
  const list = document.getElementById('confirm-warnings-list');
  list.innerHTML = items.map(it => {
    const hasError = it.warnings.some(w => w.level === 'error');
    const hasWarn = it.warnings.some(w => w.level === 'warn');
    const level = hasError ? 'error' : (hasWarn ? 'warn' : 'info');
    const icon = hasError ? 'error' : (hasWarn ? 'warning' : 'info');
    const extra = it.warnings.length > 1 ? ` (他${it.warnings.length - 1}件)` : '';
    return `
      <li class="confirm-warning-item confirm-warning-${level}">
        <span class="material-symbols-outlined">${icon}</span>
        <div><strong>${escapeHtml(it.data.title || '(曲名未設定)')}</strong><br>${escapeHtml(it.warnings[0].message)}${extra}</div>
      </li>`;
  }).join('');
  document.getElementById('confirmWarningsModal').style.display = 'flex';
}

function cancelPendingExecution() {
  document.getElementById('confirmWarningsModal').style.display = 'none';
}

function proceedPendingExecution() {
  document.getElementById('confirmWarningsModal').style.display = 'none';
  runQueuedExecution();
}

async function runQueuedExecution() {
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
  const items = [...editorQueue];
  const total = items.length;
  showBatchProgress(0, `Google Driveにアップロード中... (0/${total})`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "送信中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足(曲名・レベルは必須です)");

      await createNewRecord(item.file, item.data, (frac) => {
        showBatchProgress(((i + frac) / total) * 100, `Google Driveにアップロード中... (${i + 1}/${total})`);
      });
      newlyAdded.push(buildAchievementCandidate(item.data));

      revokeQueueItemBlobUrl(item);
      editorQueue = editorQueue.filter(q => q.id !== item.id);
      document.getElementById(`sb-${item.id}`).remove();
      successCount++;
      showBatchProgress(((i + 1) / total) * 100, `Google Driveにアップロード中... (${i + 1}/${total})`);
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
  const items = [...editorQueue];
  const total = items.length;
  showBatchProgress(0, `保存中... (0/${total})`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "保存中"; sbStatus.className = "upload-status processing"; }

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足(曲名・レベルは必須です)");

      await updateExistingRecord(item);
      newlyAdded.push(buildAchievementCandidate(item.data));

      revokeQueueItemBlobUrl(item);
      editorQueue = editorQueue.filter(q => q.id !== item.id);
      document.getElementById(`sb-${item.id}`).remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
    showBatchProgress(((i + 1) / total) * 100, `保存中... (${i + 1}/${total})`);
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
  }
}
