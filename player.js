'use strict';
/* ================================================
   Player  –  video playback screen
   ================================================ */
const Player = (() => {
  /* ── State ── */
  let _fileId     = null;
  let _objUrl     = null;      /* current blob object URL */
  let _markers    = [];        /* sorted array of timestamps (seconds) */
  let _loop       = null;      /* { start, end? } | null */
  let _loopPhase  = 0;         /* 0=idle, 1=start set, 2=complete */
  let _loopOn     = false;
  let _mirrored   = false;
  let _speed      = 1.0;
  let _scrubbing  = false;

  const $ = id => document.getElementById(id);
  const video  = () => $('video');

  /* ══════════════════════════════════════════════
     OPEN / CLOSE
     ══════════════════════════════════════════════ */
  async function openPlayer(fileId) {
    _fileId = fileId;
    const file = Storage.getFile(fileId);
    if (!file) { alert('File record not found.'); return; }

    Loading.show('Loading video…');

    let blob;
    try {
      blob = await DB.getVideo(fileId);
    } catch (err) {
      Loading.hide();
      alert('Failed to load video: ' + err.message);
      return;
    }
    if (!blob) {
      Loading.hide();
      alert('Video data not found.');
      return;
    }

    /* Release any previous object URL */
    _revokeObjUrl();
    _objUrl = URL.createObjectURL(blob);

    /* Reset all state */
    _markers   = Storage.getMarkers(fileId);
    _loop      = Storage.getLoop(fileId);
    _loopPhase = (_loop && _loop.end !== undefined) ? 2
               : (_loop && _loop.start !== undefined) ? 1
               : 0;
    _loopOn    = false;
    _mirrored  = false;
    _speed     = 1.0;
    _scrubbing = false;

    /* Apply video settings */
    const v = video();
    v.classList.remove('mirrored');
    v.playbackRate = 1.0;
    v.src = _objUrl;
    v.load();

    /* Reset UI elements */
    $('play-icon').className = 'fa-solid fa-play';
    $('spd-label').textContent = '1.00x';
    $('progress-fill').style.width  = '0%';
    $('progress-handle').style.left = '0%';
    $('time-cur').textContent = '0:00';
    $('time-dur').textContent = '0:00';
    $('loop-bg').style.display = 'none';
    $('markers-layer').innerHTML    = '';
    $('loop-ticks-layer').innerHTML = '';

    _updateLoopSetBtn();
    _updateLoopToggleBtn();
    $('btn-mirror').classList.remove('is-active');

    /* Switch screen */
    _showPlayerUI(true);
    App.showScreen('screen-player');

    Loading.hide();

    /* Render overlays once metadata is ready */
    v.addEventListener('loadedmetadata', _onMetadata, { once: true });
  }

  function _onMetadata() {
    $('time-dur').textContent = _fmt(video().duration);
    _renderMarkers();
    _renderLoop();
  }

  function closePlayer() {
    const v = video();
    v.pause();
    v.src = '';
    v.load();
    _revokeObjUrl();
    _fileId = null;
    App.showScreen('screen-list');
  }

  function _revokeObjUrl() {
    if (_objUrl) { URL.revokeObjectURL(_objUrl); _objUrl = null; }
  }

  /* ══════════════════════════════════════════════
     PROGRESS BAR
     ══════════════════════════════════════════════ */
  function _fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function _updateProgress() {
    const v = video();
    if (!v.duration || !isFinite(v.duration)) return;
    const ratio = v.currentTime / v.duration;
    const pct   = (ratio * 100).toFixed(3) + '%';
    $('progress-fill').style.width  = pct;
    $('progress-handle').style.left = pct;
    $('time-cur').textContent = _fmt(v.currentTime);
  }

  function _initScrubbing() {
    const track = $('progress-track');

    function _seekAt(e) {
      const v    = video();
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (v.duration && isFinite(v.duration)) {
        v.currentTime = ratio * v.duration;
        _updateProgress();
      }
    }

    track.addEventListener('pointerdown', e => {
      e.preventDefault();
      _scrubbing = true;
      track.setPointerCapture(e.pointerId);
      _seekAt(e);
    });
    track.addEventListener('pointermove', e => {
      if (!_scrubbing) return;
      e.preventDefault();
      _seekAt(e);
    });
    track.addEventListener('pointerup', e => {
      if (!_scrubbing) return;
      _scrubbing = false;
      _seekAt(e);
    });
    track.addEventListener('pointercancel', () => { _scrubbing = false; });
  }

  /* ══════════════════════════════════════════════
     MARKERS
     ══════════════════════════════════════════════ */
  function _renderMarkers() {
    const layer = $('markers-layer');
    layer.innerHTML = '';
    const v = video();
    if (!v.duration || !isFinite(v.duration)) return;
    _markers.forEach(t => {
      const tick = document.createElement('div');
      tick.className = 'marker-tick';
      tick.style.left = ((t / v.duration) * 100).toFixed(3) + '%';
      layer.appendChild(tick);
    });
  }

  function _setMarker() {
    const v = video();
    if (!v.duration) return;
    const t = v.currentTime;
    /* Avoid duplicate markers within 0.1 s */
    if (_markers.some(m => Math.abs(m - t) < 0.1)) return;
    _markers.push(t);
    _markers.sort((a, b) => a - b);
    Storage.saveMarkers(_fileId, _markers);
    _renderMarkers();
  }

  function _jumpToMarker() {
    const v = video();
    const t = v.currentTime;
    const prev = _markers.filter(m => m < t - 0.05);
    v.currentTime = prev.length > 0 ? prev[prev.length - 1] : 0;
    _updateProgress();
  }

  function _deleteMarker() {
    const v = video();
    const t = v.currentTime;
    const prev = _markers.filter(m => m < t - 0.05);
    if (prev.length === 0) return;
    const closest = prev[prev.length - 1];
    _markers = _markers.filter(m => Math.abs(m - closest) > 0.001);
    Storage.saveMarkers(_fileId, _markers);
    _renderMarkers();
  }

  /* ══════════════════════════════════════════════
     LOOP
     ══════════════════════════════════════════════ */
  function _renderLoop() {
    const layer = $('loop-ticks-layer');
    const bg    = $('loop-bg');
    layer.innerHTML = '';
    const v = video();

    if (!_loop || !v.duration || !isFinite(v.duration)) {
      bg.style.display = 'none';
      return;
    }

    /* Start tick (blue) */
    if (_loop.start !== undefined) {
      const pct = ((_loop.start / v.duration) * 100).toFixed(3) + '%';
      const tick = document.createElement('div');
      tick.className = 'loop-tick-start';
      tick.style.left = pct;
      layer.appendChild(tick);
    }

    /* End tick (green) + colored region */
    if (_loop.end !== undefined) {
      const sPct = ((_loop.start / v.duration) * 100).toFixed(3);
      const ePct = ((_loop.end   / v.duration) * 100).toFixed(3);

      const tick = document.createElement('div');
      tick.className = 'loop-tick-end';
      tick.style.left = ePct + '%';
      layer.appendChild(tick);

      bg.style.display = 'block';
      bg.style.left    = sPct + '%';
      bg.style.width   = (ePct - sPct) + '%';
    } else {
      bg.style.display = 'none';
    }
  }

  function _setLoopPoint() {
    const v = video();
    if (!v.duration) return;
    const t = v.currentTime;

    if (_loopPhase === 0 || _loopPhase === 2) {
      /* Begin new loop – set start */
      _loop      = { start: t };
      _loopPhase = 1;
      _loopOn    = false;
    } else {
      /* Set end */
      if (t <= _loop.start) {
        _loop = { start: t, end: _loop.start };
      } else {
        _loop.end = t;
      }
      _loopPhase = 2;
    }
    Storage.saveLoop(_fileId, _loop);
    _renderLoop();
    _updateLoopSetBtn();
    _updateLoopToggleBtn();
  }

  function _toggleLoop() {
    if (!_loop || _loop.end === undefined) return;
    _loopOn = !_loopOn;
    _updateLoopToggleBtn();
  }

  function _deleteLoop() {
    if (!_loop) return;
    _loop      = null;
    _loopPhase = 0;
    _loopOn    = false;
    Storage.saveLoop(_fileId, null);
    _renderLoop();
    _updateLoopSetBtn();
    _updateLoopToggleBtn();
  }

  function _updateLoopSetBtn() {
    const btn = $('btn-lp-set');
    btn.classList.remove('loop-start', 'loop-complete');
    if (_loopPhase === 1) btn.classList.add('loop-start');
    if (_loopPhase === 2) btn.classList.add('loop-complete');
  }

  function _updateLoopToggleBtn() {
    $('btn-lp-toggle').classList.toggle('loop-on', _loopOn);
  }

  /* ══════════════════════════════════════════════
     VIDEO EVENT HANDLERS
     ══════════════════════════════════════════════ */
  function _onTimeUpdate() {
    if (!_scrubbing) _updateProgress();

    /* Enforce loop */
    if (_loopOn && _loop && _loop.end !== undefined) {
      const v = video();
      if (v.currentTime >= _loop.end) {
        v.currentTime = _loop.start;
      }
    }
  }

  /* ══════════════════════════════════════════════
     SPEED
     ══════════════════════════════════════════════ */
  function _changeSpeed(delta) {
    _speed = Math.round((_speed + delta) * 100) / 100;
    _speed = Math.max(0.05, Math.min(16.0, _speed));
    video().playbackRate = _speed;
    $('spd-label').textContent = _speed.toFixed(2) + 'x';
  }

  /* ══════════════════════════════════════════════
     UI HIDE / SHOW
     ══════════════════════════════════════════════ */
  function _showPlayerUI(visible) {
    if (visible) {
      $('player-ui').classList.remove('ui-hidden');
      $('btn-ui-show').setAttribute('hidden', '');
    } else {
      $('player-ui').classList.add('ui-hidden');
      $('btn-ui-show').removeAttribute('hidden');
    }
  }

  /* ══════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════ */
  function init() {
    const v = video();

    /* ── Prevent long-press context menu on all ctrl-btn ── */
    document.querySelectorAll('.ctrl-btn').forEach(btn => {
      btn.addEventListener('contextmenu', e => e.preventDefault());
    });

    /* ── Prevent all touch scrolling / pull-to-refresh on player ── */
    $('screen-player').addEventListener('touchmove', e => {
      e.preventDefault();
    }, { passive: false });

    /* ── Video events ── */
    v.addEventListener('timeupdate', _onTimeUpdate);
    v.addEventListener('play',   () => { $('play-icon').className = 'fa-solid fa-pause'; });
    v.addEventListener('pause',  () => { $('play-icon').className = 'fa-solid fa-play'; });
    v.addEventListener('ended',  () => { $('play-icon').className = 'fa-solid fa-play'; });

    /* ── Controls ── */

    /* Back */
    $('btn-back').addEventListener('click', closePlayer);

    /* Play / Pause */
    $('btn-play').addEventListener('click', () => {
      v.paused ? v.play() : v.pause();
    });

    /* Skip */
    $('btn-bk3').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 3); });
    $('btn-fw3').addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 3); });
    $('btn-bk5').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 5); });
    $('btn-fw5').addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); });

    /* Mirror */
    $('btn-mirror').addEventListener('click', () => {
      _mirrored = !_mirrored;
      v.classList.toggle('mirrored', _mirrored);
      $('btn-mirror').classList.toggle('is-active', _mirrored);
    });

    /* Speed */
    $('btn-spd-dn').addEventListener('click',    () => _changeSpeed(-0.05));
    $('btn-spd-up').addEventListener('click',    () => _changeSpeed(+0.05));
    $('btn-spd-reset').addEventListener('click', () => {
      _speed = 1.0;
      v.playbackRate = 1.0;
      $('spd-label').textContent = '1.00x';
    });

    /* Markers */
    $('btn-mk-set').addEventListener('click',  _setMarker);
    $('btn-mk-jump').addEventListener('click', _jumpToMarker);
    $('btn-mk-del').addEventListener('click',  _deleteMarker);

    /* Loop */
    $('btn-lp-set').addEventListener('click',    _setLoopPoint);
    $('btn-lp-toggle').addEventListener('click', _toggleLoop);
    $('btn-lp-del').addEventListener('click',    _deleteLoop);

    /* UI hide / show */
    $('btn-ui-hide').addEventListener('click', () => _showPlayerUI(false));
    $('btn-ui-show').addEventListener('click', () => _showPlayerUI(true));

    /* Progress scrubbing */
    _initScrubbing();
  }

  return { init, openPlayer };
})();
