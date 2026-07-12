/*
 * auth.js
 * -----------------------------------------------------------------------
 * Google へのログイン/ログアウト処理。
 *
 * 改善:
 *   - Access Token を localStorage に短期間保存し、settings.html と index.html を
 *     行き来しても再ログイン状態を維持しやすくしました。
 *   - 既存の Google サインイン状態が有効なら、ページ読み込み時に自動復帰を試みます。
 * -----------------------------------------------------------------------
 */

function getPersistedAuthState() {
  try {
    const raw = localStorage.getItem(LS_KEY_AUTH_STATE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.access_token || !parsed.expires_at) return null;
    return parsed;
  } catch (e) {
    console.error('認証状態の読み込みに失敗しました', e);
    return null;
  }
}

function persistAuthState(resp) {
  try {
    if (!resp || !resp.access_token) return;
    const expiresIn = Number(resp.expires_in || 0);
    const expiresAt = Date.now() + Math.max(1, expiresIn) * 1000;
    localStorage.setItem(LS_KEY_AUTH_STATE, JSON.stringify({
      access_token: resp.access_token,
      scope: resp.scope || SCOPES,
      token_type: resp.token_type || 'Bearer',
      expires_at: expiresAt,
    }));
  } catch (e) {
    console.error('認証状態の保存に失敗しました', e);
  }
}

function clearPersistedAuthState() {
  try {
    localStorage.removeItem(LS_KEY_AUTH_STATE);
  } catch (e) {
    console.error('認証状態の削除に失敗しました', e);
  }
}

function isPersistedTokenValid(state) {
  if (!state || !state.access_token || !state.expires_at) return false;
  return Date.now() < (Number(state.expires_at) - 60 * 1000);
}

function restorePersistedAuthState() {
  if (!gapiInited || !gisInited || !window.gapi || !gapi.client) return false;
  if (gapi.client.getToken() !== null) return true;

  const state = getPersistedAuthState();
  if (!isPersistedTokenValid(state)) return false;

  gapi.client.setToken({
    access_token: state.access_token,
    token_type: state.token_type || 'Bearer',
    scope: state.scope || SCOPES,
  });
  setAuthUI(true);
  fetchDataFromDrive();
  return true;
}

function maybeRestoreAuthState() {
  // gapi / GIS の両方が初期化完了してから復帰を試みる
  if (gapiInited && gisInited) {
    restorePersistedAuthState();
  }
}

function gapiLoaded() { gapi.load('client', initializeGapiClient); }

async function initializeGapiClient() {
  await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
  gapiInited = true;
  maybeRestoreAuthState();
}

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: '' });
  gisInited = true;
  maybeRestoreAuthState();
}

function handleAuthClick() {
  tokenClient.callback = async (resp) => {
    if (resp.error !== undefined) throw (resp);
    persistAuthState(resp);
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
    clearPersistedAuthState();
    setAuthUI(false);
    document.getElementById('result-count').innerText = 'ログアウトしました';
    document.getElementById('grid').innerHTML = '';
    allRecords = [];
    selectedIds.clear();
    updateSelectionUI();
    resetDriveFolderCache();
    hideNotificationArea();
  }
}

function setAuthUI(isLoggedIn) {
  document.getElementById('signout_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('upload_button').style.display = isLoggedIn ? 'inline-flex' : 'none';
  document.getElementById('authorize_button').style.display = isLoggedIn ? 'none' : 'inline-flex';
  document.getElementById('auth-status').innerText = isLoggedIn ? 'ログイン済み' : '未ログイン';
}
