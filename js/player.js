/**
 * player.js — Audio playback engine for Sonora
 *
 * Responsibilities:
 *   - Maintain a play queue (ordered list of track IDs)
 *   - Play / pause / seek / volume / speed
 *   - Shuffle & repeat modes (none / one / all)
 *   - Update all UI elements (widget + mini-player)
 *   - Write play logs to Storage
 *   - Fire events: onTrackChange, onPlayStateChange, onProgress
 */

const Player = (() => {
  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  const audio = document.getElementById('audio-el');

  let _queue      = [];   // array of track IDs in current play order
  let _origQueue  = [];   // original order before shuffle
  let _currentIdx = -1;   // index in _queue
  let _shuffle    = false;
  let _repeat     = 'none'; // 'none' | 'one' | 'all'
  let _volume     = 80;
  let _speed      = 1.0;
  let _muted      = false;

  // For logging: track when playback started
  let _playStartTime  = null;
  let _playedSeconds  = 0;
  let _loggedTrackId  = null;
  let _logFlushTimer  = null;

  // BlobURL trackers — revoked before each replacement to prevent memory leaks
  let _audioUrl      = null;  // current audio src blob URL
  let _playerThumbUrl = null; // current player thumbnail blob URL

  // PERF FIX: Cache progress-bar DOM references so _updateProgressUI()
  // (called 4x/second via timeupdate) doesn't re-query the DOM every call.
  let _progressEls = null;

  // PERF FIX: Cache track-info DOM references so _updateTrackUI()
  // (called on every track change) doesn't re-query the DOM every call.
  let _trackEls = null;

  function _initProgressEls() {
    _progressEls = {
      pwFill:   document.getElementById('pw-progress-fill'),
      pwCur:    document.getElementById('pw-time-cur'),
      pwTotal:  document.getElementById('pw-time-total'),
      fpoFill:  document.getElementById('fpo-progress-fill'),
      fpoCur:   document.getElementById('fpo-time-cur'),
      fpoTotal: document.getElementById('fpo-time-total'),
      mpProg:   document.getElementById('mp-progress'),
    };
  }

  function _initTrackEls() {
    _trackEls = {
      pwTitle:   document.getElementById('pw-title'),
      pwArtist:  document.getElementById('pw-artist'),
      pwArt:     document.getElementById('pw-album-art'),
      fpoTitle:  document.getElementById('fpo-title'),
      fpoArtist: document.getElementById('fpo-artist'),
      fpoArt:    document.getElementById('fpo-album-art'),
      mpTitle:   document.getElementById('mp-title'),
      mpArtist:  document.getElementById('mp-artist'),
      mpThumb:   document.getElementById('mp-thumb'),
    };
  }

  /* ─────────────────────────────────────────
     QUEUE MANAGEMENT
  ───────────────────────────────────────── */
  function setQueue(trackIds, startIndex = 0) {
    _origQueue  = [...trackIds];
    _queue      = [...trackIds];
    _currentIdx = _queue.length > 0
      ? Math.max(0, Math.min(startIndex, _queue.length - 1))
      : -1;

    if (_shuffle) _shuffleQueue();
    _saveState();
    _loadCurrent();
  }

  // PERF FIX: Use a Set for O(1) duplicate check instead of O(n) Array.includes().
  function appendToQueue(trackIds) {
    const existing = new Set(_queue);
    const newIds   = trackIds.filter(id => !existing.has(id));
    _origQueue.push(...newIds);
    _queue.push(...newIds);
    _saveState();
  }

  function getCurrentTrackId() {
    return _queue[_currentIdx] ?? null;
  }

  /* ─────────────────────────────────────────
     SHUFFLE
  ───────────────────────────────────────── */
  function _shuffleQueue() {
    const current = getCurrentTrackId();
    const rest    = _queue.filter(id => id !== current);
    // Fisher-Yates
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    if (current) {
      _queue = [current, ...rest];
      _currentIdx = 0;
    } else {
      _queue = rest;
    }
  }

  function toggleShuffle() {
    _shuffle = !_shuffle;
    if (_shuffle) {
      _shuffleQueue();
    } else {
      const currentId = getCurrentTrackId();
      _queue = [..._origQueue];
      _currentIdx = currentId ? _queue.indexOf(currentId) : 0;
      if (_currentIdx < 0) _currentIdx = 0;
    }
    _updateShuffleUI();
    _saveState();
  }

  /* ─────────────────────────────────────────
     REPEAT
  ───────────────────────────────────────── */
  function cycleRepeat() {
    const modes = ['none', 'all', 'one'];
    const i = modes.indexOf(_repeat);
    _repeat = modes[(i + 1) % modes.length];
    _updateRepeatUI();
    _saveState();
  }

  /* ─────────────────────────────────────────
     LOAD & PLAY
     autoPlay: set to false to load track info without starting playback
  ───────────────────────────────────────── */
  async function _loadCurrent(autoPlay = true) {
    _flushLog();
    const trackId = getCurrentTrackId();
    if (!trackId) {
      _updateTrackUI(null);
      return;
    }

    try {
      const track = await Storage.getTrack(trackId);
      if (!track) { next(); return; }

      const url = await Storage.getAudioBlobUrl(trackId);
      if (!url) {
        UI && UI.toast('音声データが見つかりません: ' + track.title, 'error');
        next();
        return;
      }

      if (_audioUrl) { try { URL.revokeObjectURL(_audioUrl); } catch {} }
      _audioUrl = url;
      audio.src = url;
      audio.playbackRate = _speed;
      audio.volume       = _muted ? 0 : _volume / 100;
      audio.load();

      _loggedTrackId = trackId;
      _playStartTime = null;
      _playedSeconds = 0;

      await _updateTrackUI(track);

      if (autoPlay) {
        audio.play().catch(err => {
          console.warn('Autoplay blocked:', err);
          _updatePlayButtonUI(false);
        });
      }
    } catch (err) {
      console.error('Load error:', err);
    }
  }

  /* ─────────────────────────────────────────
     CONTROLS
  ───────────────────────────────────────── */
  function togglePlay() {
    if (audio.paused) {
      if (!audio.src) {
        if (_queue.length > 0) { _currentIdx = 0; _loadCurrent(); }
        return;
      }
      audio.play();
    } else {
      audio.pause();
    }
  }

  function play() {
    if (audio.src) audio.play();
  }

  function pause() {
    audio.pause();
  }

  function next() {
    if (_queue.length === 0) return;
    if (_repeat === 'one') {
      audio.currentTime = 0;
      audio.play();
      return;
    }
    const nextIdx = _currentIdx + 1;
    if (nextIdx >= _queue.length) {
      if (_repeat === 'all') {
        _currentIdx = 0;
        _saveState(); // FIX: persist wrap-around so reload restores correct position
      } else {
        _currentIdx = 0;
        _loadCurrent(false);
        _updatePlayButtonUI(false);
        _saveState();
        return;
      }
    } else {
      _currentIdx = nextIdx;
    }
    _loadCurrent();
  }

  function prev() {
    if (!audio.src || audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (_queue.length === 0) return;
    _currentIdx = Math.max(0, _currentIdx - 1);
    _loadCurrent();
  }

  function seekTo(pct) {
    if (!audio.duration) return;
    audio.currentTime = audio.duration * Math.max(0, Math.min(1, pct));
  }

  function seekToSeconds(seconds) {
    if (!audio.duration) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
  }

  // FIX: Clamp to [0, 100] and guard against NaN to prevent
  // audio.volume receiving an out-of-range value and throwing DOMException.
  function setVolume(val) {
    const v = parseInt(val, 10);
    if (isNaN(v)) return;
    _volume = Math.max(0, Math.min(100, v));
    _muted  = false;
    audio.volume = _volume / 100;
    _updateVolumeUI();
    _saveState();
  }

  function toggleMute() {
    _muted = !_muted;
    audio.volume = _muted ? 0 : _volume / 100;
    _updateVolumeUI();
  }

  // FIX: Guard against NaN and non-positive values to prevent audio.playbackRate
  // receiving an invalid value and throwing a DOMException (same pattern as setVolume).
  function setSpeed(val) {
    const s = parseFloat(val);
    if (isNaN(s) || s <= 0) return;
    _speed = s;
    audio.playbackRate = _speed;
    _saveState();
  }

  /* ─────────────────────────────────────────
     PLAY LOG
  ───────────────────────────────────────── */
  function _startLogTimer() {
    _playStartTime = Date.now();
    clearInterval(_logFlushTimer);
    _logFlushTimer = setInterval(_accumulateLog, 30000);
  }

  function _pauseLogTimer() {
    _accumulateLog();
    clearInterval(_logFlushTimer);
    _logFlushTimer = null;
  }

  function _accumulateLog() {
    if (_playStartTime) {
      _playedSeconds += (Date.now() - _playStartTime) / 1000;
      _playStartTime = Date.now();
    }
  }

  function _flushLog() {
    _accumulateLog();
    clearInterval(_logFlushTimer);
    _logFlushTimer = null;
    if (_loggedTrackId && _playedSeconds >= 1) {
      Storage.addLog(_loggedTrackId, Math.round(_playedSeconds)).catch(() => {});
      if (typeof Drive !== 'undefined' && Drive.isLoggedIn()) {
        Drive.scheduleSyncLogs();
      }
    }
    _playedSeconds  = 0;
    _loggedTrackId  = null;
    _playStartTime  = null;
  }

  /* ─────────────────────────────────────────
     AUDIO EVENTS
  ───────────────────────────────────────── */
  audio.addEventListener('play', () => {
    _updatePlayButtonUI(true);
    _startLogTimer();
  });

  audio.addEventListener('pause', () => {
    _updatePlayButtonUI(false);
    _pauseLogTimer();
  });

  audio.addEventListener('ended', () => {
    _flushLog();
    next();
  });

  audio.addEventListener('timeupdate', _onTimeUpdate);

  audio.addEventListener('error', e => {
    console.error('Audio error:', e);
    setTimeout(next, 1000);
  });

  function _onTimeUpdate() {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    _updateProgressUI(pct, audio.currentTime, audio.duration);
  }

  /* ─────────────────────────────────────────
     UI UPDATERS
  ───────────────────────────────────────── */
  // PERF FIX: Use cached _trackEls instead of getElementById on every track change.
  async function _updateTrackUI(track) {
    const e = _trackEls;
    if (!e) return;

    if (!track) {
      if (e.pwTitle)   e.pwTitle.textContent   = '曲を選択してください';
      if (e.pwArtist)  e.pwArtist.textContent  = '—';
      if (e.fpoTitle)  e.fpoTitle.textContent  = '曲を選択してください';
      if (e.fpoArtist) e.fpoArtist.textContent = '—';
      if (e.mpTitle)   e.mpTitle.textContent   = '曲を選択してください';
      if (e.mpArtist)  e.mpArtist.textContent  = '—';
      return;
    }

    const name   = track.title  || '不明なタイトル';
    const artist = track.artist || '不明なアーティスト';

    if (e.pwTitle)   e.pwTitle.textContent   = name;
    if (e.pwArtist)  e.pwArtist.textContent  = artist;
    if (e.fpoTitle)  e.fpoTitle.textContent  = name;
    if (e.fpoArtist) e.fpoArtist.textContent = artist;
    if (e.mpTitle)   e.mpTitle.textContent   = name;
    if (e.mpArtist)  e.mpArtist.textContent  = artist;

    if (_playerThumbUrl) { try { URL.revokeObjectURL(_playerThumbUrl); } catch {} _playerThumbUrl = null; }
    const thumbUrl = track.thumbKey ? await Storage.getBlobUrl(track.thumbKey) : null;
    _playerThumbUrl = thumbUrl;
    _setArtUI(e.pwArt,  thumbUrl);
    _setArtUI(e.fpoArt, thumbUrl);
    if (e.mpThumb) {
      if (thumbUrl) {
        e.mpThumb.innerHTML = `<img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover">`;
      } else {
        e.mpThumb.innerHTML = '<i class="fa-solid fa-music"></i>';
      }
    }

    if (typeof UI !== 'undefined') {
      UI.onTrackChange(track.id);
    }

    document.title = `${name} — Sonora`;
  }

  function _setArtUI(container, thumbUrl) {
    if (!container) return;
    const badge = container.querySelector('.now-playing-badge');
    if (thumbUrl) {
      container.querySelectorAll('img, .art-placeholder').forEach(el => el.remove());
      const img = document.createElement('img');
      img.src = thumbUrl;
      container.insertBefore(img, badge);
    } else {
      container.querySelectorAll('img').forEach(el => el.remove());
      if (!container.querySelector('.art-placeholder')) {
        const ic = document.createElement('i');
        ic.className = 'fa-solid fa-music art-placeholder';
        container.insertBefore(ic, badge);
      }
    }
  }

  function _updatePlayButtonUI(playing) {
    ['pw-play', 'mp-play', 'fpo-play'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const icon = btn.querySelector('i');
      if (!icon) return;
      if (playing) {
        icon.classList.remove('fa-play');
        icon.classList.add('fa-pause');
      } else {
        icon.classList.remove('fa-pause');
        icon.classList.add('fa-play');
      }
    });
  }

  // PERF FIX: Use cached element references (_progressEls) instead of
  // calling getElementById on every timeupdate event (fires ~4x per second).
  function _updateProgressUI(pct, cur, total) {
    const e = _progressEls;
    if (!e) return;

    const w = (pct * 100).toFixed(2) + '%';
    if (e.pwFill)  e.pwFill.style.width  = w;
    if (e.fpoFill) e.fpoFill.style.width = w;
    if (e.mpProg)  e.mpProg.style.width  = w;

    const fmt = s => {
      if (!s || isNaN(s)) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60).toString().padStart(2, '0');
      return `${m}:${sec}`;
    };
    if (e.pwCur)    e.pwCur.textContent    = fmt(cur);
    if (e.pwTotal)  e.pwTotal.textContent  = fmt(total);
    if (e.fpoCur)   e.fpoCur.textContent   = fmt(cur);
    if (e.fpoTotal) e.fpoTotal.textContent = fmt(total);
  }

  function _updateShuffleUI() {
    ['pw-shuffle', 'fpo-shuffle'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.toggle('active', _shuffle);
    });
  }

  function _updateRepeatUI() {
    ['pw-repeat', 'fpo-repeat'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      const icon = btn.querySelector('i');
      btn.classList.toggle('active', _repeat !== 'none');
      // BUG FIX: guard against btn having no <i> child to prevent TypeError.
      if (!icon) return;
      if (_repeat === 'one') {
        icon.className = 'fa-solid fa-repeat-1';
      } else {
        icon.className = 'fa-solid fa-repeat';
      }
    });
  }

  function _updateVolumeUI() {
    const iconBtn    = document.getElementById('pw-vol-icon');
    const fpoIconBtn = document.getElementById('fpo-vol-icon');
    const volRange   = document.getElementById('pw-vol');
    const fpoVol     = document.getElementById('fpo-vol');

    const iconClass = _muted || _volume === 0 ? 'fa-solid fa-volume-xmark'
      : _volume < 40 ? 'fa-solid fa-volume-low'
      : 'fa-solid fa-volume-high';

    [iconBtn, fpoIconBtn].forEach(btn => {
      if (!btn) return;
      const i = btn.querySelector('i');
      if (i) i.className = iconClass;
    });
    if (volRange && !_muted) volRange.value = _volume;
    if (fpoVol   && !_muted) fpoVol.value   = _volume;
  }

  /* ─────────────────────────────────────────
     PROGRESS BAR CLICK / DRAG HANDLERS
     FIX: document-level mousemove/mouseup listeners are registered ONCE here
     (not inside _bindProgressBar) to prevent duplicate handlers when two bars
     are initialised. _draggingBar tracks which bar is currently being dragged.
  ───────────────────────────────────────── */
  let _draggingBar = null;

  document.addEventListener('mousemove', e => {
    if (!_draggingBar) return;
    const rect = _draggingBar.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  });

  document.addEventListener('mouseup', () => { _draggingBar = null; });

  function _bindProgressBar(barId) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.addEventListener('click', e => {
      const rect = bar.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      seekTo(pct);
    });
    bar.addEventListener('mousedown', () => { _draggingBar = bar; });
    bar.addEventListener('touchmove', e => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect  = bar.getBoundingClientRect();
      const pct   = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
      seekTo(pct);
    }, { passive: false });
  }

  /* ─────────────────────────────────────────
     SAVE / RESTORE STATE
  ───────────────────────────────────────── */
  // FIX: Also save _muted so the mute state survives page reload.
  function _saveState() {
    Storage.setMeta('playerState', {
      queue:      _queue,
      origQueue:  _origQueue,
      currentIdx: _currentIdx,
      shuffle:    _shuffle,
      repeat:     _repeat,
      volume:     _volume,
      speed:      _speed,
      muted:      _muted,
    }).catch(() => {});
  }

  async function restoreState() {
    const state = await Storage.getMeta('playerState');
    if (!state) return;
    _queue      = state.queue      || [];
    _origQueue  = state.origQueue  || [];
    _currentIdx = state.currentIdx ?? -1;
    _shuffle    = state.shuffle    || false;
    _repeat     = state.repeat     || 'none';
    _volume     = state.volume     ?? 80;
    _speed      = state.speed      || 1.0;
    // FIX: Restore muted state (previously not restored).
    _muted      = state.muted      || false;

    audio.volume       = _muted ? 0 : _volume / 100;
    audio.playbackRate = _speed;

    const volRange = document.getElementById('pw-vol');
    const fpoVol   = document.getElementById('fpo-vol');
    const speedSel = document.getElementById('pw-speed');
    const fpoSpeed = document.getElementById('fpo-speed');
    if (volRange) volRange.value = _volume;
    if (fpoVol)   fpoVol.value   = _volume;
    if (speedSel) speedSel.value = _speed;
    if (fpoSpeed) fpoSpeed.value = _speed;

    _updateShuffleUI();
    _updateRepeatUI();
    _updateVolumeUI();

    const trackId = getCurrentTrackId();
    if (trackId) {
      const track = await Storage.getTrack(trackId);
      if (track) await _updateTrackUI(track);
    }
  }

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */
  function init() {
    _bindProgressBar('pw-progress-bar');
    _bindProgressBar('fpo-progress-bar');

    // PERF FIX: Cache progress-bar and track-info element references once at init.
    _initProgressEls();
    _initTrackEls();

    audio.volume       = _volume / 100;
    audio.playbackRate = _speed;

    const speedSel = document.getElementById('pw-speed');
    const fpoSpeed = document.getElementById('fpo-speed');
    if (speedSel) speedSel.addEventListener('change', e => setSpeed(e.target.value));
    if (fpoSpeed) fpoSpeed.addEventListener('change', e => setSpeed(e.target.value));

    const volRange = document.getElementById('pw-vol');
    const fpoVol   = document.getElementById('fpo-vol');
    const syncVol  = e => setVolume(e.target.value);
    if (volRange) volRange.addEventListener('input', syncVol);
    if (fpoVol)   fpoVol.addEventListener('input',   syncVol);
  }

  /* ─────────────────────────────────────────
     GETTERS (for UI)
  ───────────────────────────────────────── */
  function isPlaying()      { return !audio.paused; }
  function isShuffle()      { return _shuffle; }
  function getRepeat()      { return _repeat; }
  function getQueue()       { return [..._queue]; }
  function getCurrentIndex(){ return _currentIdx; }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    init,
    restoreState,

    // Queue
    setQueue,
    appendToQueue,
    getCurrentTrackId,
    getQueue,
    getCurrentIndex,

    // Controls
    togglePlay,
    play,
    pause,
    next,
    prev,
    seekTo,
    seekToSeconds,
    setVolume,
    toggleMute,
    setSpeed,

    // Modes
    toggleShuffle,
    cycleRepeat,

    // State
    isPlaying,
    isShuffle,
    getRepeat,
  };
})();
