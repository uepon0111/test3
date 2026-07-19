/*
 * auth.js
 * -----------------------------------------------------------------------
 * Google へのログイン/ログアウト処理。
 *   - ログイン成功時、Drive about.get でアカウント(メールアドレス)を確認し、
 *     機種プロファイル等の「設定」をこのアカウント専用の保存場所に切り替えたうえで、
 *     Google Driveとの設定同期(settings-sync.js)を開始する。
 *   - 読み取り設定ボタン・関連UIはログイン後のみ表示する(未ログイン時は非表示)。
 *   - ログアウト時は、新しいDriveフォルダIDキャッシュ・アカウント識別・設定同期状態を
 *     リセットする(アカウントを切り替えた際に前のアカウントの情報を引きずらないため)。
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

function handleAuthClick() {
  tokenClient.callback = async (resp) => {
    if (resp.error !== undefined) throw (resp);
    await onLoginSuccess();
  };
  if (gapi.client.getToken() === null) tokenClient.requestAccessToken({ prompt: 'consent' });
  else tokenClient.requestAccessToken({ prompt: '' });
}

// ログイン成功後の準備処理。
//   1. アカウント(メールアドレス)を確認し、設定の保存先をこのアカウント専用に切り替える
//   2. 読み取り設定(機種プロファイル)をDriveと同期する(結果を待たずリザルト取得へ進む)
//   3. リザルト一覧を取得する
//   4. 旧settings.htmlからのリダイレクトで「読み取り設定を開く」が予約されていれば開く
async function onLoginSuccess() {
  setAuthUI(true);
  document.getElementById('result-count').innerText = 'アカウント情報を確認中...';

  try {
    const about = await gapi.client.drive.about.get({ fields: 'user' });
    currentAccountKey = (about.result.user && about.result.user.emailAddress) || 'unknown';
  } catch (e) {
    console.error('アカウント情報の取得に失敗しました', e);
    currentAccountKey = 'unknown';
  }
  localStorage.setItem(LS_KEY_LAST_ACCOUNT, currentAccountKey);

  deviceProfilesCache = null; // 前アカウントのメモリキャッシュを引きずらないようにクリア

  // 機種プロファイルは、この端末側で先にデフォルト値を作ってしまう前にDriveの内容を
  // 確認する(先にローカルへ既定値を保存すると、他端末で既に保存済みの設定より先に
  // このタイミングでDrive側を上書きしてしまう恐れがあるため)。ここで同期の完了を
  // 待ってから一覧取得へ進むことで、設定モーダルを開いた時に必ず最新の内容が
  // 表示されるようにしている。
  document.getElementById('result-count').innerText = '設定を同期中...';
  await pullOrInitSettingsFromDrive();

  await fetchDataFromDrive();

  if (pendingOpenSettingsAfterLogin) {
    pendingOpenSettingsAfterLogin = false;
    openSettingsModal();
  }
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
    hideNotificationArea();
    currentAccountKey = null;
    deviceProfilesCache = null;
    settingsSyncState = 'idle';
    if (typeof closeSettingsModal === 'function') closeSettingsModal();
  }
}

function setAuthUI(isLoggedIn) {
  document.getElementById('signout_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('upload_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('authorize_button').style.display = isLoggedIn ? 'none' : 'inline-flex';
  // 読み取り設定はログイン後のみ表示する(ログイン前は設定内容がどのアカウントにも
  // 紐付いておらず意味を持たないため)。
  document.getElementById('settings_link').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('auth-status').innerText = isLoggedIn ? 'ログイン済み' : '未ログイン';
}
