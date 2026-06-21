'use strict';

/* ============================================================
   EQUALIZER  —  Web Audio API 10バンドイコライザ
   ============================================================ */

const Equalizer = (() => {

  const BANDS       = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const BAND_LABELS = ['32Hz','64Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz'];

  const PRESETS = {
    'ノーマル':   [0,  0,  0,  0,  0,  0,  0,  0,  0,  0],
    'ポップ':     [-2,-1,  0,  2,  4,  4,  3,  1,  0, -1],
    'ロック':     [ 5, 4,  3,  2, -1, -1,  0,  3,  4,  5],
    'クラシック': [ 5, 4,  3,  1, -2,  0,  0,  2,  3,  4],
    'ジャズ':     [ 4, 3,  2,  3, -2, -2,  0,  1,  3,  4],
    '低音強調':   [ 8, 7,  5,  3,  1,  0,  0, -1, -1, -1],
    '高音強調':   [-1,-1,  0,  0,  0,  1,  3,  5,  7,  8],
    'ボイス':     [-4,-3,  0,  3,  6,  5,  4,  2,  0, -2],
  };

  let _ctx           = null;
  let _filters       = [];
  let _input         = null;
  let _output        = null;
  let _enabled       = true;
  let _gains         = new Array(BANDS.length).fill(0);
  let _canvas        = null;
  let _sampleNode    = null;
  let _samplePlaying = false;
  let _customPresets = [];   // { name, gains[] }
  let _saveTimer     = null;

  /* ─── Init ─── */
  function init(audioCtx) {
    _ctx = audioCtx;
    _filters = BANDS.map((freq, i) => {
      const f = _ctx.createBiquadFilter();
      f.type            = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      f.frequency.value = freq;
      f.Q.value         = 1.4;
      f.gain.value      = 0;
      return f;
    });
    for (let i = 0; i < _filters.length - 1; i++) _filters[i].connect(_filters[i + 1]);
    _input  = _filters[0];
    _output = _filters[_filters.length - 1];
  }

  function getInput()  { return _input; }
  function getOutput() { return _output; }

  /* ─── Gain ─── */
  function setGain(bandIndex, db) {
    _gains[bandIndex] = db;
    if (_filters[bandIndex]) _filters[bandIndex].gain.value = _enabled ? db : 0;
    drawCanvas();
    _schedSave();
  }

  function applyPreset(name) {
    // Built-in presets
    let vals = PRESETS[name];
    // Custom presets
    if (!vals) {
      const cp = _customPresets.find(p => p.name === name);
      if (cp) vals = cp.gains;
    }
    if (!vals) return;
    _gains = [...vals];
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = _enabled ? g : 0;
    });
    drawCanvas();
    _renderBandSliders();
    _schedSave();
  }

  function setEnabled(v) {
    _enabled = v;
    _gains.forEach((g, i) => {
      if (_filters[i]) _filters[i].gain.value = v ? g : 0;
    });
    drawCanvas();
    _schedSave();
  }

  function getGains() { return [..._gains]; }

  /* ─── 保存スケジュール (デバウンス) ─── */
  function _schedSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveSettings(), 800);
  }

  /* ─── Canvas ─── */
  function initCanvas(canvasEl) { _canvas = canvasEl; drawCanvas(); }

  function drawCanvas() {
    if (!_canvas) return;
    const W = _canvas.offsetWidth  || 400;
    const H = _canvas.offsetHeight || 120;
    _canvas.width  = W;
    _canvas.height = H;
    const ctx = _canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth   = 1;
    [-12,-6,0,6,12].forEach(db => {
      const y = _dbToY(db, H);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = '#334155';
      ctx.font = '10px sans-serif';
      ctx.fillText(`${db}dB`, 4, y - 3);
    });

    // 0dB reference
    const mid = _dbToY(0, H);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

    if (!_enabled) {
      ctx.strokeStyle = '#60a5fa55'; ctx.lineWidth = 2; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const pts = BANDS.map((_, i) => ({ x: _freqToX(BANDS[i], W), y: _dbToY(_gains[i], H) }));

    // Fill
    ctx.beginPath();
    ctx.moveTo(0, mid);
    _smoothCurve(ctx, pts);
    ctx.lineTo(W, mid);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#3b82f640');
    grad.addColorStop(1, '#3b82f608');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    _smoothCurve(ctx, pts);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.stroke();

    // Dots
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#60a5fa';
      ctx.fill();
    });
  }

  function _smoothCurve(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const cpx = (pts[i].x + pts[i+1].x) / 2;
      ctx.bezierCurveTo(cpx, pts[i].y, cpx, pts[i+1].y, pts[i+1].x, pts[i+1].y);
    }
  }
  function _freqToX(f, W) {
    const lMin = Math.log10(20), lMax = Math.log10(20000);
    return ((Math.log10(f) - lMin) / (lMax - lMin)) * W;
  }
  function _dbToY(db, H) { return H / 2 - (db / 12) * (H / 2 - 10); }

  /* ─── Band sliders UI ─── */
  function _renderBandSliders() {
    const wrap = el('eq-bands-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';
    BANDS.forEach((_, i) => {
      const band = document.createElement('div');
      band.className = 'eq-band';

      const valLbl = document.createElement('div');
      valLbl.className = 'eq-band-value';
      valLbl.id = `eq-val-${i}`;
      valLbl.textContent = `${_gains[i] >= 0 ? '+' : ''}${_gains[i]}dB`;

      const sw = document.createElement('div');
      sw.className = 'eq-slider-wrap';
      const sl = document.createElement('input');
      sl.type = 'range'; sl.className = 'eq-slider';
      sl.min = -12; sl.max = 12; sl.step = 0.5;
      sl.value = _gains[i];
      sl.setAttribute('aria-label', BAND_LABELS[i]);
      sl.addEventListener('input', () => {
        const v = parseFloat(sl.value);
        setGain(i, v);
        valLbl.textContent = `${v >= 0 ? '+' : ''}${v}dB`;
        _markCustom();
      });
      sw.appendChild(sl);

      const fl = document.createElement('div');
      fl.className = 'eq-band-label';
      fl.textContent = BAND_LABELS[i];

      band.appendChild(valLbl);
      band.appendChild(sw);
      band.appendChild(fl);
      wrap.appendChild(band);
    });
  }

  /* ─── Preset buttons UI ─── */
  function _renderPresetButtons() {
    const wrap = el('eq-preset-btns');
    if (!wrap) return;
    wrap.innerHTML = '';

    // Built-in presets
    Object.keys(PRESETS).forEach(name => {
      wrap.appendChild(_makePresetBtn(name, false));
    });
    // Custom presets
    _customPresets.forEach(cp => {
      wrap.appendChild(_makePresetBtn(cp.name, true));
    });

    // "カスタム保存" button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'eq-preset-btn eq-preset-save';
    saveBtn.textContent = '＋ 保存…';
    saveBtn.title = '現在の設定をカスタムプリセットとして保存';
    saveBtn.addEventListener('click', _promptSaveCustom);
    wrap.appendChild(saveBtn);
  }

  function _makePresetBtn(name, isCustom) {
    const btn = document.createElement('button');
    btn.className = 'eq-preset-btn';
    btn.dataset.preset = name;

    const label = document.createElement('span');
    label.textContent = name;
    btn.appendChild(label);

    if (isCustom) {
      const del = document.createElement('span');
      del.className = 'eq-preset-del';
      del.textContent = '×';
      del.title = '削除';
      del.addEventListener('click', async e => {
        e.stopPropagation();
        _customPresets = _customPresets.filter(p => p.name !== name);
        await saveSettings();
        _renderPresetButtons();
        Toast.info(`「${name}」を削除しました`);
      });
      btn.appendChild(del);
    }

    btn.addEventListener('click', () => {
      document.querySelectorAll('#eq-preset-btns .eq-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyPreset(name);
    });
    return btn;
  }

  function _markCustom() {
    document.querySelectorAll('#eq-preset-btns .eq-preset-btn').forEach(b => b.classList.remove('active'));
  }

  async function _promptSaveCustom() {
    // Show inline name input
    const wrap = el('eq-preset-btns');
    if (!wrap) return;
    const existing = wrap.querySelector('.eq-name-input-wrap');
    if (existing) { existing.remove(); return; }

    const row = document.createElement('div');
    row.className = 'eq-name-input-wrap';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%;padding:6px 0;';

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'プリセット名';
    inp.className = 'form-input';
    inp.style.flex = '1';

    const ok = document.createElement('button');
    ok.className = 'primary-btn';
    ok.style.padding = '6px 12px';
    ok.textContent = '保存';

    const cancel = document.createElement('button');
    cancel.className = 'secondary-btn';
    cancel.style.padding = '6px 12px';
    cancel.textContent = 'キャンセル';

    row.appendChild(inp); row.appendChild(ok); row.appendChild(cancel);
    wrap.appendChild(row);
    inp.focus();

    const doSave = async () => {
      const name = inp.value.trim();
      if (!name) { Toast.error('名前を入力してください'); return; }
      if (_customPresets.find(p => p.name === name) || PRESETS[name]) {
        Toast.error('同じ名前のプリセットが既に存在します'); return;
      }
      _customPresets.push({ name, gains: [..._gains] });
      await saveSettings();
      _renderPresetButtons();
      // Mark the new preset as active
      document.querySelectorAll('#eq-preset-btns .eq-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === name);
      });
      Toast.success(`「${name}」を保存しました`);
    };

    ok.addEventListener('click', doSave);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
    cancel.addEventListener('click', () => row.remove());
  }

  /* ─── サンプル音源（BGMライクな合成音楽） ─── */
  function stopSample() {
    if (_sampleNode) {
      try { _sampleNode.stop(0); } catch {}
      _sampleNode.disconnect();
      _sampleNode = null;
    }
    _samplePlaying = false;
    const btn = el('btn-eq-preview');
    if (btn) { btn.innerHTML = '<i data-lucide="play" style="width:16px;height:16px"></i>'; lucide.createIcons({ elements: [btn] }); }
    const st = el('eq-preview-status');
    if (st) st.textContent = '停止中';
  }

  async function toggleSample() {
    if (_samplePlaying) { stopSample(); return; }
    if (!_ctx) return Toast.error('まず曲を再生してイコライザを有効にしてください');
    if (_ctx.state === 'suspended') await _ctx.resume();

    const sr  = _ctx.sampleRate;
    const bpm = 120;
    const beat = 60 / bpm;
    const bars = 4;
    const dur  = beat * 4 * bars; // 4小節
    const buf  = _ctx.createBuffer(2, Math.ceil(sr * dur), sr);

    const type = el('eq-sample-select')?.value || 'full';
    _fillMusicBuffer(buf, sr, dur, bpm, type);

    _sampleNode = _ctx.createBufferSource();
    _sampleNode.buffer = buf;
    _sampleNode.loop   = true;
    _sampleNode.connect(_input || _ctx.destination);
    _sampleNode.start(0);
    _sampleNode.onended = () => stopSample();
    _samplePlaying = true;

    const btn = el('btn-eq-preview');
    if (btn) { btn.innerHTML = '<i data-lucide="square" style="width:16px;height:16px"></i>'; lucide.createIcons({ elements: [btn] }); }
    const st = el('eq-preview-status');
    if (st) st.textContent = '再生中（ループ）';
  }

  function _fillMusicBuffer(buf, sr, dur, bpm, type) {
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const beat  = 60 / bpm;
    const total = buf.length;

    function env(t, atk, dec, sus, rel, gate) {
      if (t < 0 || t > gate + rel) return 0;
      if (t < atk) return t / atk;
      if (t < atk + dec) return 1 - (1 - sus) * (t - atk) / dec;
      if (t < gate) return sus;
      return sus * (1 - (t - gate) / rel);
    }

    function noteFreq(semitone) { return 440 * Math.pow(2, semitone / 12); }

    // ── コード進行 Am F C G (各1小節) ──
    const chords = [
      [0, 3, 7],     // Am: A C E
      [-3, 0, 5],    // F: F A C
      [-9, -5, -2],  // C: C E G
      [-2, 2, 5],    // G: G B D
    ];
    // Amスケール上のメロディ
    const melody = [0, 2, 3, 5, 7, 5, 3, 2, 0, 2, 3, 7, 5, 3, 2, 0];
    // ベースライン (各コードのルート)
    const bassRoots = [-12, -15, -21, -14];

    for (let n = 0; n < total; n++) {
      const t    = n / sr;
      const bar  = Math.floor(t / (beat * 4)) % 4;
      const beat4 = (t % (beat * 4)) / beat; // 0..4 within bar
      const beatI = Math.floor(beat4);
      const tInBeat = beat4 - beatI;

      let s = 0;

      // ── ピアノ和音 ──
      if (type === 'full' || type === 'chord') {
        const chord = chords[bar];
        const chordGate = beat * 3.8;
        const tChord = t % (beat * 4);
        const eC = env(tChord, 0.01, 0.15, 0.5, 0.3, chordGate);
        chord.forEach(semi => {
          const f = noteFreq(semi);
          s += 0.10 * eC * (
            Math.sin(2 * Math.PI * f * t) +
            0.5 * Math.sin(2 * Math.PI * f * 2 * t) +
            0.25 * Math.sin(2 * Math.PI * f * 3 * t)
          );
        });
      }

      // ── メロディ (シンセリード) ──
      if (type === 'full' || type === 'melody') {
        const totalBeats = Math.floor(t / (beat / 2)) % 16;
        const semi = melody[totalBeats % melody.length];
        const tNote = (t % (beat / 2));
        const eM = env(tNote, 0.005, 0.05, 0.6, 0.15, beat / 2 * 0.9);
        const fm = noteFreq(semi + 12);
        s += 0.12 * eM * (
          Math.sin(2 * Math.PI * fm * t) +
          0.3 * Math.sin(2 * Math.PI * fm * 2 * t + 0.5)
        );
      }

      // ── ベース ──
      if (type === 'full' || type === 'bass') {
        const tBass = t % beat;
        const eBass = env(tBass, 0.005, 0.08, 0.6, 0.2, beat * 0.85);
        const fb = noteFreq(bassRoots[bar]);
        s += 0.20 * eBass * (
          Math.sin(2 * Math.PI * fb * t) +
          0.3 * Math.sin(2 * Math.PI * fb * 2 * t)
        );
      }

      // ── ドラム ──
      if (type === 'full' || type === 'drum') {
        const tBeat = t % beat;
        // キック (1拍目・3拍目)
        if (beatI === 0 || beatI === 2) {
          const ek = env(tBeat, 0, 0.02, 0, 0.15, beat * 0.4);
          const kickF = 60 * Math.exp(-tBeat * 40);
          s += 0.35 * ek * Math.sin(2 * Math.PI * kickF * t);
        }
        // スネア (2拍目・4拍目) - ノイズ
        if (beatI === 1 || beatI === 3) {
          const es = env(tBeat, 0, 0.01, 0, 0.12, beat * 0.3);
          s += 0.15 * es * (Math.random() * 2 - 1) * (1 - tBeat / beat);
        }
        // ハイハット (8分音符)
        {
          const tHH = t % (beat / 2);
          const eh = env(tHH, 0, 0.005, 0, 0.04, beat / 2 * 0.4);
          s += 0.06 * eh * (Math.random() * 2 - 1);
        }
      }

      // クリッピング防止
      const v = Math.max(-0.95, Math.min(0.95, s));
      // ステレオ揺らぎ
      L[n] = v * (1 + 0.02 * Math.sin(2 * Math.PI * 0.3 * t));
      R[n] = v * (1 - 0.02 * Math.sin(2 * Math.PI * 0.3 * t));
    }
  }

  /* ─── Save / Load ─── */
  async function saveSettings() {
    await Storage.setSetting('eq_gains',   _gains);
    await Storage.setSetting('eq_enabled', _enabled);
    await Storage.setSetting('eq_custom',  _customPresets);
  }
  async function loadSettings() {
    const gains   = await Storage.getSetting('eq_gains',   new Array(BANDS.length).fill(0));
    const enabled = await Storage.getSetting('eq_enabled', true);
    const custom  = await Storage.getSetting('eq_custom',  []);
    _gains         = gains;
    _enabled       = enabled;
    _customPresets = custom;
    _gains.forEach((g, i) => { if (_filters[i]) _filters[i].gain.value = enabled ? g : 0; });
    const tog = el('eq-enabled');
    if (tog) tog.checked = enabled;
    _renderBandSliders();
    _renderPresetButtons();
    drawCanvas();
  }

  /* ─── Bind UI ─── */
  function bindUI() {
    _renderPresetButtons();
    _renderBandSliders();
    initCanvas(el('eq-canvas'));

    const tog = el('eq-enabled');
    if (tog) tog.addEventListener('change', async () => { setEnabled(tog.checked); });

    const prevBtn = el('btn-eq-preview');
    if (prevBtn) prevBtn.addEventListener('click', toggleSample);

    // Canvas resize observer
    const wrap = el('eq-canvas')?.parentElement;
    if (wrap) new ResizeObserver(() => drawCanvas()).observe(wrap);
  }

  return {
    init, bindUI, loadSettings, saveSettings,
    setGain, applyPreset, setEnabled, getGains,
    getInput, getOutput, drawCanvas,
  };
})();
