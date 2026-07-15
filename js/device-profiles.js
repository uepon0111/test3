/*
 * device-profiles.js
 * -----------------------------------------------------------------------
 * 「機種プロファイル」(読み取り範囲の設定を機種ごとに保存したもの) の
 * 保存・読み込み・自動選択を担当します。index.html (メイン画面・設定モーダルの両方) で使用します。
 *
 * 保存先は localStorage です(このアプリはサーバーを持たない静的サイトのため)。
 * プロファイルが1件も無い場合は、旧バージョンの固定読み取り範囲を引き継いだ
 * 「デフォルト」プロファイルを自動的に1つ作成します。
 * -----------------------------------------------------------------------
 */

function generateProfileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function cloneRegions(regions) {
  return JSON.parse(JSON.stringify(regions || DEFAULT_REGIONS));
}

function seedDefaultProfile() {
  return {
    id: generateProfileId(),
    name: 'デフォルト',
    width: 0,
    height: 0,
    regions: cloneRegions(DEFAULT_REGIONS),
    updatedAt: new Date().toISOString(),
  };
}

function loadDeviceProfilesRaw() {
  try {
    const raw = localStorage.getItem(LS_KEY_DEVICE_PROFILES);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    console.error('機種プロファイルの読み込みに失敗しました', e);
    return null;
  }
}

// 保存済みプロファイル一覧を取得。1件もなければデフォルトを1件作成して保存する。
function getDeviceProfiles() {
  let list = loadDeviceProfilesRaw();
  if (!list || list.length === 0) {
    list = [seedDefaultProfile()];
    saveDeviceProfiles(list);
  }
  deviceProfilesCache = list;
  return list;
}

function saveDeviceProfiles(list) {
  try {
    localStorage.setItem(LS_KEY_DEVICE_PROFILES, JSON.stringify(list));
    deviceProfilesCache = list;
    return true;
  } catch (e) {
    console.error('機種プロファイルの保存に失敗しました', e);
    return false;
  }
}

function getDeviceProfileById(id) {
  return getDeviceProfiles().find(p => p.id === id) || null;
}

function upsertDeviceProfile(profile) {
  const list = getDeviceProfiles();
  const idx = list.findIndex(p => p.id === profile.id);
  profile.updatedAt = new Date().toISOString();
  if (idx >= 0) list[idx] = profile;
  else list.push(profile);
  saveDeviceProfiles(list);
  return profile;
}

function deleteDeviceProfile(id) {
  let list = getDeviceProfiles();
  list = list.filter(p => p.id !== id);
  saveDeviceProfiles(list);
  return list;
}

function createNewProfileDraft(name) {
  return {
    id: generateProfileId(),
    name: name || '新しい機種',
    width: 0,
    height: 0,
    regions: cloneRegions(DEFAULT_REGIONS),
    updatedAt: new Date().toISOString(),
  };
}

// 画像の解像度(幅・高さ)から最も一致するプロファイルを選ぶ。
// 1. 解像度が完全一致するものがあれば最優先。
// 2. なければアスペクト比が最も近いものを選ぶ。
// 3. 参照解像度が未設定(width/height=0)のプロファイルは比較対象から除外。
// 4. 1件も比較できなければ先頭のプロファイルを返す(常に何かしら選ばれるようにする)。
function findBestProfileForImage(width, height, profiles) {
  const list = profiles || getDeviceProfiles();
  if (!list || list.length === 0) return null;
  const targetRatio = width / height;
  let best = null;
  let bestScore = Infinity;
  for (const p of list) {
    if (!p.width || !p.height) continue;
    if (p.width === width && p.height === height) return p;
    const pRatio = p.width / p.height;
    const diff = Math.abs(pRatio - targetRatio) / targetRatio;
    if (diff < bestScore) { bestScore = diff; best = p; }
  }
  return best || list[0];
}

// プロファイルの regions から、欠けている項目をデフォルトで補完して返す(将来項目が増えた際の後方互換)。
function getRegionsForProfile(profile) {
  if (!profile || !profile.regions) return cloneRegions(DEFAULT_REGIONS);
  const regions = {};
  for (const def of REGION_DEFS) {
    regions[def.key] = profile.regions[def.key] || DEFAULT_REGIONS[def.key];
  }
  return regions;
}

function exportProfilesJSON() {
  const list = getDeviceProfiles();
  return JSON.stringify({ type: 'prsk-device-profiles', version: 1, profiles: list }, null, 2);
}

// エクスポートされたJSONを取り込む。id が一致するものは上書き、それ以外は追加する。
function importProfilesJSON(jsonStr) {
  const parsed = JSON.parse(jsonStr);
  const incoming = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.profiles) ? parsed.profiles : null);
  if (!incoming) throw new Error('不正なフォーマットです');
  const existing = getDeviceProfiles();
  const merged = existing.slice();
  let added = 0, updated = 0;
  incoming.forEach(p => {
    if (!p || !p.id || !p.regions) return;
    const idx = merged.findIndex(e => e.id === p.id);
    if (idx >= 0) { merged[idx] = p; updated++; }
    else { merged.push(p); added++; }
  });
  saveDeviceProfiles(merged);
  return { added, updated, total: merged.length };
}
