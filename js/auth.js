/*
 * auth.js
 * -----------------------------------------------------------------------
 * Google へのログイン/ログアウト処理。
 *   - ログアウト時に新しいDriveフォルダIDキャッシュをリセット(アカウントを
 *     切り替えた際に前のアカウントのフォルダIDを使い続けてしまうのを防ぐため)。
 *   - ログイン時に、そのアカウントの読み取り設定(機種プロファイル)をDriveから
 *     読み込んで反映する(drive-settings-sync.js)。ログアウト時は同期状態をリセットする。
 *   - 読み取り設定ボタンはログイン後にのみ表示する(ログイン前は非表示)。
 * -----------------------------------------------------------------------
 */

function gapiLoaded() { gapi.load('client', initializeGapiClient); }

async function initializeGapiClient() {
  await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
  gapiInited = true;
}

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: '' });
  gisInited = true;
}

// 現在Googleにログイン済み(有効なDriveアクセストークンを保持)かどうかを判定する。
// gapi / gapi.client はGoogle公式スクリプトの非同期読み込み完了後にしか存在しないため
// (window.onload の時点でもまだ未初期化のことがある)、例外を投げず安全にfalseを
// 返せるようにしている。settings-page.js(読み取り設定モーダルを開く前のガード)・
// drive-settings-sync.js(設定変更時の自動同期を行うかどうかの判定)から使われる。
function isGoogleSignedIn() {
  try { return !!(window.gapi && gapi.client && gapi.client.getToken && gapi.client.getToken()); }
  catch (e) { return false; }
}

function handleAuthClick() {
  tokenClient.callback = async (resp) => {
    if (resp.error !== undefined) throw (resp);
    setAuthUI(true);
    // データ取得と設定同期は互いに独立しているため並行して実行する。
    await Promise.all([
      fetchDataFromDrive(),
      loadSettingsFromDriveOnLogin(),
    ]);
  };
  if (gapi.client.getToken() === null) tokenClient.requestAccessToken({ prompt: 'consent' });
  else tokenClient.requestAccessToken({ prompt: '' });
}

function handleSignoutClick() {
  const token = gapi.client.getToken();
  if (token !== null) {
    google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken('');
    setAuthUI(false);
    document.getElementById('result-count').innerText = 'ログアウトしました';
    document.getElementById('grid').innerHTML = '';
    allRecords = [];
    selectedIds.clear();
    updateSelectionUI();
    resetDriveFolderCache();
    resetSettingsSyncState();
    hideNotificationArea();
  }
}

function setAuthUI(isLoggedIn) {
  document.getElementById('signout_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('upload_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('authorize_button').style.display = isLoggedIn ? 'none' : 'inline-flex';
  document.getElementById('settings_link').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('auth-status').innerText = isLoggedIn ? 'ログイン済み' : '未ログイン';
}
