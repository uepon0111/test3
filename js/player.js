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

  /* ─────────────────────────────────────────
     QUEUE MANAGEMENT
  ───────────────────────────────────────── */
  function setQueue(trackIds, startIndex = 0) {
    _origQueue  = [...trackIds];
    _queue      = [...trackIds];
    _currentIdx = Math.max(0, Math.min(startIndex, _queue.length - 1));

    if (_shuffle) _shuffleQueue();
    _loadCurrent();
  }

  function appendToQueue(trackIds) {
    const newIds = trackIds.filter(id => !_queue.includes(id));
    _origQueue.push(...newIds);
    _queue.push(...newIds);
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
      // Restore original order, keep current track
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
  ───────────────────────────────────────── */
  async function _loadCurrent() {
    _flushLog(); // flush previous track's log
    const trackId = getCurrentTrackId();
    if (!trackId) {
      _updateTrackUI(null);
      return;
    }

    try {
      const track = await Storage.getTrack(trackId);
      if (!track) { next(); return; }

      // Load audio blob
      const url = await Storage.getAudioBlobUrl(trackId);
      if (!url) {
        UI && UI.toast('音声データが見つかりません: ' + track.title, 'error');
        next();
        return;
      }

      audio.src = url;
      audio.playbackRate = _speed;
      audio.volume       = _muted ? 0 : _volume / 100;
      audio.load();

      _loggedTrackId = trackId;
      _playStartTime = null;
      _playedSeconds = 0;

      await _updateTrackUI(track);

      audio.play().catch(err => {
        console.warn('Autoplay blocked:', err);
        _updatePlayButtonUI(false);
      });
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
        // Nothing queued — try first track
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
      } else {
        _currentIdx = 0;
        _loadCurrent();
        audio.pause();
        _updatePlayButtonUI(false);
        return;
      }
    } else {
      _currentIdx = nextIdx;
    }
    _loadCurrent();
  }

  function prev() {
    if (!audio || audio.currentTime > 3) {
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

  function setVolume(val) {
    _volume = parseInt(val, 10);
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

  function setSpeed(val) {
    _speed = parseFloat(val);
    audio.playbackRate = _speed;
    _saveState();
  }

  /* ─────────────────────────────────────────
     PLAY LOG
  ───────────────────────────────────────── */
  function _startLogTimer() {
    _playStartTime = Date.now();
    // Flush log every 30s in case of long tracks
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
    // Save log if played for at least 1 second
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
    _pauseLogTimer();
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
  async function _updateTrackUI(track) {
    // Widget (landscape)
    const pwTitle   = document.getElementById('pw-title');
    const pwArtist  = document.getElementById('pw-artist');
    const pwArt     = document.getElementById('pw-album-art');
    const fpoTitle  = document.getElementById('fpo-title');
    const fpoArtist = document.getElementById('fpo-artist');
    const fpoArt    = document.getElementById('fpo-album-art');
    // Mini player (portrait)
    const mpTitle   = document.getElementById('mp-title');
    const mpArtist  = document.getElementById('mp-artist');
    const mpThumb   = document.getElementById('mp-thumb');

    if (!track) {
      if (pwTitle)  pwTitle.textContent  = '曲を選択してください';
      if (pwArtist) pwArtist.textContent = '—';
      if (fpoTitle)  fpoTitle.textContent  = '曲を選択してください';
      if (fpoArtist) fpoArtist.textContent = '—';
      if (mpTitle)  mpTitle.textContent  = '曲を選択してください';
      if (mpArtist) mpArtist.textContent = '—';
      return;
    }

    const name   = track.title  || '不明なタイトル';
    const artist = track.artist || '不明なアーティスト';

    if (pwTitle)  pwTitle.textContent  = name;
    if (pwArtist) pwArtist.textContent = artist;
    if (fpoTitle)  fpoTitle.textContent  = name;
    if (fpoArtist) fpoArtist.textContent = artist;
    if (mpTitle)  mpTitle.textContent  = name;
    if (mpArtist) mpArtist.textContent = artist;

    // Thumbnail
    const thumbUrl = track.thumbKey ? await Storage.getBlobUrl(track.thumbKey) : null;
    _setArtUI(pwArt,  thumbUrl);
    _setArtUI(fpoArt, thumbUrl);
    if (mpThumb) {
      if (thumbUrl) {
        mpThumb.innerHTML = `<img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover">`;
      } else {
        mpThumb.innerHTML = '<i class="fa-solid fa-music"></i>';
      }
    }

    // Notify UI to highlight current track in playlist
    if (typeof UI !== 'undefined') {
      UI.onTrackChange(track.id);
    }

    // Document title
    document.title = `${name} — Sonora`;
  }

  function _setArtUI(container, thumbUrl) {
    if (!container) return;
    // Keep the now-playing badge
    const badge = container.querySelector('.now-playing-badge');
    if (thumbUrl) {
      // Remove existing img/placeholder
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

  function _updateProgressUI(pct, cur, total) {
    // Landscape widget
    const pwFill   = document.getElementById('pw-progress-fill');
    const pwCur    = document.getElementById('pw-time-cur');
    const pwTotal  = document.getElementById('pw-time-total');
    // Full player overlay
    const fpoFill  = document.getElementById('fpo-progress-fill');
    const fpoCur   = document.getElementById('fpo-time-cur');
    const fpoTotal = document.getElementById('fpo-time-total');
    // Mini player
    const mpProg   = document.getElementById('mp-progress');

    const w = (pct * 100).toFixed(2) + '%';
    if (pwFill)  pwFill.style.width  = w;
    if (fpoFill) fpoFill.style.width = w;
    if (mpProg)  mpProg.style.width  = w;

    const fmt = s => {
      if (!s || isNaN(s)) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60).toString().padStart(2, '0');
      return `${m}:${sec}`;
    };
    if (pwCur)    pwCur.textContent    = fmt(cur);
    if (pwTotal)  pwTotal.textContent  = fmt(total);
    if (fpoCur)   fpoCur.textContent   = fmt(cur);
    if (fpoTotal) fpoTotal.textContent = fmt(total);
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
      if (_repeat === 'one') {
        icon.className = 'fa-solid fa-repeat-1';
      } else {
        icon.className = 'fa-solid fa-repeat';
      }
    });
  }

  function _updateVolumeUI() {
    // NOTE: pw-vol-icon / fpo-vol-icon are <button> elements.
    // We must update the <i> child, NOT the button itself,
    // otherwise btn-icon and other button classes get wiped.
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
     PROGRESS BAR CLICK HANDLERS
  ───────────────────────────────────────── */
  function _bindProgressBar(barId) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.addEventListener('click', e => {
      const rect = bar.getBoundingClientRect();
      const pct  = (e.clientX - rect.left) / rect.width;
      seekTo(pct);
    });
    // Drag support
    let dragging = false;
    bar.addEventListener('mousedown', () => { dragging = true; });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = bar.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekTo(pct);
    });
    document.addEventListener('mouseup', () => { dragging = false; });
    // Touch
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
  function _saveState() {
    Storage.setMeta('playerState', {
      queue:      _queue,
      origQueue:  _origQueue,
      currentIdx: _currentIdx,
      shuffle:    _shuffle,
      repeat:     _repeat,
      volume:     _volume,
      speed:      _speed,
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

    audio.volume       = _volume / 100;
    audio.playbackRate = _speed;

    // Update UI knobs
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

    // Load current track info (without auto-playing)
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

    // Update volume/speed on init
    audio.volume       = _volume / 100;
    audio.playbackRate = _speed;

    // Sync speed selects
    const speedSel = document.getElementById('pw-speed');
    const fpoSpeed = document.getElementById('fpo-speed');
    if (speedSel) speedSel.addEventListener('change', e => setSpeed(e.target.value));
    if (fpoSpeed) fpoSpeed.addEventListener('change', e => setSpeed(e.target.value));

    // Sync volume ranges
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
