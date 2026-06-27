/**
 * settings.js — 設定管理（機種プロファイル、APIキー等）
 */
const Settings = (() => {

  let _regionCanvas     = null;
  let _regionImg        = null;
  let _currentProfile   = null;
  let _activeRegion     = null;
  let _isDragging       = false;
  let _dragStart        = { x: 0, y: 0 };
  let _tempRegions      = {};

  /** Initialize settings page */
  async function init() {
    await renderAccountSection();
    await renderOCRSection();
    await renderDeviceProfiles();
    await renderDriveSection();
    bindSettingsEvents();
  }

  async function renderAccountSection() {
    const el = document.getElementById('account-info');
    if (!el) return;
    const user = await Auth.getUser();
    if (user) {
      el.innerHTML = `
        <div class="account-row">
          <img src="${user.picture || ''}" alt="avatar" class="account-avatar" onerror="this.style.display='none'">
          <div class="account-details">
            <div class="account-name">${user.name || ''}</div>
            <div class="account-email">${user.email || ''}</div>
          </div>
          <button id="logout-btn" class="btn btn-sm btn-outline">ログアウト</button>
        </div>`;
      document.getElementById('logout-btn')?.addEventListener('click', async () => {
        if (!await UI.confirm('ログアウトしますか？')) return;
        await Auth.logout();
        location.reload();
      });
    } else {
      el.innerHTML = `<p class="text-muted">Google アカウントに未連携です</p>`;
    }
  }

  async function renderOCRSection() {
    const engine = await DB.getSetting('ocr_engine') || 'tesseract';
    const select = document.getElementById('ocr-engine');
    if (select) select.value = engine;

    const keySection = document.getElementById('anthropic-key-setting');
    if (keySection) keySection.classList.toggle('hidden', engine !== 'anthropic');

    const keyInput = document.getElementById('anthropic-api-key');
    if (keyInput) {
      const stored = await DB.getSetting('anthropic_api_key');
      if (stored) keyInput.value = stored;
    }
  }

  async function renderDeviceProfiles() {
    const list = document.getElementById('device-profiles-list');
    if (!list) return;
    const profiles = await DB.getAllDeviceProfiles();

    if (profiles.length === 0) {
      list.innerHTML = '<p class="text-muted">機種設定なし（デフォルト設定を使用）</p>';
      return;
    }

    list.innerHTML = profiles.map(p => `
      <div class="device-profile-item" data-id="${p.id}">
        <span class="material-symbols-outlined">smartphone</span>
        <span class="device-profile-name">${p.name}</span>
        <div class="device-profile-actions">
          <button class="btn btn-sm btn-outline edit-device-btn" data-id="${p.id}">編集</button>
          <button class="btn btn-sm btn-outline btn-danger delete-device-btn" data-id="${p.id}">削除</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.edit-device-btn').forEach(btn => {
      btn.addEventListener('click', () => openDeviceModal(btn.dataset.id));
    });
    list.querySelectorAll('.delete-device-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await UI.confirm('この機種設定を削除しますか？')) return;
        await DB.deleteDeviceProfile(btn.dataset.id);
        await renderDeviceProfiles();
      });
    });
  }

  async function renderDriveSection() {
    const available = await Drive.isAvailable();
    const statusEl  = document.getElementById('drive-status');
    const clientEl  = document.getElementById('google-client-id');

    if (statusEl) statusEl.textContent = available ? '連携済み' : '未連携';

    const stored = await DB.getSetting('oauth_clientId');
    if (clientEl && stored) clientEl.value = stored;
  }

  function bindSettingsEvents() {
    // OCR engine change
    document.getElementById('ocr-engine')?.addEventListener('change', async (e) => {
      await DB.setSetting('ocr_engine', e.target.value);
      const kw = document.getElementById('anthropic-key-setting');
      if (kw) kw.classList.toggle('hidden', e.target.value !== 'anthropic');
    });

    // Save API key
    document.getElementById('save-api-key')?.addEventListener('click', async () => {
      const key = document.getElementById('anthropic-api-key')?.value?.trim();
      if (!key) return;
      await DB.setSetting('anthropic_api_key', key);
      Notification.toast('APIキーを保存しました', 'success');
    });

    // Add device button
    document.getElementById('add-device-btn')?.addEventListener('click', () => {
      openDeviceModal(null);
    });

    // Google client ID save
    document.getElementById('save-client-id')?.addEventListener('click', async () => {
      const id = document.getElementById('google-client-id')?.value?.trim();
      if (!id) return;
      await DB.setSetting('oauth_clientId', id);
      Notification.toast('Client IDを保存しました', 'success');
    });

    // Drive connect
    document.getElementById('drive-connect-btn')?.addEventListener('click', async () => {
      const clientId = (document.getElementById('google-client-id')?.value?.trim())
        || (await DB.getSetting('oauth_clientId'));
      if (!clientId) {
        Notification.toast('まずGoogle Client IDを入力してください', 'warning');
        return;
      }
      await Auth.login(clientId);
    });
  }

  /** Open device profile modal */
  async function openDeviceModal(profileId) {
    _currentProfile = null;
    _tempRegions    = JSON.parse(JSON.stringify(CONFIG.DEFAULT_REGIONS));
    _regionImg      = null;
    _activeRegion   = null;

    const nameInput = document.getElementById('device-name');
    if (nameInput) nameInput.value = '';

    if (profileId) {
      const profiles = await DB.getAllDeviceProfiles();
      _currentProfile = profiles.find(p => p.id === profileId) || null;
      if (_currentProfile) {
        _tempRegions = JSON.parse(JSON.stringify(_currentProfile.regions));
        if (nameInput) nameInput.value = _currentProfile.name;
      }
    }

    // Reset canvas UI
    const canvasEl = document.getElementById('region-canvas');
    const emptyEl  = document.getElementById('region-canvas-empty');
    if (canvasEl) { canvasEl.width = 0; canvasEl.height = 0; canvasEl.style.display = 'none'; }
    if (emptyEl)  emptyEl.classList.remove('hidden');
    document.querySelectorAll('.region-set-btn').forEach(b => b.classList.remove('active'));

    document.getElementById('device-modal').classList.remove('hidden');
    _regionCanvas = canvasEl;
  }

  /** Load sample image for device setup */
  function loadSampleImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img    = new Image();
      img.onload   = () => {
        _regionImg = img;
        const emptyEl = document.getElementById('region-canvas-empty');
        if (emptyEl) emptyEl.classList.add('hidden');
        if (_regionCanvas) {
          _regionCanvas.style.display = 'block';
          // Fit canvas to modal, max width of parent minus padding
          const maxW = Math.min(600, (_regionCanvas.parentElement.clientWidth || 400) - 20);
          const scale = Math.min(1, maxW / img.width);
          _regionCanvas.width  = Math.round(img.width  * scale);
          _regionCanvas.height = Math.round(img.height * scale);
          _regionCanvas._scale = scale;
          _regionCanvas.style.cursor = 'default';
          drawRegionCanvas();
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function drawRegionCanvas() {
    if (!_regionCanvas || !_regionImg) return;
    const ctx   = _regionCanvas.getContext('2d');
    const scale = _regionCanvas._scale || 1;
    ctx.clearRect(0, 0, _regionCanvas.width, _regionCanvas.height);
    ctx.drawImage(_regionImg, 0, 0, _regionCanvas.width, _regionCanvas.height);
    // Draw regions
    OCR.drawRegionOverlays(ctx, _tempRegions, _regionCanvas.width, _regionCanvas.height);
    // Highlight active region
    if (_activeRegion && _tempRegions[_activeRegion]) {
      const r   = _tempRegions[_activeRegion];
      const col = CONFIG.REGION_COLORS[_activeRegion] || '#fff';
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth   = 4;
      ctx.setLineDash([8,4]);
      ctx.strokeRect(r.x * _regionCanvas.width, r.y * _regionCanvas.height,
                     r.w * _regionCanvas.width, r.h * _regionCanvas.height);
      ctx.restore();
    }
  }

  /** Bind canvas drag for region selection */
  function bindCanvasEvents() {
    if (!_regionCanvas) return;

    _regionCanvas.addEventListener('mousedown', (e) => {
      if (!_activeRegion) return;
      const rect = _regionCanvas.getBoundingClientRect();
      _dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      _isDragging = true;
    });

    _regionCanvas.addEventListener('mousemove', (e) => {
      if (!_isDragging || !_activeRegion) return;
      const rect = _regionCanvas.getBoundingClientRect();
      const cx   = e.clientX - rect.left;
      const cy   = e.clientY - rect.top;
      const x = Math.min(_dragStart.x, cx), y = Math.min(_dragStart.y, cy);
      const w = Math.abs(cx - _dragStart.x), h = Math.abs(cy - _dragStart.y);
      _tempRegions[_activeRegion] = {
        x: x / _regionCanvas.width,
        y: y / _regionCanvas.height,
        w: w / _regionCanvas.width,
        h: h / _regionCanvas.height,
      };
      drawRegionCanvas();
    });

    _regionCanvas.addEventListener('mouseup', () => { _isDragging = false; });

    // Touch support
    _regionCanvas.addEventListener('touchstart', (e) => {
      if (!_activeRegion) return;
      e.preventDefault();
      const t = e.touches[0];
      const rect = _regionCanvas.getBoundingClientRect();
      _dragStart = { x: t.clientX - rect.left, y: t.clientY - rect.top };
      _isDragging = true;
    }, { passive: false });

    _regionCanvas.addEventListener('touchmove', (e) => {
      if (!_isDragging || !_activeRegion) return;
      e.preventDefault();
      const t    = e.touches[0];
      const rect = _regionCanvas.getBoundingClientRect();
      const cx   = t.clientX - rect.left, cy = t.clientY - rect.top;
      const x = Math.min(_dragStart.x, cx), y = Math.min(_dragStart.y, cy);
      const w = Math.abs(cx - _dragStart.x), h = Math.abs(cy - _dragStart.y);
      _tempRegions[_activeRegion] = {
        x: x / _regionCanvas.width, y: y / _regionCanvas.height,
        w: w / _regionCanvas.width, h: h / _regionCanvas.height,
      };
      drawRegionCanvas();
    }, { passive: false });

    _regionCanvas.addEventListener('touchend', () => { _isDragging = false; });
  }

  /** Initialize device modal events (called from app.js) */
  function initDeviceModalEvents() {
    document.getElementById('device-sample-input')?.addEventListener('change', (e) => {
      if (e.target.files[0]) loadSampleImage(e.target.files[0]);
    });

    document.getElementById('device-sample-btn')?.addEventListener('click', () => {
      document.getElementById('device-sample-input').click();
    });

    document.querySelectorAll('.region-set-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeRegion = btn.dataset.region;
        document.querySelectorAll('.region-set-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (_regionCanvas) {
          _regionCanvas.style.cursor = 'crosshair';
          drawRegionCanvas();
        }
      });
    });

    bindCanvasEvents();

    document.getElementById('device-save-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('device-name')?.value?.trim();
      if (!name) { Notification.toast('機種名を入力してください', 'warning'); return; }

      const profile = {
        id:      _currentProfile?.id || crypto.randomUUID(),
        name,
        regions: _tempRegions,
        createdAt: _currentProfile?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (_currentProfile) { await DB.updateDeviceProfile(profile); }
      else                  { await DB.addDeviceProfile(profile);    }

      document.getElementById('device-modal').classList.add('hidden');
      await renderDeviceProfiles();
      Notification.toast('機種設定を保存しました', 'success');
    });
  }

  /** Get active OCR regions (from selected device profile or default) */
  async function getActiveRegions(profileId) {
    if (!profileId) return CONFIG.DEFAULT_REGIONS;
    const profiles = await DB.getAllDeviceProfiles();
    const profile  = profiles.find(p => p.id === profileId);
    return profile ? profile.regions : CONFIG.DEFAULT_REGIONS;
  }

  return { init, initDeviceModalEvents, getActiveRegions, renderDeviceProfiles, openDeviceModal };
})();
