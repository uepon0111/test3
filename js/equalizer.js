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

  let _customPreset = null;
  let _saveTimer    = null;

  let _ctx       = null;  // AudioContext (shared with audio engine)
  let _filters   = [];    // BiquadFilterNode[]
  let _input     = null;  // connect from here
  let _output    = null;  // connect to destination
  let _enabled   = true;
  let _gains     = new Array(BANDS.length).fill(0);
  let _canvas    = null;
  let _sampleSrc = null;  // for preview
  let _samplePlaying = false;

  const SAMPLE_FILE_CANDIDATES = [
    'assets/sample/equalizer-bgm.mp3',
    'assets/sample/equalizer-bgm.ogg',
    'assets/sample/equalizer-bgm.wav',
  ];

  function _scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { saveSettings().catch(console.error); }, 120);
  }

  function _sameGains(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => Math.abs(v - b[i]) < 0.01);
  }

  function _updateCustomStatus() {
    const status = el('eq-custom-status');
    if (!status) return;
    if (_customPreset?.name) {
      status.textContent = `${_customPreset.name}（保存済み）`;
    } else {
      status.textContent = '未登録';
    }
  }

  function saveCustomPreset(name) {
    const presetName = (name || el('eq-custom-name')?.value || 'カスタム').trim() || 'カスタム';
    _customPreset = { name: presetName, gains: getGains(), updatedAt: Date.now() };
    _updateCustomStatus();
    renderPresetButtons();
    _scheduleSave();
  }

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
  }

  function getInput()  { return _input;  }
  function getOutput() { return _output; }

  /* ---- Gain setters ---- */
  function setGain(bandIndex, db) {
    _gains[bandIndex] = db;
    if (_filters[bandIndex]) _filters[bandIndex].gain.value = _enabled ? db : 0;
    drawCanvas();
    markCustomPreset();
    _scheduleSave();
  }

  function applyPreset(name) {
    let vals = PRESETS[name];
    if (!vals && _customPreset?.name === name) vals = _customPreset.gains;
    if (!vals) return;
    _gains = [...vals];
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0;
    });
    drawCanvas();
    renderBandSliders();
    renderPresetButtons();
    _scheduleSave();
  }

  function setEnabled(v) {
    _enabled = v;
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = v ? g : 0;
    });
    drawCanvas();
    _scheduleSave();
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
  }

  /* ---- Preset buttons UI ---- */
  function renderPresetButtons() {
    const wrap = el('eq-preset-btns');
    if (!wrap) return;
    wrap.innerHTML = '';
    Object.keys(PRESETS).forEach(name => {
      const btn = document.createElement('button');
      btn.className = `eq-preset-btn${name === 'ノーマル' ? ' active' : ''}`;
      btn.textContent = name;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyPreset(name);
      });
      wrap.appendChild(btn);
    });
    if (_customPreset?.name) {
      const btn = document.createElement('button');
      const active = _sameGains(_customPreset.gains, _gains) ? ' active' : '';
      btn.className = `eq-preset-btn${active}`;
      btn.textContent = _customPreset.name;
      btn.title = '保存済みのカスタム設定';
      btn.addEventListener('click', () => {
        document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _gains = [..._customPreset.gains];
        _gains.forEach((g, i) => { if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0; });
        renderBandSliders();
        drawCanvas();
      });
      wrap.appendChild(btn);
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
    const btn = el('btn-eq-preview');
    if (btn) { btn.querySelector('svg')?.setAttribute('data-lucide', 'play'); lucide.createIcons({ elements: [btn] }); }
    const status = el('eq-preview-status');
    if (status) status.textContent = '停止中';
  }

  async function _playBuffer(buffer) {
    _sampleSrc = _ctx.createBufferSource();
    _sampleSrc.buffer = buffer;
    _sampleSrc.connect(_input || _ctx.destination);
    _sampleSrc.start();
    _sampleSrc.onended = () => stopSample();
    _samplePlaying = true;
    const btn = el('btn-eq-preview');
    if (btn) { btn.innerHTML = '<i data-lucide="square" style="width:16px;height:16px"></i>'; lucide.createIcons({ elements: [btn] }); }
    const status = el('eq-preview-status');
    if (status) status.textContent = '再生中';
  }

  async function _loadExternalSampleBuffer() {
    for (const url of SAMPLE_FILE_CANDIDATES) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) return await res.arrayBuffer();
      } catch {}
    }
    return null;
  }

  async function toggleSample() {
    if (_samplePlaying) { stopSample(); return; }
    if (!_ctx) return Toast.error('まず曲を再生してイコライザを有効にしてください');

    if (_ctx.state === 'suspended') await _ctx.resume();

    const type  = el('eq-sample-select')?.value || 'pink';

    if (type === 'bgm') {
      const raw = await _loadExternalSampleBuffer();
      if (!raw) {
        Toast.error('assets/sample/equalizer-bgm.(mp3|ogg|wav) を配置してください');
        return;
      }
      const decoded = await _ctx.decodeAudioData(raw.slice(0));
      await _playBuffer(decoded);
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

    await _playBuffer(buf);
  }

  /* ---- Save / Load EQ settings ---- */
  async function saveSettings() {
    await Storage.setSetting('eq_gains',   _gains);
    await Storage.setSetting('eq_enabled', _enabled);
    await Storage.setSetting('eq_custom_preset', _customPreset);
  }
  async function loadSettings() {
    const gains   = await Storage.getSetting('eq_gains',   new Array(BANDS.length).fill(0));
    const enabled = await Storage.getSetting('eq_enabled', true);
    const custom  = await Storage.getSetting('eq_custom_preset', null);
    _gains   = Array.isArray(gains) && gains.length === BANDS.length ? gains : new Array(BANDS.length).fill(0);
    _enabled = enabled;
    _customPreset = custom && Array.isArray(custom.gains) ? custom : null;
    _gains.forEach((g, i) => { if (_filters[i]) _filters[i].gain.value = enabled ? g : 0; });
    const toggle = el('eq-enabled');
    if (toggle) toggle.checked = enabled;
    const customToggle = el('eq-custom-name');
    if (customToggle && _customPreset?.name) customToggle.value = _customPreset.name;
    _updateCustomStatus();
    renderBandSliders();
    drawCanvas();
  }

  /* ---- Bind UI ---- */
  function bindUI() {
    renderPresetButtons();
    renderBandSliders();
    initCanvas(el('eq-canvas'));

    const enabledToggle = el('eq-enabled');
    if (enabledToggle) {
      enabledToggle.addEventListener('change', async () => {
        setEnabled(enabledToggle.checked);
        await saveSettings();
      });
    }

    const normToggle = el('volume-normalize-mode');
    if (normToggle) {
      normToggle.checked = AppState.volumeNormalizeMode;
      normToggle.addEventListener('change', () => {
        AudioEngine.setVolumeNormalizeMode(normToggle.checked);
      });
    }

    const customSaveBtn = el('btn-eq-save-custom');
    if (customSaveBtn) customSaveBtn.addEventListener('click', () => saveCustomPreset());

    const previewBtn = el('btn-eq-preview');
    if (previewBtn) previewBtn.addEventListener('click', toggleSample);

    // Resize → redraw canvas
    new ResizeObserver(() => drawCanvas()).observe(el('eq-canvas')?.parentElement || document.body);
  }

  return {
    init, bindUI, loadSettings, saveSettings, saveCustomPreset,
    setGain, applyPreset, setEnabled, reset, getGains,
    getInput, getOutput,
    drawCanvas,
  };
})();
