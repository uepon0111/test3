'use strict';

/* ============================================================
   AUDIO ENGINE  —  再生エンジン
   ============================================================ */

const AudioEngine = (() => {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.playsInline = true;
  audio.setAttribute('playsinline', 'true');

  let ctx          = null;
  let mediaSource  = null;
  let gainNode     = null;
  let currentURL   = null;
  let trackGain    = 1;
  let mediaSessionBound = false;
  let loadGen      = 0;

  /* play log */
  let logStart    = null;
  let logTrackId  = null;

  /* shuffle queue */
  let shuffleQueue  = [];
  let shuffleIndex  = -1;


  function _applyGain() {
    if (!gainNode) return;
    const base = AppState.volume / 100;
    const norm = AppState.volumeNormalizeMode ? trackGain : 1;
    gainNode.gain.value = base * norm;
  }

  async function _measurePeakGain(arrayBuffer) {
    if (!arrayBuffer) return 1;
    try {
      const decoder = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await decoder.decodeAudioData(arrayBuffer.slice(0));
      let peak = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
        }
      }
      if (!ctx && decoder?.close) await decoder.close().catch(() => {});
      if (!peak || !isFinite(peak)) return 1;
      return clamp(0.9 / peak, 0.25, 4.0);
    } catch (e) {
      console.warn('Normalization analysis failed:', e);
      return 1;
    }
  }

  async function _ensureTrackNormalization(track, arrayBuffer) {
    if (!AppState.volumeNormalizeMode) {
      trackGain = 1;
      return 1;
    }
    if (typeof track.normalizationGain === 'number' && isFinite(track.normalizationGain) && track.normalizationGain > 0) {
      trackGain = track.normalizationGain;
      return trackGain;
    }
    const gain = await _measurePeakGain(arrayBuffer);
    trackGain = gain;
    track.normalizationGain = gain;
    AppState.updateTrack({ id: track.id, normalizationGain: gain });
    await Storage.saveTrack(track);
    return gain;
  }

  function _bindMediaSession() {
    if (mediaSessionBound || !('mediaSession' in navigator)) return;
    mediaSessionBound = true;
    const ms = navigator.mediaSession;
    const safeSet = (action, handler) => {
      try { ms.setActionHandler(action, handler); } catch (e) { /* unsupported */ }
    };
    safeSet('play', () => play());
    safeSet('pause', () => pause());
    safeSet('previoustrack', () => prev());
    safeSet('nexttrack', () => next());
    safeSet('seekto', details => {
      if (typeof details.seekTime === 'number' && isFinite(details.seekTime)) {
        audio.currentTime = clamp(details.seekTime, 0, isFinite(audio.duration) ? audio.duration : details.seekTime);
      }
    });
    safeSet('seekbackward', details => {
      const offset = details.seekOffset || 10;
      audio.currentTime = clamp((audio.currentTime || 0) - offset, 0, isFinite(audio.duration) ? audio.duration : Number.MAX_SAFE_INTEGER);
    });
    safeSet('seekforward', details => {
      const offset = details.seekOffset || 10;
      audio.currentTime = clamp((audio.currentTime || 0) + offset, 0, isFinite(audio.duration) ? audio.duration : Number.MAX_SAFE_INTEGER);
    });
  }

  function _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = AppState.currentTrackId ? AppState.getTrack(AppState.currentTrackId) : null;
    const artworkSrc = track?.thumbnail || 'assets/icons/icon-512.png';
    const artworkType = track?.thumbnail?.startsWith('data:image/jpeg') ? 'image/jpeg'
      : track?.thumbnail?.startsWith('data:image/webp') ? 'image/webp'
      : 'image/png';
    try {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track?.title || 'MusicBox',
          artist: track ? getArtistNames(track) : '',
          album: 'MusicBox',
          artwork: [
            { src: artworkSrc, sizes: '96x96', type: artworkType },
            { src: artworkSrc, sizes: '192x192', type: artworkType },
            { src: artworkSrc, sizes: '512x512', type: artworkType },
          ],
        });
      }
    } catch (e) {
      console.warn('MediaSession metadata error:', e);
    }
    navigator.mediaSession.playbackState = AppState.isPlaying ? 'playing' : 'paused';
  }

  /* ─── AudioContext init (user gesture 後に呼ぶ) ─── */
  async function _initCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mediaSource = ctx.createMediaElementSource(audio);
    gainNode    = ctx.createGain();
    _applyGain();

    Equalizer.init(ctx);
    mediaSource.connect(gainNode);
    gainNode.connect(Equalizer.getInput());
    Equalizer.getOutput().connect(ctx.destination);

    await Equalizer.loadSettings();
    _bindMediaSession();
  }

  /* ─── ファイル読み込み ─── */
  async function _loadTrack(trackId) {
    const gen = ++loadGen;
    const track = AppState.getTrack(trackId);
    if (!track) return false;

    if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }

    const buf = await Storage.getAudioFile(trackId);
    if (!buf) { Toast.error(`"${track.title}" のファイルが見つかりません`); return false; }
    if (gen !== loadGen) return false;

    if (AppState.volumeNormalizeMode) {
      await _ensureTrackNormalization(track, buf);
    } else {
      trackGain = 1;
    }

    currentURL = URL.createObjectURL(new Blob([buf]));
    audio.src  = currentURL;
    audio.playbackRate = AppState.playbackRate;
    _applyGain();
    AppState.setCurrentTrack(trackId);
    _updateMediaSession();
    return true;
  }

  /* ─── 再生 ─── */
  async function play(trackId) {
    if (trackId !== undefined && trackId !== AppState.currentTrackId) {
      const ok = await _loadTrack(trackId);
      if (!ok) return;
    }
    if (!AppState.currentTrackId) return;

    await _initCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    try {
      await audio.play();
      AppState.setPlaying(true);
      _updateMediaSession();
      _startLog();
    } catch (e) {
      console.error('Play error:', e);
      Toast.error('再生できませんでした');
    }
  }

  /* ─── 一時停止 ─── */
  function pause() {
    audio.pause();
    AppState.setPlaying(false);
    _updateMediaSession();
    _endLog();
  }

  /* ─── 再生・停止トグル ─── */
  async function togglePlay() {
    if (AppState.isPlaying) {
      pause();
    } else {
      if (AppState.currentTrackId) {
        await play();
      } else {
        const tracks = AppState.getCurrentListTracks();
        if (tracks.length) await play(tracks[0].id);
      }
    }
  }

  /* ─── 次の曲 ─── */
  async function next(fromEnded = false) {
    _endLog();
    const tracks = AppState.getCurrentListTracks();
    if (!tracks.length) return;

    /* repeat one */
    if (AppState.repeat === 'one' && fromEnded) {
      audio.currentTime = 0;
      await audio.play();
      AppState.setPlaying(true);
      _updateMediaSession();
      _startLog();
      return;
    }

    let nextId = null;
    if (AppState.shuffle) {
      nextId = _nextShuffle(tracks);
    } else {
      const idx = tracks.findIndex(t => t.id === AppState.currentTrackId);
      if (idx < tracks.length - 1) {
        nextId = tracks[idx + 1].id;
      } else if (AppState.repeat === 'all' || !fromEnded) {
        nextId = tracks[0].id;
      }
    }

    if (nextId) {
      await play(nextId);
    } else {
      AppState.setPlaying(false);
      audio.currentTime = 0;
    }
  }

  /* ─── 前の曲 ─── */
  async function prev() {
    _endLog();
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      if (AppState.isPlaying) { await audio.play(); _startLog(); }
      return;
    }

    const tracks = AppState.getCurrentListTracks();
    if (!tracks.length) return;

    let prevId = null;
    if (AppState.shuffle) {
      prevId = _prevShuffle(tracks);
    } else {
      const idx = tracks.findIndex(t => t.id === AppState.currentTrackId);
      prevId = idx > 0 ? tracks[idx - 1].id : tracks[tracks.length - 1].id;
    }
    if (prevId) await play(prevId);
  }

  /* ─── シーク ─── */
  function seek(pct) {
    if (!isFinite(audio.duration)) return;
    audio.currentTime = (clamp(pct, 0, 100) / 100) * audio.duration;
    AppState.setProgress(audio.currentTime, isFinite(audio.duration) ? audio.duration : 0);
  }

  /* ─── 音量 ─── */
  function setVolume(v) {
    AppState.setVolume(v);
    _applyGain();
  }

  /* ─── 速度 ─── */
  function setSpeed(v) {
    AppState.setSpeed(v);
    audio.playbackRate = v;
  }

  /* ─── シャッフル ─── */
  function setShuffle(v) {
    AppState.setShuffle(v);
    if (v) _buildQueue(AppState.getCurrentListTracks());
  }

  /* ─── リピート ─── */
  function setRepeat(v) {
    AppState.setRepeat(v);
  }

  function setVolumeNormalizeMode(v) {
    AppState.setVolumeNormalizeMode(v);
    const track = AppState.currentTrackId ? AppState.getTrack(AppState.currentTrackId) : null;
    trackGain = v ? (track?.normalizationGain || 1) : 1;
    _applyGain();
    if (v && track && !(typeof track.normalizationGain === 'number' && isFinite(track.normalizationGain) && track.normalizationGain > 0)) {
      Storage.getAudioFile(track.id)
        .then(buf => buf ? _ensureTrackNormalization(track, buf) : null)
        .then(() => {
          if (AppState.volumeNormalizeMode && AppState.currentTrackId === track.id) {
            trackGain = track.normalizationGain || 1;
            _applyGain();
          }
        })
        .catch(err => console.warn('Normalization preload failed:', err));
    }
  }

  /* ─── シャッフルキュー ─── */
  function _buildQueue(tracks) {
    shuffleQueue = [...tracks].sort(() => Math.random() - 0.5);
    const cur = AppState.currentTrackId;
    if (cur) {
      const i = shuffleQueue.findIndex(t => t.id === cur);
      if (i > 0) { [shuffleQueue[0], shuffleQueue[i]] = [shuffleQueue[i], shuffleQueue[0]]; }
    }
    shuffleIndex = 0;
  }
  function _nextShuffle(tracks) {
    if (!shuffleQueue.length) _buildQueue(tracks);
    shuffleIndex++;
    if (shuffleIndex >= shuffleQueue.length) {
      if (AppState.repeat === 'all') { _buildQueue(tracks); shuffleIndex = 0; }
      else return null;
    }
    return shuffleQueue[shuffleIndex]?.id || null;
  }
  function _prevShuffle(tracks) {
    if (shuffleIndex > 0) { shuffleIndex--; return shuffleQueue[shuffleIndex]?.id || null; }
    return tracks.length ? tracks[0].id : null;
  }

  /* ─── 再生ログ ─── */
  function _startLog() {
    logStart   = Date.now();
    logTrackId = AppState.currentTrackId;
  }
  async function _endLog() {
    if (!logStart || !logTrackId) return;
    const duration = (Date.now() - logStart) / 1000;
    if (duration >= 3) {
      await Storage.addPlayLog({ id: generateId(), trackId: logTrackId, playedAt: logStart, duration });
    }
    logStart = null; logTrackId = null;
  }

  /* ─── Audio element イベント ─── */
  audio.addEventListener('timeupdate', throttle(() => {
    AppState.setProgress(audio.currentTime, isFinite(audio.duration) ? audio.duration : 0);
    _updateMediaSession();
  }, 200));

  audio.addEventListener('play', () => {
    AppState.setPlaying(true);
    _updateMediaSession();
  });
  audio.addEventListener('pause', () => {
    if (!audio.ended) {
      AppState.setPlaying(false);
      _updateMediaSession();
    }
  });
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('error', () => {
    AppState.setPlaying(false);
    Toast.error('再生エラーが発生しました');
  });
  audio.addEventListener('loadedmetadata', () => {
    AppState.setProgress(0, isFinite(audio.duration) ? audio.duration : 0);
    _updateMediaSession();
  });
  audio.addEventListener('seeked', () => {
    AppState.setProgress(audio.currentTime, isFinite(audio.duration) ? audio.duration : 0);
  });

  EventBus.on('playback:update', () => { if (gainNode) _applyGain(); if (ctx && audio) audio.playbackRate = AppState.playbackRate; _updateMediaSession(); });
  EventBus.on('track:change', _updateMediaSession);

  /* ─── 公開 API ─── */
  return {
    play, pause, togglePlay, next, prev, seek,
    setVolume, setSpeed, setShuffle, setRepeat, setVolumeNormalizeMode,
    buildShuffleQueue: (tracks) => _buildQueue(tracks || AppState.getCurrentListTracks()),
    getCtx: () => ctx,
  };
})();
