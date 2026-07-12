/*
 * drive-client.js
 * -----------------------------------------------------------------------
 * Google Drive API とやり取りする低レベルの汎用ヘルパー関数群。
 * フォルダ/ファイルの検索・作成・アップロード・更新・削除など、
 * 「Driveの操作方法」そのものを担当し、リザルトデータの意味づけ(properties の
 * 組み立てや解釈など)は drive-records.js 側で行います。
 * -----------------------------------------------------------------------
 */

// ページングしながら条件に合う全アイテムを取得する
async function fetchAllDriveItems(query, fields) {
  let items = [];
  let pageToken = null;
  do {
    const response = await gapi.client.drive.files.list({
      q: query, fields: `nextPageToken, files(${fields})`, pageSize: 1000, pageToken: pageToken
    });
    if (response.result.files) items = items.concat(response.result.files);
    pageToken = response.result.nextPageToken;
  } while (pageToken);
  return items;
}

async function getFolderByName(name, parentId = null) {
  let query = `mimeType = 'application/vnd.google-apps.folder' and name = '${name}' and trashed = false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const response = await gapi.client.drive.files.list({ q: query, fields: 'files(id, name)', pageSize: 1 });
  return (response.result.files && response.result.files.length > 0) ? response.result.files[0] : null;
}

async function findOrCreateFolder(name, parentId = null) {
  const existing = await getFolderByName(name, parentId);
  if (existing) return existing;
  const metadata = { 'name': name, 'mimeType': 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const response = await gapi.client.drive.files.create({ resource: metadata, fields: 'id, name' });
  return response.result;
}

// ルート("プロセカリザルト")と、その直下の "Results" フォルダを取得(無ければ作成)する。
// セッション内でIDをキャッシュし、バッチアップロード中に何度も検索が走らないようにする。
async function ensureRootAndResultsFolders() {
  if (!cachedRootFolderId) {
    const root = await findOrCreateFolder(ROOT_FOLDER_NAME);
    cachedRootFolderId = root.id;
  }
  if (!cachedResultsFolderId) {
    const results = await findOrCreateFolder(RESULTS_FOLDER_NAME, cachedRootFolderId);
    cachedResultsFolderId = results.id;
  }
  return { rootId: cachedRootFolderId, resultsId: cachedResultsFolderId };
}

// ルートフォルダを検索のみ行う(作成はしない)。データ取得(読み取り専用)時に使用。
async function findRootFolderReadOnly() {
  if (cachedRootFolderId) return { id: cachedRootFolderId };
  const root = await getFolderByName(ROOT_FOLDER_NAME);
  if (root) cachedRootFolderId = root.id;
  return root;
}

// 旧バージョンの "FC" フォルダを検索(存在しない場合も多いので都度キャッシュする)
async function findLegacyFolder(rootId) {
  if (legacyFolderChecked) {
    return cachedLegacyFolderId ? { id: cachedLegacyFolderId } : null;
  }
  const legacy = rootId ? await getFolderByName(LEGACY_FOLDER_NAME, rootId) : null;
  cachedLegacyFolderId = legacy ? legacy.id : null;
  legacyFolderChecked = true;
  return legacy;
}

// 新規ファイルを Results フォルダへアップロードする (multipart アップロード)
async function uploadFileToResults(file, properties, fileName) {
  const { resultsId } = await ensureRootAndResultsFolders();
  const accessToken = gapi.client.getToken().access_token;
  const meta = { name: fileName, parents: [resultsId], properties: properties };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', file);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents', {
    method: 'POST', headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }), body: form
  });
  if (!res.ok) throw new Error(res.statusText);
  return await res.json();
}

// 既存ファイルのメタデータ(名前・properties)を更新する。moveParams を渡すと親フォルダの移動も同時に行う
// (旧方式データを新方式へ移行する際、曲フォルダ→Resultsフォルダへの移動に使用)。
async function updateResultFileMetadata(fileId, fileName, properties, moveParams) {
  const params = { fileId: fileId, resource: { name: fileName, properties: properties }, fields: 'id, name, parents' };
  if (moveParams) {
    if (moveParams.addParents) params.addParents = moveParams.addParents;
    if (moveParams.removeParents) params.removeParents = moveParams.removeParents;
  }
  return await gapi.client.drive.files.update(params);
}

async function deleteDriveFile(fileId) {
  return await gapi.client.drive.files.delete({ fileId: fileId });
}
