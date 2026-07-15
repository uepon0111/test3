/*
 * settings-page.js
 * -----------------------------------------------------------------------
 * 「読み取り設定」モーダル(index.html 内。旧settings.htmlから統合)のロジック。
 *   - 機種プロファイルの一覧・新規作成・保存・削除
 *   - サンプル画像のアップロードと、読み取り範囲(difficulty/level/title/breakdown/combo)の
 *     ドラッグ&ドロップ・8方向ハンドルによるビジュアル編集
 *   - 座標数値入力との双方向同期 (ドラッグ→数値、数値→ドラッグ双方に反映)
 *   - プロファイルのエクスポート/インポート (JSON)
 *   - モーダルの開閉 (openSettingsModal / closeSettingsModal)
 * -----------------------------------------------------------------------
 */

let currentProfile = null;      // 現在編集中のプロファイル(ドラフト。保存するまでlocalStorageには反映されない)
let activeRegionKey = null;     // 現在編集対象の範囲キー ('difficulty' | 'level' | 'title' | 'breakdown' | 'combo')
let sampleNaturalWidth = 0;
let sampleNaturalHeight = 0;
let dragState = null;
let settingsPageInitialized = false; // イベント登録などの初期化を1回だけ行うためのフラグ

// ============================================================
// モーダルの開閉
// -----------------------------------------------------------------------
// 以前は settings.html という別ページで、別画面へ遷移(別タブ/ページ読み込み)する
// たびにGoogleログインのトークン(メモリ上にのみ保持)が失われて「ログアウトされる」
// 問題があった。index.html 内のモーダルとして統合し、ページ遷移自体を無くすことで
// この問題を解消している。
// 初期化(イベントリスナー登録など)は、要素がまだ display:none の状態で行うと
// 画像コンテナの幅などが0として計算されてしまうため、モーダルを表示した「後」に
// 初回のみ実行するようにしている。
// ============================================================

function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
  if (!settingsPageInitialized) {
    initSettingsPage();
    settingsPageInitialized = true;
  } else {
    // 2回目以降の表示時も、閉じている間のレイアウト変化に合わせて位置を再計算する
    repositionAllRegionBoxes();
    updateCoordInputsFromRegion(activeRegionKey);
  }
}

function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}

function initSettingsPage() {
  activeRegionKey = REGION_DEFS[0].key;
  renderRegionTabs();

  const profiles = getDeviceProfiles();
  loadProfileIntoEditor(profiles[0]);

  document.getElementById('btn-new-profile').addEventListener('click', () => {
    loadProfileIntoEditor(createNewProfileDraft(''));
    document.getElementById('profile-name-input').focus();
  });

  document.getElementById('sample-image-input').addEventListener('change', handleSampleImageSelected);
  document.getElementById('btn-save-profile').addEventListener('click', saveCurrentProfile);
  document.getElementById('btn-delete-profile').addEventListener('click', deleteCurrentProfile);

  document.getElementById('btn-export-profiles').addEventListener('click', doExportProfiles);
  document.getElementById('btn-import-profiles').addEventListener('click', () => document.getElementById('import-file-input').click());
  document.getElementById('import-file-input').addEventListener('change', doImportProfiles);

  ['coord-x', 'coord-y', 'coord-w', 'coord-h'].forEach(id => {
    document.getElementById(id).addEventListener('input', onCoordInputChanged);
  });

  window.addEventListener('resize', debounce(repositionAllRegionBoxes, 100));
}

// ============================================================
// プロファイル一覧
// ============================================================

function renderProfileList() {
  const list = getDeviceProfiles();
  const container = document.getElementById('profile-list');
  container.innerHTML = list.map(p => `
    <div class="profile-list-item ${currentProfile && currentProfile.id === p.id ? 'active' : ''}" data-id="${p.id}">
      <div class="profile-list-item-name">${escapeHtml(p.name)}</div>
      <div class="profile-list-item-meta">${p.width && p.height ? `${p.width}&times;${p.height}` : '基準未設定'}</div>
    </div>
  `).join('');
  container.querySelectorAll('.profile-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const profile = getDeviceProfileById(el.dataset.id);
      if (profile) loadProfileIntoEditor(profile);
    });
  });
}

// ============================================================
// 範囲タブ (難易度/曲名/判定内訳/コンボ数)
// ============================================================

function renderRegionTabs() {
  const container = document.getElementById('region-tabs');
  container.innerHTML = REGION_DEFS.map(def => `
    <button type="button" class="region-tab" data-key="${def.key}">
      <span class="region-tab-dot" style="background-color:${def.color}"></span>${def.label}
    </button>
  `).join('');
  container.querySelectorAll('.region-tab').forEach(btn => {
    btn.addEventListener('click', () => setActiveRegion(btn.dataset.key));
  });
  updateRegionTabsUI();
}

function updateRegionTabsUI() {
  document.querySelectorAll('.region-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === activeRegionKey);
  });
}

function setActiveRegion(key) {
  activeRegionKey = key;
  updateRegionTabsUI();
  updateRegionBoxesInteractivity();
  updateCoordInputsFromRegion(key);
}

// ============================================================
// プロファイルの読み込み・保存・削除
// ============================================================

function loadProfileIntoEditor(profile) {
  currentProfile = JSON.parse(JSON.stringify(profile)); // 保存を押すまで確定させないためドラフトとして複製
  document.getElementById('profile-name-input').value = currentProfile.name;
  sampleNaturalWidth = currentProfile.width || 0;
  sampleNaturalHeight = currentProfile.height || 0;

  const img = document.getElementById('sample-img');
  const placeholder = document.getElementById('no-image-placeholder');
  img.style.display = 'none';
  img.removeAttribute('src');
  placeholder.style.display = 'flex';
  placeholder.innerText = sampleNaturalWidth
    ? `このプロファイルの基準解像度は ${sampleNaturalWidth}×${sampleNaturalHeight} です。\n見た目を確認・調整するには、この機種のサンプル画像を選択してください。`
    : 'サンプル画像を選択してください';

  ensureRegionBoxes();
  repositionAllRegionBoxes();
  updateRegionBoxesInteractivity();
  updateCoordInputsFromRegion(activeRegionKey);
  renderProfileList();

  const isSaved = !!getDeviceProfileById(currentProfile.id);
  document.getElementById('btn-delete-profile').disabled = !isSaved;
}

function saveCurrentProfile() {
  const name = document.getElementById('profile-name-input').value.trim();
  if (!name) { alert('機種名を入力してください'); return; }
  currentProfile.name = name;
  upsertDeviceProfile(currentProfile);
  renderProfileList();
  document.getElementById('btn-delete-profile').disabled = false;
  alert('保存しました');
}

function deleteCurrentProfile() {
  if (!currentProfile || !getDeviceProfileById(currentProfile.id)) return;
  if (!confirm(`「${currentProfile.name}」を削除しますか？`)) return;
  deleteDeviceProfile(currentProfile.id);
  const remaining = getDeviceProfiles();
  loadProfileIntoEditor(remaining[0]);
}

// ============================================================
// サンプル画像
// ============================================================

async function handleSampleImageSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = document.getElementById('sample-img');
  const placeholder = document.getElementById('no-image-placeholder');

  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } catch (err) {
    alert('画像の読み込みに失敗しました');
    return;
  }

  sampleNaturalWidth = img.naturalWidth;
  sampleNaturalHeight = img.naturalHeight;
  currentProfile.width = sampleNaturalWidth;
  currentProfile.height = sampleNaturalHeight;

  img.style.display = 'block';
  placeholder.style.display = 'none';

  repositionAllRegionBoxes();
  updateCoordInputsFromRegion(activeRegionKey);
  renderProfileList();
}

// ============================================================
// 範囲ボックス (表示・配置)
// ============================================================

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function ensureRegionBoxes() {
  const container = document.getElementById('image-editor-container');
  REGION_DEFS.forEach(def => {
    let box = document.getElementById(`region-box-${def.key}`);
    if (box) return;
    box = document.createElement('div');
    box.id = `region-box-${def.key}`;
    box.className = 'region-box';
    box.style.setProperty('--region-color', def.color);
    box.style.setProperty('--region-color-bg', hexToRgba(def.color, 0.18));
    box.innerHTML = `
      <span class="region-box-label" style="background-color:${def.color}">${def.label}</span>
      ${['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].map(h => `<div class="region-handle handle-${h}" data-handle="${h}"></div>`).join('')}
    `;
    container.appendChild(box);
    box.addEventListener('pointerdown', (ev) => onRegionPointerDown(ev, def.key));
  });
}

function updateRegionBoxesInteractivity() {
  REGION_DEFS.forEach(def => {
    const box = document.getElementById(`region-box-${def.key}`);
    if (!box) return;
    const isActive = def.key === activeRegionKey;
    box.classList.toggle('active-region', isActive);
    box.classList.toggle('inactive-region', !isActive);
  });
}

// 画像の「表示上のサイズ」を返す。画像未選択時はコンテナ幅と基準アスペクト比から仮想サイズを計算する。
function getDisplayedImageRect() {
  const img = document.getElementById('sample-img');
  const container = document.getElementById('image-editor-container');
  if (img.style.display !== 'none' && img.clientWidth > 0) {
    return { width: img.clientWidth, height: img.clientHeight, left: img.offsetLeft, top: img.offsetTop };
  }
  const w = container.clientWidth;
  const ratio = (sampleNaturalWidth && sampleNaturalHeight) ? (sampleNaturalHeight / sampleNaturalWidth) : 1.777;
  return { width: w, height: w * ratio, left: 0, top: 0 };
}

function renderRegionBoxPosition(key) {
  const box = document.getElementById(`region-box-${key}`);
  if (!box || !currentProfile) return;
  const region = currentProfile.regions[key];
  const rect = getDisplayedImageRect();

  box.style.left = (rect.left + region.x * rect.width) + 'px';
  box.style.top = (rect.top + region.y * rect.height) + 'px';
  box.style.width = (region.w * rect.width) + 'px';
  box.style.height = (region.h * rect.height) + 'px';
}

function repositionAllRegionBoxes() {
  REGION_DEFS.forEach(def => renderRegionBoxPosition(def.key));
}

// ============================================================
// ドラッグ移動 / ハンドルによるリサイズ (Pointer Events でマウス・タッチ両対応)
// ============================================================

function onRegionPointerDown(ev, key) {
  if (key !== activeRegionKey) return; // 非アクティブな範囲は操作不可(タブで切り替えてから編集する)
  ev.preventDefault();
  ev.stopPropagation();

  const handle = ev.target.dataset ? ev.target.dataset.handle : undefined;
  const rect = getDisplayedImageRect();
  const region = currentProfile.regions[key];

  dragState = {
    mode: handle || 'move',
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    startRegion: { x: region.x, y: region.y, w: region.w, h: region.h },
    rectWidth: rect.width,
    rectHeight: rect.height,
    key: key,
  };

  const box = document.getElementById(`region-box-${key}`);
  box.setPointerCapture(ev.pointerId);
  box.addEventListener('pointermove', onRegionPointerMove);
  box.addEventListener('pointerup', onRegionPointerUp);
  box.addEventListener('pointercancel', onRegionPointerUp);
}

function onRegionPointerMove(ev) {
  if (!dragState) return;
  ev.preventDefault();

  const s = dragState.startRegion;
  const MIN = 0.02;
  let dxRatio = (ev.clientX - dragState.startClientX) / dragState.rectWidth;
  let dyRatio = (ev.clientY - dragState.startClientY) / dragState.rectHeight;

  const mode = dragState.mode;
  let x = s.x, y = s.y, w = s.w, h = s.h;

  const affectsLeft = ['move', 'w', 'nw', 'sw'].includes(mode);
  const affectsRight = ['move', 'e', 'ne', 'se'].includes(mode);
  const affectsTop = ['move', 'n', 'nw', 'ne'].includes(mode);
  const affectsBottom = ['move', 's', 'sw', 'se'].includes(mode);

  if (mode === 'move') {
    dxRatio = clamp(dxRatio, -s.x, 1 - s.w - s.x);
    dyRatio = clamp(dyRatio, -s.y, 1 - s.h - s.y);
    x = s.x + dxRatio; y = s.y + dyRatio;
  } else {
    if (affectsLeft) {
      dxRatio = clamp(dxRatio, -s.x, s.w - MIN);
      x = s.x + dxRatio; w = s.w - dxRatio;
    }
    if (affectsRight) {
      dxRatio = clamp(dxRatio, MIN - s.w, 1 - s.x - s.w);
      w = s.w + dxRatio;
    }
    if (affectsTop) {
      dyRatio = clamp(dyRatio, -s.y, s.h - MIN);
      y = s.y + dyRatio; h = s.h - dyRatio;
    }
    if (affectsBottom) {
      dyRatio = clamp(dyRatio, MIN - s.h, 1 - s.y - s.h);
      h = s.h + dyRatio;
    }
  }

  currentProfile.regions[dragState.key] = { x, y, w, h };
  renderRegionBoxPosition(dragState.key);
  updateCoordInputsFromRegion(dragState.key);
}

function onRegionPointerUp(ev) {
  if (!dragState) return;
  const box = document.getElementById(`region-box-${dragState.key}`);
  box.removeEventListener('pointermove', onRegionPointerMove);
  box.removeEventListener('pointerup', onRegionPointerUp);
  box.removeEventListener('pointercancel', onRegionPointerUp);
  dragState = null;
}

// ============================================================
// 座標数値入力との同期
// ============================================================

function updateCoordInputsFromRegion(key) {
  if (!currentProfile) return;
  const region = currentProfile.regions[key];
  const refW = sampleNaturalWidth || 1000;
  const refH = sampleNaturalHeight || 1000;
  document.getElementById('coord-x').value = Math.round(region.x * refW);
  document.getElementById('coord-y').value = Math.round(region.y * refH);
  document.getElementById('coord-w').value = Math.round(region.w * refW);
  document.getElementById('coord-h').value = Math.round(region.h * refH);
  const label = REGION_DEFS.find(d => d.key === key).label;
  const refNote = sampleNaturalWidth ? `基準 ${refW}×${refH}px` : '基準画像未設定のため仮の数値(1000×1000px換算)です';
  document.getElementById('coord-panel-title').innerText = `「${label}」の範囲`;
  document.getElementById('coord-panel-hint').innerText = refNote;
}

function onCoordInputChanged() {
  if (!currentProfile) return;
  const refW = sampleNaturalWidth || 1000;
  const refH = sampleNaturalHeight || 1000;
  const MIN_RATIO = 0.02;

  const xPx = parseFloat(document.getElementById('coord-x').value) || 0;
  const yPx = parseFloat(document.getElementById('coord-y').value) || 0;
  const wPx = parseFloat(document.getElementById('coord-w').value) || 0;
  const hPx = parseFloat(document.getElementById('coord-h').value) || 0;

  const x = clamp(xPx / refW, 0, 1);
  const y = clamp(yPx / refH, 0, 1);
  const w = clamp(wPx / refW, MIN_RATIO, 1 - x);
  const h = clamp(hPx / refH, MIN_RATIO, 1 - y);

  currentProfile.regions[activeRegionKey] = { x, y, w, h };
  renderRegionBoxPosition(activeRegionKey);
}

// ============================================================
// エクスポート / インポート
// ============================================================

function doExportProfiles() {
  const json = exportProfilesJSON();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'prsk-device-profiles.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function doImportProfiles(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const result = importProfilesJSON(reader.result);
      alert(`インポート完了 (追加:${result.added}件 / 更新:${result.updated}件)`);
      renderProfileList();
    } catch (err) {
      alert('インポートに失敗しました: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}
