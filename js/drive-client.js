/*
 * drive-client.js
 * -----------------------------------------------------------------------
 * Google Drive API とやり取りする低レベルの汎用ヘルパー関数群。
 * フォルダ/ファイルの検索・作成・アップロード・更新・削除など、
 * 「Driveの操作方法」そのものを担当し、リザルトデータの意味づけ(properties の
 * 組み立てや解釈など)は drive-records.js 側で、設定ファイル(settings.json)の
 * 意味づけは drive-settings-sync.js 側で行います。
 *
 * スコープについて: このアプリは drive.file スコープ(アプリが作成/ユーザーが明示的に
 * 開いたファイルのみアクセス可能)で動作します。そのため検索クエリは常にこのアプリが
 * 作成したフォルダ配下に限定しており、Drive全体を横断検索するような処理は行いません
 * (旧バージョンにあった「旧命名法フォルダの全文検索」は、この制約とも相性が悪かった
 * ため撤廃しています)。
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

// フォルダ以外の通常ファイルを名前で検索する (settings.json の検索に使用)。
async function getFileByName(name, parentId = null) {
  let query = `mimeType != 'application/vnd.google-apps.folder' and name = '${name}' and trashed = false`;
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

// ルート("プロセカリザルト")フォルダを取得(無ければ作成)する。設定のDrive同期は
// Resultsフォルダを必要としないため、この関数はルートのみを解決する。
//
// 「トランザクション」的な排他制御について:
// Google Drive API には複数リクエストをまたぐ本来の意味でのトランザクションは無く、
// 同名フォルダの重複作成を防ぐには呼び出し側で直列化するしかありません。ルート解決は
// 画像アップロードと設定のDrive同期の両方から呼ばれ得るため、複数箇所からほぼ同時に
// 呼ばれても実際にDriveへ問い合わせる処理が1回しか走らないよう、進行中の解決処理を
// Promiseとして共有します。2件目以降の呼び出しは新たに検索・作成を行わず、進行中の
// Promiseの完了を待つだけになるため、「無い→作成」の判定が競合してフォルダが二重に
// 作られる事態を防げます。
async function ensureRootFolder() {
  if (cachedRootFolderId) return cachedRootFolderId;
  if (!rootFolderEnsurePromise) {
    rootFolderEnsurePromise = (async () => {
      const root = await findOrCreateFolder(ROOT_FOLDER_NAME);
      cachedRootFolderId = root.id;
      return cachedRootFolderId;
    })();
    try {
      return await rootFolderEnsurePromise;
    } finally {
      rootFolderEnsurePromise = null;
    }
  }
  return rootFolderEnsurePromise;
}

// ルート直下の "Results" フォルダを取得(無ければ作成)する。ルート解決と同様、
// 専用のPromiseを共有して重複作成を防ぐ。
async function ensureResultsFolderUnder(rootId) {
  if (cachedResultsFolderId) return cachedResultsFolderId;
  if (!resultsFolderEnsurePromise) {
    resultsFolderEnsurePromise = (async () => {
      const results = await findOrCreateFolder(RESULTS_FOLDER_NAME, rootId);
      cachedResultsFolderId = results.id;
      return cachedResultsFolderId;
    })();
    try {
      return await resultsFolderEnsurePromise;
    } finally {
      resultsFolderEnsurePromise = null;
    }
  }
  return resultsFolderEnsurePromise;
}

// ルートとResultsの両方を解決する(画像アップロード用)。セッション内でIDをキャッシュし、
// バッチアップロード中に何度も検索が走らないようにする。
async function ensureRootAndResultsFolders() {
  const rootId = await ensureRootFolder();
  const resultsId = await ensureResultsFolderUnder(rootId);
  return { rootId, resultsId };
}

// ルートフォルダを検索のみ行う(作成はしない)。データ取得(読み取り専用)時に使用。
async function findRootFolderReadOnly() {
  if (cachedRootFolderId) return { id: cachedRootFolderId };
  const root = await getFolderByName(ROOT_FOLDER_NAME);
  if (root) cachedRootFolderId = root.id;
  return root;
}

// 新規ファイルを Results フォルダへアップロードする (multipart アップロード)。
// onProgress(0〜1) を渡すと、アップロード中の送信バイト数から進捗を通知する
// (fetch にはアップロード進捗を取得する標準的な手段が無いため、XMLHttpRequest を使用)。
function uploadFileToResults(file, properties, fileName, onProgress) {
  return ensureRootAndResultsFolders().then(({ resultsId }) => {
    const accessToken = gapi.client.getToken().access_token;
    const meta = { name: fileName, parents: [resultsId], properties: properties };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents');
      xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (err) { reject(err); }
        } else {
          reject(new Error(`アップロードに失敗しました (HTTP ${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('アップロード中にネットワークエラーが発生しました'));
      xhr.send(form);
    });
  });
}

// 既存ファイルのメタデータ(名前・properties)を更新する。
async function updateResultFileMetadata(fileId, fileName, properties) {
  const params = { fileId: fileId, resource: { name: fileName, properties: properties }, fields: 'id, name, parents' };
  return await gapi.client.drive.files.update(params);
}

async function deleteDriveFile(fileId) {
  return await gapi.client.drive.files.delete({ fileId: fileId });
}

// ============================================================
// 画像・テキストの認証付き取得 (alt=media)
// ============================================================
// Drive の thumbnailLink はカードの一覧表示には便利ですが、(1) 解像度が低く縮小されている、
// (2) CORS の都合でブラウザ側から canvas に描画してピクセルを読み取ろうとすると失敗する
// ことがある、という2つの理由でOCR解析には使えません。編集・再解析時は必ずこちらの
// 関数でファイル本体を認証付きで取得し、同一オリジンの Blob URL に変換してから使います
// (Blob URL は生成元のタブ内でのみ有効な同一オリジンのURLなので、canvas 側の
// クロスオリジン制約に一切引っかかりません)。

async function fetchDriveFileBlobUrl(fileId) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error(`画像の取得に失敗しました (HTTP ${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

async function fetchDriveFileText(fileId) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error(`ファイルの取得に失敗しました (HTTP ${res.status})`);
  return await res.text();
}

// 指定フォルダに新規テキストファイル(settings.json 等)を作成する。
async function createDriveTextFile(name, parentId, content, mimeType) {
  const accessToken = gapi.client.getToken().access_token;
  const meta = { name, mimeType: mimeType || 'application/json' };
  if (parentId) meta.parents = [parentId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: mimeType || 'application/json' }));
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST', headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }), body: form,
  });
  if (!res.ok) throw new Error(`ファイルの作成に失敗しました (HTTP ${res.status})`);
  return await res.json();
}

// 既存テキストファイルの中身を丸ごと上書きする(メタデータは変更しない)。
async function updateDriveTextFileContent(fileId, content, mimeType) {
  const accessToken = gapi.client.getToken().access_token;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: new Headers({ 'Authorization': 'Bearer ' + accessToken, 'Content-Type': mimeType || 'application/json' }),
    body: content,
  });
  if (!res.ok) throw new Error(`ファイルの更新に失敗しました (HTTP ${res.status})`);
  return await res.json();
}
