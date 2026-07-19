/*
 * upload-editor.js
 * -----------------------------------------------------------------------
 * 「画像アップロード・編集」モーダルのロジック全体。
 *   - ドロップゾーン/ファイル選択でのキュー追加
 *   - 画像ごとの機種プロファイル自動選択(解像度・アスペクト比から)
 *   - 曲名欄のオートコンプリート(マスターDB全曲、かな入力対応。title-autocomplete.js)
 *   - OCR解析の実行 (PERFECT/GREAT/GOOD/BAD/MISS + コンボ数を含む)。進捗をバーで可視化。
 *   - フォーム編集 (曲名・レベル・難易度・判定内訳・コンボ・機種)。編集のたびに
 *     result-reconciler.js の reconcileEditedData でリアルタイムに矛盾を検知・解消する。
 *   - 編集対象画像の取得: 一覧のサムネイル(thumbnailLink)は低解像度・CORSの都合で
 *     canvas解析に使えないため、Drive APIから認証付きで本体を取得しBlob URL化する
 *     (drive-client.js の fetchDriveFileBlobUrl)。
 *   - 保存実行 (新規アップロード / 既存レコードの更新)。矛盾が残っている項目がある
 *     状態で実行しようとした場合は確認モーダルを挟む。アップロードはXHRの送信進捗を
 *     使ってリアルタイムに進捗を表示する。
 *   - 自己ベスト通知への橋渡し
 * -----------------------------------------------------------------------
 */

// ============================================================
// モーダルの開閉
// ============================================================

function openBatchModal(mode) {
  currentMode = mode;
  const modal = document.getElementById('batchModal');
  modal.style.display = 'flex';

  revokeQueueImageUrls(editorQueue);
  editorQueue = [];
  activeItemId = null;
  document.getElementById('batch-sidebar-list').innerHTML = "";
  document.getElementById('batch-editor-container').style.display = 'none';
  document.getElementById('batch-empty-msg').style.display = 'block';
  document.getElementById('batch-status-msg').innerText = "待機中...";
  hideBatchProgress();
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

// アップロード用(ローカルファイル)・編集用(Driveから取得)いずれの画像も
// URL.createObjectURL() で作った Blob URL のため、使い終わったら明示的に解放する。
function revokeItemImageUrl(item) {
  if (item && item.imgUrl && item.imgUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(item.imgUrl); } catch (e) { /* noop */ }
  }
}
function revokeQueueImageUrls(queue) {
  (queue || []).forEach(revokeItemImageUrl);
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
  initTitleAutocompleteForUpload();
}

// 曲名欄のオートコンプリート。候補ソースはマスターDB全曲(dbMusics)。
// かな入力対応は title-autocomplete.js 側の normalizeKanaSearch で行う。
function initTitleAutocompleteForUpload() {
  const inputEl = document.getElementById('up-title');
  initTitleAutocomplete({
    inputEl,
    getSource: () => (dbMusics || []).map(m => ({ title: m.title, pronunciation: m.pronunciation, musicRef: m })),
    onSelect: (it) => selectTitleFromAutocomplete(it.musicRef),
    limit: 8,
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
  document.getElementById('batch-status-msg').innerText = "画像を読み込み中...";

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
      imgLoadStatus: 'ready', // ローカルファイルなので即座に利用可能
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
    const profile = resolveDeviceProfileForRecord(rec);

    const item = {
      id: qId,
      file: null,
      imgUrl: '',
      imgLoadStatus: 'loading', // 画像本体はこの後Driveから取得する(下記ループ)
      mimeType: rec.mimeType || '',
      status: 'existing',
      schema: rec.schema,
      data: {
        title: rec.title, level: rec.level, diff: rec.difficultyRaw,
        // 新方式のレコードは実際の内訳が分かっているのでそのまま使う。
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
    // 画像取得を待たず、Driveに保存済みのデータそのものに矛盾が無いかを先に確認する
    // (これにより「編集を開くと同時に」矛盾がリアルタイムで分かる)。
    runLiveReconcile(item);
  }

  if (editorQueue.length > 0) selectItem(editorQueue[0].id);
  checkBatchButton();

  // 画像本体をDriveから認証付きで取得する。一覧のサムネイル(thumbnailLink)は
  // 解像度が低く、CORSの都合でcanvas解析(二値化・OCR)にも使えないため、
  // 編集・再解析では必ずファイル本体を取得しBlob URL化してから使う。
  const targetItems = editorQueue.filter(it => it.imgLoadStatus === 'loading');
  if (targetItems.length > 0) {
    const total = targetItems.length;
    let loaded = 0;
    showBatchProgress(0);
    for (const item of targetItems) {
      document.getElementById('batch-status-msg').innerText = `画像を読み込み中... (${loaded}/${total}枚)`;
      try {
        const url = await fetchDriveFileBlobUrl(item.originalId);
        item.imgUrl = url;
        item.imgLoadStatus = 'ready';
      } catch (e) {
        console.error('画像の取得に失敗しました', e);
        item.imgLoadStatus = 'error';
      }
      loaded++;
      updateSidebarThumb(item.id);
      if (activeItemId === item.id) updatePreviewImage(item);
      showBatchProgress(Math.round((loaded / total) * 100));
    }
    hideBatchProgress();
  }
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
      <div class="sidebar-thumb-wrap" id="sb-thumb-wrap-${id}">
        <div class="sidebar-thumb-spinner"></div>
        <img id="sb-thumb-${id}" class="sidebar-thumb" style="display:none;">
      </div>
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

  // サムネイルの読み込み状態に応じてスピナー/画像/失敗アイコンを出し分ける
  // (画像本体がまだDriveから取得できていない編集モードのために必要)。
  const imgEl = div.querySelector(`#sb-thumb-${id}`);
  imgEl.addEventListener('load', () => {
    imgEl.style.display = 'block';
    const spinner = div.querySelector('.sidebar-thumb-spinner');
    if (spinner) spinner.style.display = 'none';
  });
  imgEl.addEventListener('error', () => {
    const wrap = document.getElementById(`sb-thumb-wrap-${id}`);
    if (wrap) wrap.innerHTML = '<span class="material-symbols-outlined sidebar-thumb-error" title="画像を読み込めませんでした">broken_image</span>';
  });
  if (item.imgUrl) imgEl.src = item.imgUrl;
}

// item.imgUrl が(非同期に)後から確定した/失敗した際に、サイドバーのサムネイル表示を更新する。
function updateSidebarThumb(id) {
  const item = editorQueue.find(q => q.id === id);
  const imgEl = document.getElementById(`sb-thumb-${id}`);
  if (!item || !imgEl) return;
  if (item.imgLoadStatus === 'error') {
    const wrap = document.getElementById(`sb-thumb-wrap-${id}`);
    if (wrap) wrap.innerHTML = '<span class="material-symbols-outlined sidebar-thumb-error" title="画像を読み込めませんでした">broken_image</span>';
    return;
  }
  if (item.imgUrl) imgEl.src = item.imgUrl;
}

// メインプレビュー(#batch-preview-img)を item の画像読み込み状態に応じて更新する。
function updatePreviewImage(item) {
  const img = document.getElementById('batch-preview-img');
  const loading = document.getElementById('preview-loading');
  const failed = document.getElementById('preview-failed');
  if (item.imgLoadStatus === 'error') {
    img.style.visibility = 'hidden';
    if (loading) loading.style.display = 'none';
    if (failed) failed.style.display = 'flex';
    return;
  }
  if (failed) failed.style.display = 'none';
  if (item.imgLoadStatus === 'loading' || !item.imgUrl) {
    img.style.visibility = 'hidden';
    if (loading) loading.style.display = 'flex';
  } else {
    img.src = item.imgUrl;
    img.style.visibility = 'visible';
    if (loading) loading.style.display = 'none';
  }
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

  updatePreviewImage(item);

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

// 総合判断/矛盾チェックの結果を、フォーム上部の小さなバナーとして表示する。
// item.debugLog(OCR実測ログ)の有無に関わらず item.warnings があれば表示する
// (手動編集のみで一度もOCRを実行していない編集レコードでも、リアルタイム矛盾検知の
// 結果をここに出すため。「実測ログを見る」ボタンの有効/無効だけはdebugLogの有無で判定する)。
function renderFormWarnings(item) {
  const banner = document.getElementById('form-warnings-banner');
  const logBtn = document.getElementById('btn-view-log');
  if (!banner || !logBtn) return;

  logBtn.disabled = !item.debugLog;

  const warnings = item.warnings || [];
  const hasError = warnings.some(w => w.level === 'error');
  const hasWarn = warnings.some(w => w.level === 'warn');
  banner.style.display = 'flex';

  if (warnings.length === 0) {
    banner.className = 'form-warnings-banner banner-ok';
    banner.innerHTML = `<span class="material-symbols-outlined">check_circle</span><span>目立った矛盾は検出されませんでした</span>`;
    return;
  }
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
    // オートコンプリートを使わず自由入力された場合でも、入力内容がマスターDBの
    // タイトルと完全一致(表記ゆれ正規化後)すれば自動的に紐付ける。それ以外は
    // musicId をクリアする(古い曲に紐付いたままレベル等がズレるのを防ぐ)。
    // 部分一致の段階で紐付けてしまうと入力中の文字ごとに揺れ動いてしまうため、
    // 確実な紐付けはオートコンプリートの選択(selectTitleFromAutocomplete)を
    // 主経路とし、ここでは「完全一致」のみを対象にしている。
    const normTyped = normalizeString(value);
    const exact = normTyped ? (dbMusics || []).find(m => normalizeString(m.title) === normTyped) : null;
    item.data.musicId = exact ? exact.id : null;
    document.getElementById(`sb-title-${activeItemId}`).innerText = value || "名称未設定";
  }

  if (['good', 'bad', 'missDetail'].includes(field)) {
    item.data.totalMiss = item.data.good + item.data.bad + item.data.missDetail;
    document.getElementById('up-total-miss').innerText = item.data.totalMiss;
  }

  item.status = 'done';
  updateSidebarStatus(activeItemId);
  scheduleLiveReconcile(item);
}

// 曲名オートコンプリートで候補が選択された時の処理。曲名・musicIdを確定させ、
// レベル自動補完・矛盾チェックを即座に行う(明示的な選択操作のためデバウンスしない)。
function selectTitleFromAutocomplete(music) {
  if (!activeItemId || !music) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (!item) return;
  item.data.title = music.title;
  item.data.musicId = music.id;
  document.getElementById('up-title').value = music.title;
  document.getElementById(`sb-title-${activeItemId}`).innerText = music.title;
  item.status = 'done';
  updateSidebarStatus(activeItemId);
  runLiveReconcile(item);
}

// ============================================================
// リアルタイム矛盾検知・解消 (手動編集のたび)
// ============================================================
// result-reconciler.js の reconcileEditedData を使い、現在のフォーム内容から
// 「曲・難易度が決まれば一意に決まるレベル」を補正しつつ、総ノーツ数・コンボ数の
// 矛盾を検知する。runLiveReconcile は即時実行版(オートコンプリート選択・難易度
// セレクト変更など、離散的で1回限りの操作から呼ぶ)、scheduleLiveReconcile は
// デバウンス版(数値入力欄の連続したキー入力から呼ぶ。入力の度に矛盾チェックが
// 走ってUIがちらつくのを防ぐ)。

function runLiveReconcile(item) {
  const result = reconcileEditedData(item.data);
  item.data.level = result.level;
  item.warnings = result.warnings;
  if (activeItemId === item.id) {
    const levelInput = document.getElementById('up-level');
    // ユーザーが今まさにレベル欄を編集中の場合は、その場で値を書き換えて
    // カーソル位置がおかしくなる・入力中の値が消えるのを避ける。
    if (document.activeElement !== levelInput) levelInput.value = item.data.level;
    renderFormWarnings(item);
  }
  updateSidebarStatus(item.id);
}
const scheduleLiveReconcile = debounce(runLiveReconcile, 200);

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
  const warnings = item.warnings || [];
  const hasError = warnings.some(w => w.level === 'error');
  const hasWarn = warnings.some(w => w.level === 'warn');

  if (hasError) { statusEl.innerText = "要確認"; statusEl.className = "upload-status warn-error"; }
  else if (hasWarn) { statusEl.innerText = "確認"; statusEl.className = "upload-status warn"; }
  else { statusEl.innerText = "OK"; statusEl.className = "upload-status done"; }
}

function removeBatchItem(e, id) {
  e.stopPropagation();
  const item = editorQueue.find(q => q.id === id);
  revokeItemImageUrl(item);
  editorQueue = editorQueue.filter(q => q.id !== id);
  const sbEl = document.getElementById(`sb-${id}`);
  if (sbEl) sbEl.remove();
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
  statusMsg.innerText = "解析準備中...";
  showBatchProgress(0);

  const worker = await Tesseract.createWorker(['jpn', 'eng']);
  // 難易度・楽曲レベル・曲名・判定内訳・コンボ数の5項目をもって「1枚分」とし、
  // 項目が完了するたびに進捗バーを更新する(ocr-analyzer.js の onFieldDone コールバック)。
  const totalSteps = itemsToAnalyze.length * 5;
  let doneSteps = 0;
  let imgIndex = 0;

  for (const item of itemsToAnalyze) {
    imgIndex++;
    const el = document.getElementById(`sb-status-${item.id}`);
    if (el) { el.innerText = "解析中"; el.className = "upload-status processing"; }
    statusMsg.innerText = `解析中... (${imgIndex}/${itemsToAnalyze.length}枚)`;

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
      const raw = await analyzeLoadedImage(img, worker, regions, () => {
        doneSteps++;
        showBatchProgress(Math.round((doneSteps / totalSteps) * 100));
      });
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
        doneSteps = imgIndex * 5;
        showBatchProgress(Math.round((doneSteps / totalSteps) * 100));
      }
    } catch (e) {
      console.error("Analysis Failed for " + item.id, e);
      item.status = 'error';
      doneSteps = imgIndex * 5;
      showBatchProgress(Math.round((doneSteps / totalSteps) * 100));
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
  hideBatchProgress();
  statusMsg.innerText = "処理完了";
}

async function reanalyzeCurrentItem() {
  if (!activeItemId) return;
  const item = editorQueue.find(q => q.id === activeItemId);
  if (!item) return;
  if (item.imgLoadStatus === 'loading') {
    alert('画像を読み込み中です。読み込み完了後にもう一度お試しください。');
    return;
  }
  if (item.imgLoadStatus === 'error') {
    alert('画像の取得に失敗しているため解析できません。');
    return;
  }
  await runBatchAnalysis([item]);
}

async function analyzeAllInBatch() {
  if (editorQueue.length === 0) return;
  await runBatchAnalysis(editorQueue);
}

// ============================================================
// 保存実行 (アップロード / 編集)
// ============================================================

// 矛盾(warn/error)が残っている項目が無いか確認する。あれば確認モーダルを挟み、
// ユーザーが明示的に「続行」を選んだ場合のみ実行する。
async function handleBatchExecution() {
  // デバウンス待ちの間に古い矛盾チェック結果で判定してしまわないよう、
  // 直前の入力内容で同期的に再チェックしてから判定する。
  editorQueue.forEach(it => runLiveReconcile(it));

  const itemsWithIssues = editorQueue.filter(it => (it.warnings || []).some(w => w.level === 'warn' || w.level === 'error'));
  if (itemsWithIssues.length > 0) {
    openContradictionConfirmModal(itemsWithIssues);
    return;
  }
  await proceedBatchExecution();
}

async function proceedBatchExecution() {
  const btn = document.getElementById('btn-exec-batch');
  btn.disabled = true;
  btn.innerText = "処理中...";

  if (currentMode === 'upload') {
    await executeUploads();
  } else {
    await executeEdits();
  }
}

function openContradictionConfirmModal(items) {
  const modal = document.getElementById('contradictionModal');
  const list = document.getElementById('contradiction-list');
  list.innerHTML = items.map(it => {
    const warns = it.warnings || [];
    const top = warns[0];
    const extra = warns.length > 1 ? ` (他${warns.length - 1}件)` : '';
    const hasError = warns.some(w => w.level === 'error');
    return `
      <div class="contradiction-item">
        <span class="material-symbols-outlined ${hasError ? 'contradiction-icon-error' : 'contradiction-icon-warn'}">${hasError ? 'error' : 'warning'}</span>
        <div class="contradiction-item-body">
          <div class="contradiction-item-title">${escapeHtml(it.data.title || '(曲名未設定)')}</div>
          <div class="contradiction-item-msg">${top ? escapeHtml(top.message) : ''}${extra}</div>
        </div>
      </div>`;
  }).join('');
  modal.style.display = 'flex';
}

function closeContradictionModal() {
  document.getElementById('contradictionModal').style.display = 'none';
}

async function confirmProceedDespiteWarnings() {
  closeContradictionModal();
  await proceedBatchExecution();
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
  const total = editorQueue.length;
  let completed = 0;
  showBatchProgress(0);

  for (const item of [...editorQueue]) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "送信中 0%"; sbStatus.className = "upload-status processing"; }
    document.getElementById('batch-status-msg').innerText = `アップロード中... (${completed}/${total}件)`;

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      // XHRの送信進捗をもとに、この画像単体の進捗(サイドバー)と全体の進捗(進捗バー)の
      // 両方をリアルタイムに更新する。
      await createNewRecord(item.file, item.data, (frac) => {
        if (sbStatus) sbStatus.innerText = `送信中 ${Math.round(frac * 100)}%`;
        showBatchProgress(Math.round(((completed + frac) / total) * 100));
      });
      newlyAdded.push(buildAchievementCandidate(item.data));

      revokeItemImageUrl(item);
      editorQueue = editorQueue.filter(q => q.id !== item.id);
      const sbEl = document.getElementById(`sb-${item.id}`);
      if (sbEl) sbEl.remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
    completed++;
    showBatchProgress(Math.round((completed / total) * 100));
  }
  hideBatchProgress();
  finishExecution(successCount, "アップロード", beforeSnapshot, newlyAdded);
}

async function executeEdits() {
  let successCount = 0;
  const beforeSnapshot = allRecords.slice();
  const newlyAdded = [];
  const total = editorQueue.length;
  let completed = 0;
  showBatchProgress(0);

  for (const item of [...editorQueue]) {
    const sbStatus = document.getElementById(`sb-status-${item.id}`);
    if (sbStatus) { sbStatus.innerText = "保存中"; sbStatus.className = "upload-status processing"; }
    document.getElementById('batch-status-msg').innerText = `保存中... (${completed}/${total}件)`;

    try {
      if (!item.data.title || !item.data.level) throw new Error("必須項目不足");

      await updateExistingRecord(item);
      newlyAdded.push(buildAchievementCandidate(item.data));

      revokeItemImageUrl(item);
      editorQueue = editorQueue.filter(q => q.id !== item.id);
      const sbEl = document.getElementById(`sb-${item.id}`);
      if (sbEl) sbEl.remove();
      successCount++;
    } catch (e) {
      console.error(e);
      if (sbStatus) { sbStatus.innerText = "失敗"; sbStatus.className = "upload-status error"; }
    }
    completed++;
    showBatchProgress(Math.round((completed / total) * 100));
  }
  hideBatchProgress();
  finishExecution(successCount, "更新", beforeSnapshot, newlyAdded);
}

function finishExecution(count, actionName, beforeSnapshot, newlyAdded) {
  const achievements = detectNewBests(beforeSnapshot, newlyAdded);
  document.getElementById('batch-status-msg').innerText = "処理完了";
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

// ============================================================
// 進捗バー (画像読み込み・OCR解析・Driveアップロードで共用)
// ============================================================

function showBatchProgress(percent) {
  const wrap = document.getElementById('batch-progress-wrap');
  const bar = document.getElementById('batch-progress-bar');
  if (!wrap || !bar) return;
  wrap.style.display = 'block';
  bar.style.width = clamp(percent, 0, 100) + '%';
}

function hideBatchProgress() {
  const wrap = document.getElementById('batch-progress-wrap');
  const bar = document.getElementById('batch-progress-bar');
  if (!wrap || !bar) return;
  bar.style.width = '100%';
  setTimeout(() => {
    wrap.style.display = 'none';
    bar.style.width = '0%';
  }, 200);
}
