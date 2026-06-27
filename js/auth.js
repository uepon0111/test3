/**
 * auth.js — Google OAuth 2.0 PKCE フロー（静的サイト向け）
 */
const Auth = (() => {
  let _token     = null;
  let _user      = null;
  let _expiresAt = 0;

  /** Generate code verifier (PKCE) */
  function generateVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }

  /** SHA-256 → base64url (PKCE challenge) */
  async function sha256b64url(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }

  /** Start OAuth flow */
  async function login(clientId) {
    const verifier  = generateVerifier();
    const challenge = await sha256b64url(verifier);
    const state     = generateVerifier().slice(0, 16);

    sessionStorage.setItem('pkce_verifier', verifier);
    sessionStorage.setItem('pkce_state',    state);
    sessionStorage.setItem('oauth_clientId',clientId);

    const params = new URLSearchParams({
      client_id:             clientId,
      redirect_uri:          location.origin + location.pathname,
      response_type:         'code',
      scope:                 CONFIG.GOOGLE_SCOPES,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      state,
      access_type:           'offline',
      prompt:                'consent',
    });

    location.href = CONFIG.GOOGLE_AUTH_URL + '?' + params.toString();
  }

  /** Handle OAuth callback (code exchange) */
  async function handleCallback() {
    const params   = new URLSearchParams(location.search);
    const code     = params.get('code');
    const state    = params.get('state');
    const storedSt = sessionStorage.getItem('pkce_state');
    const verifier = sessionStorage.getItem('pkce_verifier');
    const clientId = sessionStorage.getItem('oauth_clientId');

    if (!code || state !== storedSt) return false;

    sessionStorage.removeItem('pkce_verifier');
    sessionStorage.removeItem('pkce_state');
    // Clean URL
    history.replaceState({}, '', location.pathname);

    const body = new URLSearchParams({
      code, client_id: clientId, redirect_uri: location.origin + location.pathname,
      code_verifier: verifier, grant_type: 'authorization_code',
    });

    const res  = await fetch(CONFIG.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    _token     = data.access_token;
    _expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    await DB.setSetting('access_token',  data.access_token);
    await DB.setSetting('refresh_token', data.refresh_token || null);
    await DB.setSetting('token_expires', _expiresAt);
    await DB.setSetting('oauth_clientId', clientId);

    await fetchUser();
    return true;
  }

  /** Refresh access token */
  async function refreshToken() {
    const clientId     = await DB.getSetting('oauth_clientId');
    const refreshTk    = await DB.getSetting('refresh_token');
    if (!clientId || !refreshTk) return false;

    const body = new URLSearchParams({
      client_id: clientId, refresh_token: refreshTk, grant_type: 'refresh_token',
    });

    const res  = await fetch(CONFIG.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    if (data.error) return false;

    _token     = data.access_token;
    _expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    await DB.setSetting('access_token',  _token);
    await DB.setSetting('token_expires', _expiresAt);
    return true;
  }

  /** Get valid access token */
  async function getToken() {
    if (_token && Date.now() < _expiresAt) return _token;

    // Try stored token
    const stored = await DB.getSetting('access_token');
    const exp    = await DB.getSetting('token_expires');
    if (stored && exp && Date.now() < exp) {
      _token = stored; _expiresAt = exp; return _token;
    }

    // Refresh
    const ok = await refreshToken();
    return ok ? _token : null;
  }

  /** Fetch user info */
  async function fetchUser() {
    const tk = await getToken();
    if (!tk) return null;
    const res  = await fetch(CONFIG.GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${tk}` },
    });
    _user = await res.json();
    await DB.setSetting('user_info', JSON.stringify(_user));
    return _user;
  }

  /** Check if logged in */
  async function isLoggedIn() {
    const tk = await getToken();
    return !!tk;
  }

  /** Get cached user info */
  async function getUser() {
    if (_user) return _user;
    const stored = await DB.getSetting('user_info');
    if (stored) { try { _user = JSON.parse(stored); } catch(e) {} }
    return _user;
  }

  /** Log out */
  async function logout() {
    _token = null; _user = null; _expiresAt = 0;
    await DB.setSetting('access_token',  null);
    await DB.setSetting('refresh_token', null);
    await DB.setSetting('token_expires', null);
    await DB.setSetting('user_info',     null);
  }

  return { login, handleCallback, getToken, isLoggedIn, getUser, logout, fetchUser };
})();
