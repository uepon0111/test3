/*
 * grid-view.js
 * -----------------------------------------------------------------------
 * ・Google Drive からのレコード取得 (fetchDataFromDrive)
 * ・絞り込み / 自己ベストのみ表示 / 並び替え (updateView)
 * ・並び替えの優先度ロジック (buildComparator) - 要件通りの多段タイブレークを実装
 * ・並び替え/絞り込み中のロード進捗バー表示 (chunked rendering)
 * ・カードのHTML組み立て (buildCardHtml) - コンボ数バッジを追加
 * ・自己ベスト更新の通知バナー
 * -----------------------------------------------------------------------
 */

// ============================================================
// データ取得
// ============================================================

async function fetchDataFromDrive() {
  const loader = document.getElementById('loader');
  loader.style.display = 'flex';
  document.getElementById('result-count').innerText = 'データ取得中...';
  document.getElementById('loader-text').innerText = 'Google Drive からリザルトを取得中...';

  try {
    allRecords = await fetchAllRecords();
    onDataLoaded();
  } catch (e) {
    console.error(e);
    loader.style.display = 'none';
    document.getElementById('result-count').innerText = 'データ取得に失敗しました';
  }
}

function onDataLoaded() {
  document.getElementById('loader').style.display = 'none';
  updateView();
}

// ============================================================
// 並び替え比較関数
// ============================================================
// 要件の優先度チェーンをそのまま実装しています。
//   名前順       : 名前(切替可) → 難易度(固定:降順) → ミス数(固定:昇順) → 追加日(固定:降順)
//   楽曲レベル順 : レベル(切替可) → 難易度(固定:降順) → 名前(固定:昇順) → ミス数(固定:昇順) → 追加日(固定:降順)
//   ミス数順     : ミス数(切替可) → レベル(固定:降順) → 難易度(固定:降順) → 名前(固定:昇順) → 追加日(固定:降順)
//   追加日順     : 追加日(切替可) のみ

function compareTitle(a, b) { return a.title.localeCompare(b.title, 'ja'); }
function compareLevel(a, b) { return (parseFloat(a.level) || 0) - (parseFloat(b.level) || 0); }
function compareDifficulty(a, b) { return getDiffRank(a.difficultyRaw) - getDiffRank(b.difficultyRaw); }
function compareMissCount(a, b) { return a.missCount - b.missCount; }
function compareCreatedDate(a, b) { return new Date(a.createdTime || 0) - new Date(b.createdTime || 0); }

function buildComparator(mode, direction) {
  const dirMul = direction === 'asc' ? 1 : -1;
  switch (mode) {
    case 'name':
      return (a, b) => dirMul * compareTitle(a, b) || -compareDifficulty(a, b) || compareMissCount(a, b) || -compareCreatedDate(a, b);
    case 'level':
      return (a, b) => dirMul * compareLevel(a, b) || -compareDifficulty(a, b) || compareTitle(a, b) || compareMissCount(a, b) || -compareCreatedDate(a, b);
    case 'miss':
      return (a, b) => dirMul * compareMissCount(a, b) || -compareLevel(a, b) || -compareDifficulty(a, b) || compareTitle(a, b) || -compareCreatedDate(a, b);
    case 'date':
      return (a, b) => dirMul * compareCreatedDate(a, b);
    default:
      return () => 0;
  }
}

// ============================================================
// 絞り込み・並び替え・描画 (ロード進捗バー付き)
// ============================================================

let renderToken = 0; // 連続入力等で古い描画処理が後から完了してしまうのを防ぐためのトークン

async function updateView() {
  if (!allRecords) return;
  const myToken = ++renderToken;

  showLoadProgress(5);
  await new Promise(requestAnimationFrame);
  if (myToken !== renderToken) return;

  const fcF = document.getElementById('filter-fc').value;
  const msMin = document.getElementById('filter-miss-min').value;
  const msMax = document.getElementById('filter-miss-max').value;
  const dfF = document.getElementById('filter-diff').value;
  const lvF = document.getElementById('filter-level').value;
  const tiF = document.getElementById('filter-title').value.trim().toLowerCase();

  let list = allRecords;

  if (showBestOnly) {
    const bestMap = computeBestRecords(list);
    const bestIds = new Set(Array.from(bestMap.values(), r => r.id));
    list = list.filter(r => bestIds.has(r.id));
  }

  list = list.filter(r => {
    if (fcF === 'fc' && !r.isFC) return false;
    if (fcF === 'unfc' && r.isFC) return false;
    if (!r.isFC) {
      const mVal = r.missCount;
      if (msMin !== "" && mVal < parseInt(msMin)) return false;
      if (msMax !== "" && mVal > parseInt(msMax)) return false;
    } else {
      if (msMin !== "" && 0 < parseInt(msMin)) return false;
    }
    if (dfF !== 'all' && r.difficultyRaw !== dfF) return false;
    if (lvF && r.level != lvF) return false;
    if (tiF && !r.title.toLowerCase().includes(tiF)) return false;
    return true;
  });

  showLoadProgress(35);
  await new Promise(requestAnimationFrame);
  if (myToken !== renderToken) return;

  const comparator = buildComparator(currentSortMode, sortDirections[currentSortMode]);
  list.sort(comparator);

  showLoadProgress(55);

  filteredRecords = list;
  await renderGridChunked(list, myToken);
  if (myToken === renderToken) hideLoadProgress();
}

async function renderGridChunked(records, myToken) {
  const grid = document.getElementById('grid');
  document.getElementById('result-count').innerText = `表示: ${records.length} 件`;
  grid.innerHTML = '';
  if (records.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:20px; color:#666;">データなし</div>';
    return;
  }

  const CHUNK_SIZE = 40;
  let rendered = 0;
  const total = records.length;

  for (let i = 0; i < total; i += CHUNK_SIZE) {
    if (myToken !== renderToken) return; // 新しい絞り込み/並び替えが実行された場合は中断
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const html = chunk.map(rec => buildCardHtml(rec)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    rendered += chunk.length;
    showLoadProgress(55 + Math.round((rendered / total) * 45));
    await new Promise(requestAnimationFrame);
  }
}

// 並び替え/絞り込み実行中であることを示すプログレスバー
function showLoadProgress(percent) {
  const wrap = document.getElementById('load-progress-wrap');
  const bar = document.getElementById('load-progress-bar');
  if (!wrap || !bar) return;
  wrap.style.display = 'block';
  bar.style.width = clamp(percent, 0, 100) + '%';
}

function hideLoadProgress() {
  const wrap = document.getElementById('load-progress-wrap');
  const bar = document.getElementById('load-progress-bar');
  if (!wrap || !bar) return;
  bar.style.width = '100%';
  setTimeout(() => {
    wrap.style.display = 'none';
    bar.style.width = '0%';
  }, 200);
}

// ============================================================
// カードのHTML組み立て
// ============================================================

function buildCardHtml(rec) {
  let thumb = rec.thumbnail ? rec.thumbnail.replace('=s220', '=w600') : '';
  let large = rec.thumbnail ? rec.thumbnail.replace('=s220', '=w1600') : '';
  const missDisplay = rec.isFC ? `<span class="miss-val zero">FC-0</span>` : `FC -<span class="miss-val">${rec.missCount}</span>`;
  const badge = rec.isFC ? `<div class="fc-badge"><span class="material-symbols-outlined" style="font-size:1rem;">crown</span> FULL COMBO</div>` : '';
  const isSel = selectedIds.has(rec.id) ? 'selected' : '';

  let clickAction = "";
  let overlayActions = "";

  if (isSelectMode) {
    clickAction = `toggleSelection('${rec.id}')`;
  } else {
    clickAction = `openImageModal('${large}')`;
    overlayActions = `
      <div class="card-overlay-actions">
          <div class="btn-overlay" onclick="event.stopPropagation(); individualEdit('${rec.id}')" title="編集"><span class="material-symbols-outlined">edit</span></div>
          <div class="btn-overlay del" onclick="event.stopPropagation(); individualDelete('${rec.id}')" title="削除"><span class="material-symbols-outlined">delete</span></div>
      </div>
    `;
  }

  // コンボ数は0(=未記録・旧データ)の場合は表示しない
  const comboRow = (rec.combo && rec.combo > 0)
    ? `<div class="combo-info"><span class="combo-info-label"><span class="material-symbols-outlined" style="font-size:0.9rem;">bolt</span>MAX COMBO</span><span class="combo-val">${rec.combo}</span></div>`
    : '';

  return `
    <div class="card ${rec.isFC ? 'is-fc' : ''} ${isSel} ${isSelectMode ? 'select-mode-active' : ''}" id="card-${rec.id}" onclick="${clickAction}">
      <div class="card-img-container">
        ${badge}
        ${overlayActions}
        <div class="img-loader-spinner"></div>
        ${thumb ? `<img src="${thumb}" class="card-img" loading="lazy" onload="this.style.opacity=1; this.previousElementSibling.style.display='none';">` : '<span style="color:#aaa;">NO IMAGE</span>'}
      </div>
      <div class="card-body">
        <div class="song-meta"><span class="tag lvl">Lv.${escapeHtml(rec.level)}</span><span class="tag diff-tag" style="background-color:${getDiffColor(rec.difficultyRaw)}">${escapeHtml(rec.difficulty)}</span></div>
        <div class="song-title">${escapeHtml(rec.title)}</div>
        <div class="score-info"><span class="score-info-label"><span class="material-symbols-outlined" style="font-size:1rem;">bar_chart</span> Result</span>${missDisplay}</div>
        ${comboRow}
      </div>
    </div>`;
}

// ============================================================
// 画像モーダル
// ============================================================

function openImageModal(src) { if (src) { document.getElementById('imageModal').style.display = "flex"; document.getElementById('modalImg').src = src; } }
function closeImageModal() { document.getElementById('imageModal').style.display = "none"; }

// ============================================================
// 並び替えUI (モード切替 + 昇順/降順トグル)
// ============================================================

function initSortControls() {
  const modeSelect = document.getElementById('sort-mode');
  modeSelect.value = currentSortMode;
  updateSortDirectionButton();

  modeSelect.addEventListener('change', () => {
    currentSortMode = modeSelect.value;
    updateSortDirectionButton();
    updateView();
  });

  document.getElementById('sort-direction-btn').addEventListener('click', () => {
    sortDirections[currentSortMode] = (sortDirections[currentSortMode] === 'asc') ? 'desc' : 'asc';
    updateSortDirectionButton();
    updateView();
  });
}

function updateSortDirectionButton() {
  const dirBtn = document.getElementById('sort-direction-btn');
  const dir = sortDirections[currentSortMode];
  if (dir === 'asc') {
    dirBtn.innerHTML = '<span class="material-symbols-outlined">arrow_upward</span>昇順';
    dirBtn.title = '昇順(クリックで降順に切替)';
  } else {
    dirBtn.innerHTML = '<span class="material-symbols-outlined">arrow_downward</span>降順';
    dirBtn.title = '降順(クリックで昇順に切替)';
  }
}

// ============================================================
// 自己ベストのみ表示トグル
// ============================================================

function initBestOnlyToggle() {
  const toggle = document.getElementById('filter-best-only');
  toggle.checked = showBestOnly;
  toggle.addEventListener('change', () => {
    showBestOnly = toggle.checked;
    updateView();
  });
}

// ============================================================
// フィルター入力欄のイベント登録
// ============================================================
// テキスト/数値系の入力(連続して入力されうるもの)は軽くデバウンスをかけ、
// 絞り込み処理(進捗バー付き)が入力の度に何度も走ってしまうのを避ける。
// select(即時に確定する操作)は変更のたびに即座に反映する。
function initFilterControls() {
  const debouncedUpdate = debounce(updateView, 150);
  ['filter-miss-min', 'filter-miss-max', 'filter-title', 'filter-level'].forEach(id => {
    document.getElementById(id).addEventListener('input', debouncedUpdate);
  });
}

// ============================================================
// 自己ベスト更新の通知バナー
// ============================================================

function showNewBestNotifications(achievements) {
  if (!achievements || achievements.length === 0) return;
  const area = document.getElementById('notification-area');
  area.style.display = 'flex';
  achievements.forEach(a => {
    const el = document.createElement('div');
    el.className = 'best-notification';
    const diffChip = `<span class="best-notification-diff" style="background-color:${getDiffColor(a.record.difficultyRaw)}">${escapeHtml(getDiffLabel(a.record.difficultyRaw))}</span>`;
    const detail = a.previous.missCount === 0
      ? `FULL COMBO 継続中`
      : `ミス数 ${a.previous.missCount} → ${a.record.missCount}`;
    el.innerHTML = `
      <span class="material-symbols-outlined best-notification-icon">emoji_events</span>
      <div class="best-notification-body">
        <div class="best-notification-title">自己ベスト更新！ ${escapeHtml(a.record.title)} ${diffChip}</div>
        <div class="best-notification-detail">${detail}</div>
      </div>
      <button type="button" class="best-notification-close" aria-label="閉じる" onclick="this.closest('.best-notification').remove(); hideNotificationAreaIfEmpty();">&times;</button>
    `;
    area.appendChild(el);
  });
}

function hideNotificationAreaIfEmpty() {
  const area = document.getElementById('notification-area');
  if (area && area.children.length === 0) area.style.display = 'none';
}

function hideNotificationArea() {
  const area = document.getElementById('notification-area');
  if (area) { area.innerHTML = ''; area.style.display = 'none'; }
}
