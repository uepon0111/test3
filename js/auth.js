/*
 * auth.js
 * -----------------------------------------------------------------------
 * Google へのログイン/ログアウト処理。処理内容は元のindex.htmlから
 * 変更していません(ログアウト時に新しいDriveフォルダIDキャッシュを
 * リセットする処理のみ追加しています。アカウントを切り替えた際に
 * 前のアカウントのフォルダIDを使い続けてしまうのを防ぐためです)。
 * さらに、ページ遷移や設定画面との往復でログイン状態が見えなくなる問題を
 * 抑えるため、短時間だけ有効な access token を localStorage に退避して
 * 復元できるようにしています。
 * -----------------------------------------------------------------------
 */

function getStoredAuthToken() {
  try {
    const raw = localStorage.getItem(LS_KEY_AUTH_TOKEN);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.access_token) return null;
    return parsed;
  } catch (e) {
    console.error('保存済みトークンの読み込みに失敗しました', e);
    return null;
  }
}

function storeAuthToken(resp) {
  try {
    if (!resp || !resp.access_token) return;
    const expiresIn = Number(resp.expires_in || 0);
    const payload = {
      access_token: resp.access_token,
      token_type: resp.token_type || 'Bearer',
      scope: resp.scope || SCOPES,
      expires_at: expiresIn > 0 ? (Date.now() + expiresIn * 1000) : 0,
    };
    localStorage.setItem(LS_KEY_AUTH_TOKEN, JSON.stringify(payload));
  } catch (e) {
    console.error('トークンの保存に失敗しました', e);
  }
}

function clearStoredAuthToken() {
  try {
    localStorage.removeItem(LS_KEY_AUTH_TOKEN);
  } catch (e) {
    console.error('トークンの削除に失敗しました', e);
  }
}

function applyStoredAuthToken() {
  if (typeof gapi === 'undefined' || !gapi.client) return false;
  const cached = getStoredAuthToken();
  if (!cached) return false;
  if (cached.expires_at && Date.now() >= cached.expires_at - 30 * 1000) {
    clearStoredAuthToken();
    return false;
  }
  gapi.client.setToken({ access_token: cached.access_token, token_type: cached.token_type || 'Bearer' });
  return true;
}

async function restoreAuthSessionIfPossible() {
  const hasMainUi = !!document.getElementById('grid');
  if (!hasMainUi) return false;
  const restored = applyStoredAuthToken();
  if (!restored) return false;
  setAuthUI(true);
  try {
    await fetchDataFromDrive();
  } catch (e) {
    console.error('保存済みトークンでのデータ取得に失敗しました', e);
  }
  return true;
}

function gapiLoaded() { gapi.load('client', initializeGapiClient); }

async function initializeGapiClient() {
  await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
  gapiInited = true;
  await restoreAuthSessionIfPossible();
}

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: '' });
  gisInited = true;
}

function handleAuthClick() {
  tokenClient.callback = async (resp) => {
    if (resp.error !== undefined) throw (resp);
    storeAuthToken(resp);
    setAuthUI(true);
    await fetchDataFromDrive();
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
    hideNotificationArea();
    clearStoredAuthToken();
  }
}

function setAuthUI(isLoggedIn) {
  document.getElementById('signout_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('upload_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('authorize_button').style.display = isLoggedIn ? 'none' : 'inline-flex';
  document.getElementById('auth-status').innerText = isLoggedIn ? 'ログイン済み' : '未ログイン';
}
