/*
 * drive-client.js
 * -----------------------------------------------------------------------
 * Google Drive API とやり取りする低レベルの汎用ヘルパー関数群。
 * フォルダ/ファイルの検索・作成・アップロード・更新・削除など、
 * 「Driveの操作方法」そのものを担当し、リザルトデータの意味づけ(properties の
 * 組み立てや解釈など)は drive-records.js 側で行います。
 *
 * drive.file スコープ(縮小後)では、このアプリが作成した(または開いた)ファイル・
 * フォルダにしかアクセスできません。本ファイルの関数は全てそのアクセス範囲の中で
 * 完結するように書かれています(ROOT_FOLDER_NAME 配下の検索・作成のみを行う)。
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

// フォルダ以外のファイルを名前で検索する (settings.json などの設定ファイル用)
async function getFileByName(name, parentId = null) {
  let query = `mimeType != 'application/vnd.google-apps.folder' and name = '${name}' and trashed = false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const response = await gapi.client.drive.files.list({ q: query, fields: 'files(id, name, modifiedTime)', pageSize: 1 });
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
//
// 複数箇所(画像アップロードと設定の自動同期など)からほぼ同時に呼ばれても、フォルダの
// 検索→作成が別々に走って重複フォルダが出来てしまわないよう、進行中のPromiseを
// state.js の ensureFoldersPromise で共有する(擬似的な排他制御)。
async function ensureRootAndResultsFolders() {
  if (cachedRootFolderId && cachedResultsFolderId) {
    return { rootId: cachedRootFolderId, resultsId: cachedResultsFolderId };
  }
  if (!ensureFoldersPromise) {
    ensureFoldersPromise = (async () => {
      try {
        if (!cachedRootFolderId) {
          const root = await findOrCreateFolder(ROOT_FOLDER_NAME);
          cachedRootFolderId = root.id;
        }
        if (!cachedResultsFolderId) {
          const results = await findOrCreateFolder(RESULTS_FOLDER_NAME, cachedRootFolderId);
          cachedResultsFolderId = results.id;
        }
        return { rootId: cachedRootFolderId, resultsId: cachedResultsFolderId };
      } finally {
        // 成功・失敗いずれの場合も進行中マーカーは必ず解除する(失敗時に再試行できるように)。
        ensureFoldersPromise = null;
      }
    })();
  }
  return ensureFoldersPromise;
}

// ルートフォルダを検索のみ行う(作成はしない)。データ取得(読み取り専用)時に使用。
async function findRootFolderReadOnly() {
  if (cachedRootFolderId) return { id: cachedRootFolderId };
  const root = await getFolderByName(ROOT_FOLDER_NAME);
  if (root) cachedRootFolderId = root.id;
  return root;
}

// 新規ファイルを Results フォルダへアップロードする (multipart アップロード)。
// fetch にはアップロードの送信バイト数を取得する手段が無いため、進捗表示のために
// XMLHttpRequest を使用している。onProgress(fraction) は 0〜1 の割合で呼ばれる。
function uploadFileToResults(file, properties, fileName, onProgress) {
  return ensureRootAndResultsFolders().then(({ resultsId }) => new Promise((resolve, reject) => {
    const accessToken = gapi.client.getToken().access_token;
    const meta = { name: fileName, parents: [resultsId], properties: properties };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents');
    xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    if (onProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('アップロード結果の解析に失敗しました')); }
      } else {
        reject(new Error(`アップロードに失敗しました (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('アップロード中にネットワークエラーが発生しました'));
    xhr.send(form);
  }));
}

// 既存ファイルのメタデータ(名前・properties)を更新する。
async function updateResultFileMetadata(fileId, fileName, properties) {
  return await gapi.client.drive.files.update({
    fileId: fileId, resource: { name: fileName, properties: properties }, fields: 'id, name, parents'
  });
}

async function deleteDriveFile(fileId) {
  return await gapi.client.drive.files.delete({ fileId: fileId });
}

// ============================================================
// 画像本体の取得 (編集モーダルでのプレビュー表示・OCR再解析用)
// ------------------------------------------------------------
// Drive の thumbnailLink は「ブラウザのGoogleセッションCookieがあれば直接<img>表示できる」
// 種類のURLで、CORS(crossorigin属性付きでの取得)には対応していません。編集モーダルでは
// canvasに描画してピクセルを読み取る(OCR解析)必要があり、crossorigin無しで読み込んだ画像は
// canvasが「汚染」されて読み取りができません。そのため、認証済みのDrive APIから直接ファイル本体
// (alt=media)を取得し、blob: URLに変換して使います。blob: URLは常に同一オリジン扱いになるため、
// CORSの制約を受けずにcanvasへ描画・読み取りできます(画像一覧からの編集で画像が表示されず
// 解析もできない、という不具合の根本原因はこれでした)。
// ============================================================
async function fetchDriveFileBytesAsBlobUrl(fileId) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
  });
  if (!res.ok) throw new Error('画像の取得に失敗しました (' + res.status + ')');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ============================================================
// 汎用JSON設定ファイル (settings.json の読み書き。settings-sync.js から使用)
// ============================================================

async function createJsonFile(name, parentId, dataObj) {
  const accessToken = gapi.client.getToken().access_token;
  const meta = { name, mimeType: 'application/json' };
  if (parentId) meta.parents = [parentId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(dataObj)], { type: 'application/json' }));
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime', {
    method: 'POST', headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }), body: form
  });
  if (!res.ok) throw new Error('設定ファイルの作成に失敗しました (' + res.status + ')');
  return await res.json();
}

async function updateJsonFileContent(fileId, dataObj) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,modifiedTime`, {
    method: 'PATCH',
    headers: new Headers({ 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }),
    body: JSON.stringify(dataObj),
  });
  if (!res.ok) throw new Error('設定ファイルの更新に失敗しました (' + res.status + ')');
  return await res.json();
}

async function downloadJsonFile(fileId) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
  });
  if (!res.ok) throw new Error('設定ファイルの取得に失敗しました (' + res.status + ')');
  return await res.json();
}
