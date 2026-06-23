'use strict';

/* ============================================================
   EQUALIZER  —  Web Audio API 10バンドイコライザ
   ============================================================ */

const Equalizer = (() => {

  const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const BAND_LABELS = ['32Hz','64Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz'];

  const PRESETS = {
    ノーマル:  [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
    ポップ:    [-2,-1,  0,  2,  4,  4,  3,  1,  0, -1],
    ロック:    [ 5, 4,  3,  2, -1, -1,  0,  3,  4,  5],
    クラシック:[ 5, 4,  3,  1, -2,  0,  0,  2,  3,  4],
    ジャズ:    [ 4, 3,  2,  3, -2, -2,  0,  1,  3,  4],
    低音強調:  [ 8, 7,  5,  3,  1,  0,  0, -1, -1, -1],
    高音強調:  [-1,-1,  0,  0,  0,  1,  3,  5,  7,  8],
    ボイス:    [-4,-3,  0,  3,  6,  5,  4,  2,  0, -2],
  };

  let _ctx       = null;  // AudioContext (shared with audio engine)
  let _filters   = [];    // BiquadFilterNode[]
  let _input     = null;  // connect from here
  let _output    = null;  // connect to destination
  let _enabled   = true;
  let _gains     = new Array(BANDS.length).fill(0);
  let _canvas    = null;
  let _sampleSrc = null;  // for preview
  let _samplePlaying = false;
  let _bgmBuffer = null;  // cached decoded BGM sample

  // どのプリセットが選択中か。組み込みプリセット名 / "custom:<id>" / null（手動調整中）
  let _activePresetName = 'ノーマル';
  // ユーザーが保存したカスタムイコライザ { id, name, gains: number[] }[]
  let _customPresets = [];
  let _saveTimer = null;

  /* ---- Init with existing AudioContext ---- */
  function init(audioCtx) {
    _ctx = audioCtx;
    _filters = BANDS.map((freq, i) => {
      const f = _ctx.createBiquadFilter();
      f.type      = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value   = 1.4;
      f.gain.value = 0;
      return f;
    });
    // Chain filters
    for (let i = 0; i < _filters.length - 1; i++) {
      _filters[i].connect(_filters[i + 1]);
    }
    _input  = _filters[0];
    _output = _filters[_filters.length - 1];
    // 既にロード済みの設定があれば反映（ctx が後から作られるケースに対応）
    _gains.forEach((g, i) => { if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0; });
  }

  function getInput()  { return _input;  }
  function getOutput() { return _output; }

  /* ---- Gain setters ---- */
  function setGain(bandIndex, db) {
    _gains[bandIndex] = db;
    if (_filters[bandIndex]) _filters[bandIndex].gain.value = _enabled ? db : 0;
    drawCanvas();
  }

  function applyPreset(name) {
    const vals = PRESETS[name];
    if (!vals) return;
    _gains = [...vals];
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0;
    });
    _activePresetName = name;
    drawCanvas();
    renderBandSliders();
    renderPresetButtons();
    saveSettings();
  }

  function applyCustomPreset(id) {
    const preset = _customPresets.find(p => p.id === id);
    if (!preset) return;
    _gains = [...preset.gains];
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0;
    });
    _activePresetName = `custom:${id}`;
    drawCanvas();
    renderBandSliders();
    renderPresetButtons();
    saveSettings();
  }

  async function saveCustomPreset(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    const preset = { id: `c${Date.now()}`, name: trimmed, gains: [..._gains] };
    _customPresets.push(preset);
    _activePresetName = `custom:${preset.id}`;
    renderPresetButtons();
    await saveSettings();
    return preset;
  }

  async function deleteCustomPreset(id) {
    _customPresets = _customPresets.filter(p => p.id !== id);
    if (_activePresetName === `custom:${id}`) _activePresetName = null;
    renderPresetButtons();
    await saveSettings();
  }

  function setEnabled(v) {
    _enabled = v;
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = v ? g : 0;
    });
    drawCanvas();
  }

  function reset() { applyPreset('ノーマル'); }

  function getGains() { return [..._gains]; }

  /* ---- Canvas visualization ---- */
  function initCanvas(canvasEl) {
    _canvas = canvasEl;
    drawCanvas();
  }

  function drawCanvas() {
    if (!_canvas) return;
    const W = _canvas.offsetWidth  || 400;
    const H = _canvas.offsetHeight || 120;
    _canvas.width  = W;
    _canvas.height = H;
    const ctx = _canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth   = 1;
    [-12,-6,0,6,12].forEach(db => {
      const y = dbToY(db, H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });

    // 0dB line
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    const midY = dbToY(0, H);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();

    if (!_enabled) {
      // Flat line
      ctx.strokeStyle = '#60a5fa55';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    // EQ curve (smooth interpolation)
    const points = BANDS.map((_, i) => ({
      x: freqToX(BANDS[i], W),
      y: dbToY(_gains[i], H)
    }));

    // Draw filled area
    ctx.beginPath();
    ctx.moveTo(0, midY);
    drawSmoothCurve(ctx, points);
    ctx.lineTo(W, midY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#3b82f640');
    grad.addColorStop(1, '#3b82f608');
    ctx.fillStyle = grad;
    ctx.fill();

    // Draw stroke
    ctx.beginPath();
    ctx.moveTo(0, midY);
    drawSmoothCurve(ctx, points);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Band dots
    points.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#60a5fa';
      ctx.fill();
    });
  }

  function drawSmoothCurve(ctx, pts) {
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const cp1x = (pts[i].x + pts[i+1].x) / 2;
      ctx.bezierCurveTo(cp1x, pts[i].y, cp1x, pts[i+1].y, pts[i+1].x, pts[i+1].y);
    }
  }

  function freqToX(freq, W) {
    const logMin = Math.log10(20);
    const logMax = Math.log10(20000);
    return ((Math.log10(freq) - logMin) / (logMax - logMin)) * W;
  }
  function dbToY(db, H) {
    return H / 2 - (db / 12) * (H / 2 - 8);
  }

  /* ---- Band slider UI ---- */
  function renderBandSliders() {
    const wrap = el('eq-bands-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    BANDS.forEach((freq, i) => {
      const band = document.createElement('div');
      band.className = 'eq-band';

      const valLabel = document.createElement('div');
      valLabel.className = 'eq-band-value';
      valLabel.id = `eq-val-${i}`;
      valLabel.textContent = `${_gains[i] >= 0 ? '+' : ''}${_gains[i]}dB`;

      const sliderWrap = document.createElement('div');
      sliderWrap.className = 'eq-slider-wrap';
      const slider = document.createElement('input');
      slider.type  = 'range';
      slider.className = 'eq-slider';
      slider.min   = -12; slider.max = 12; slider.step = 0.5;
      slider.value = _gains[i];
      slider.setAttribute('aria-label', BAND_LABELS[i]);
      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        setGain(i, v);
        valLabel.textContent = `${v >= 0 ? '+' : ''}${v}dB`;
        markCustomPreset();
      });
      sliderWrap.appendChild(slider);

      const freqLabel = document.createElement('div');
      freqLabel.className = 'eq-band-label';
      freqLabel.textContent = BAND_LABELS[i];

      band.appendChild(valLabel);
      band.appendChild(sliderWrap);
      band.appendChild(freqLabel);
      wrap.appendChild(band);
    });
  }

  function markCustomPreset() {
    document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
    _activePresetName = null;
    // バンドを直接動かした変更も次回起動時に持ち越せるよう保存する（連続変更はデバウンス）
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { saveSettings(); }, 400);
  }

  /* ---- Preset buttons UI（組み込み + カスタム） ---- */
  function renderPresetButtons() {
    const wrap = el('eq-preset-btns');
    if (!wrap) return;
    wrap.innerHTML = '';

    Object.keys(PRESETS).forEach(name => {
      const btn = document.createElement('button');
      btn.className = `eq-preset-btn${_activePresetName === name ? ' active' : ''}`;
      btn.textContent = name;
      btn.addEventListener('click', () => applyPreset(name));
      wrap.appendChild(btn);
    });

    _customPresets.forEach(preset => {
      const btn = document.createElement('button');
      btn.className = `eq-preset-btn eq-preset-btn--custom${_activePresetName === `custom:${preset.id}` ? ' active' : ''}`;
      const label = document.createElement('span');
      label.textContent = preset.name;
      btn.appendChild(label);
      const del = document.createElement('span');
      del.className = 'eq-preset-btn-del';
      del.innerHTML = '×';
      del.title = 'カスタムイコライザを削除';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        await deleteCustomPreset(preset.id);
        Toast.success('カスタムイコライザを削除しました');
      });
      btn.appendChild(del);
      btn.addEventListener('click', () => applyCustomPreset(preset.id));
      wrap.appendChild(btn);
    });
  }

  /* ---- カスタムイコライザの保存（名前付けモーダル） ---- */
  function bindCustomSaveModal() {
    const openBtn = el('btn-eq-save-custom');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        const input = el('eq-preset-name-input');
        if (input) input.value = '';
        openModal('modal-eq-preset');
        setTimeout(() => input?.focus(), 50);
      });
    }
    bindModalCloseByClass('js-close-eq-preset', 'modal-eq-preset');

    const saveBtn = el('btn-save-eq-preset');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const input = el('eq-preset-name-input');
        const name = input ? input.value.trim() : '';
        if (!name) { Toast.error('名前を入力してください'); return; }
        await saveCustomPreset(name);
        closeModal('modal-eq-preset');
        Toast.success('カスタムイコライザを保存しました');
      });
    }
    const nameInput = el('eq-preset-name-input');
    if (nameInput) {
      nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') el('btn-save-eq-preset')?.click();
      });
    }
  }

  /* ---- Sample audio preview ---- */
  function stopSample() {
    if (_sampleSrc) {
      try { _sampleSrc.stop(); } catch {}
      _sampleSrc.disconnect();
      _sampleSrc = null;
    }
    _samplePlaying = false;
    setIcon(el('btn-eq-preview'), 'play');
    const status = el('eq-preview-status');
    if (status) status.textContent = '停止中';
  }

  async function _loadBgmBuffer() {
    if (_bgmBuffer) return _bgmBuffer;
    const res = await fetch('assets/audio/eq-sample-bgm.mp3');
    if (!res.ok) throw new Error('not found');
    const arr = await res.arrayBuffer();
    _bgmBuffer = await _ctx.decodeAudioData(arr);
    return _bgmBuffer;
  }

  async function toggleSample() {
    if (_samplePlaying) { stopSample(); return; }
    if (!_ctx) return Toast.error('まず曲を再生してイコライザを有効にしてください');

    if (_ctx.state === 'suspended') await _ctx.resume();

    const type = el('eq-sample-select')?.value || 'bgm';

    if (type === 'bgm') {
      let buf;
      try {
        buf = await _loadBgmBuffer();
      } catch (e) {
        Toast.error('サンプルBGMファイルが見つかりません（assets/audio/eq-sample-bgm.mp3 を配置してください）');
        return;
      }
      _sampleSrc = _ctx.createBufferSource();
      _sampleSrc.buffer = buf;
      _sampleSrc.loop = true;
      _sampleSrc.connect(_input || _ctx.destination);
      _sampleSrc.start();
      _samplePlaying = true;
      setIcon(el('btn-eq-preview'), 'square');
      const status = el('eq-preview-status');
      if (status) status.textContent = '再生中';
      return;
    }

    const dur   = 8;
    const sr    = _ctx.sampleRate;
    const buf   = _ctx.createBuffer(1, sr * dur, sr);
    const data  = buf.getChannelData(0);

    if (type === 'pink') {
      let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
      for (let i = 0; i < data.length; i++) {
        const w = Math.random()*2-1;
        b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
        b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
        b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
        data[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
        b6=w*0.115926;
      }
    } else if (type === 'low') {
      for (let i = 0; i < data.length; i++) {
        data[i] = 0.5 * Math.sin(2*Math.PI*60*i/sr)
                + 0.3 * Math.sin(2*Math.PI*120*i/sr)
                + 0.1 * Math.sin(2*Math.PI*180*i/sr);
      }
    } else if (type === 'mid') {
      for (let i = 0; i < data.length; i++) {
        data[i] = 0.4 * Math.sin(2*Math.PI*500*i/sr)
                + 0.3 * Math.sin(2*Math.PI*1000*i/sr)
                + 0.2 * Math.sin(2*Math.PI*2000*i/sr);
      }
    } else if (type === 'high') {
      for (let i = 0; i < data.length; i++) {
        data[i] = 0.4 * Math.sin(2*Math.PI*5000*i/sr)
                + 0.3 * Math.sin(2*Math.PI*8000*i/sr)
                + 0.2 * Math.sin(2*Math.PI*12000*i/sr);
      }
    } else { // sweep
      for (let i = 0; i < data.length; i++) {
        const t    = i / sr;
        const freq = 20 * Math.pow(1000, t / dur); // 20Hz → 20kHz
        data[i] = 0.5 * Math.sin(2*Math.PI*freq*t);
      }
    }

    _sampleSrc = _ctx.createBufferSource();
    _sampleSrc.buffer = buf;
    _sampleSrc.connect(_input || _ctx.destination);
    _sampleSrc.start();
    _sampleSrc.onended = () => stopSample();
    _samplePlaying = true;

    setIcon(el('btn-eq-preview'), 'square');
    const status = el('eq-preview-status');
    if (status) status.textContent = '再生中';
  }

  /* ---- Save / Load EQ settings ---- */
  async function saveSettings() {
    await Storage.setSetting('eq_gains',           _gains);
    await Storage.setSetting('eq_enabled',         _enabled);
    await Storage.setSetting('eq_active_preset',   _activePresetName);
    await Storage.setSetting('eq_custom_presets',  _customPresets);
  }
  async function loadSettings() {
    const gains    = await Storage.getSetting('eq_gains',          new Array(BANDS.length).fill(0));
    const enabled  = await Storage.getSetting('eq_enabled',        true);
    const active   = await Storage.getSetting('eq_active_preset',  'ノーマル');
    const customs  = await Storage.getSetting('eq_custom_presets', []);
    _gains   = Array.isArray(gains) && gains.length === BANDS.length ? gains : new Array(BANDS.length).fill(0);
    _enabled = enabled;
    _activePresetName = active;
    _customPresets = Array.isArray(customs) ? customs : [];
    _gains.forEach((g, i) => { if (_filters[i]) _filters[i].gain.value = enabled ? g : 0; });
    const toggle = el('eq-enabled');
    if (toggle) toggle.checked = enabled;
    renderBandSliders();
    renderPresetButtons();
    drawCanvas();
  }

  /* ---- Bind UI ---- */
  function bindUI() {
    renderPresetButtons();
    renderBandSliders();
    initCanvas(el('eq-canvas'));
    bindCustomSaveModal();

    const enabledToggle = el('eq-enabled');
    if (enabledToggle) {
      enabledToggle.addEventListener('change', async () => {
        setEnabled(enabledToggle.checked);
        await saveSettings();
      });
    }

    const previewBtn = el('btn-eq-preview');
    if (previewBtn) previewBtn.addEventListener('click', toggleSample);

    // Resize → redraw canvas
    new ResizeObserver(() => drawCanvas()).observe(el('eq-canvas')?.parentElement || document.body);
  }

  return {
    init, bindUI, loadSettings, saveSettings,
    setGain, applyPreset, applyCustomPreset, saveCustomPreset, deleteCustomPreset,
    setEnabled, reset, getGains,
    getInput, getOutput,
    drawCanvas,
  };
})();
