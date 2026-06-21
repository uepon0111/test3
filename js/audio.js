'use strict';

/* ============================================================
   AUDIO ENGINE  —  再生エンジン
   ============================================================ */

const AudioEngine = (() => {
  const audio = new Audio();
  audio.preload = 'metadata';
  // バックグラウンド再生を許可
  audio.setAttribute('playsinline', '');

  let ctx          = null;
  let mediaSource  = null;
  let gainNode     = null;
  let currentURL   = null;
  let loadGen      = 0;

  /* play log */
  let logStart    = null;
  let logTrackId  = null;

  /* shuffle queue */
  let shuffleQueue  = [];
  let shuffleIndex  = -1;

  /* ─── AudioContext init (user gesture 後に呼ぶ) ─── */
  async function _initCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mediaSource = ctx.createMediaElementSource(audio);
    gainNode    = ctx.createGain();
    gainNode.gain.value = AppState.volume / 100;

    Equalizer.init(ctx);
    mediaSource.connect(gainNode);
    gainNode.connect(Equalizer.getInput());
    Equalizer.getOutput().connect(ctx.destination);

    await Equalizer.loadSettings();
  }

  /* ─── MediaSession API ─── */
  function _updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const id    = AppState.currentTrackId;
    const track = id ? AppState.getTrack(id) : null;
    if (!track) { navigator.mediaSession.metadata = null; return; }

    const artwork = track.thumbnail
      ? [{ src: track.thumbnail, sizes: '256x256', type: 'image/jpeg' }]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title:   track.title  || '不明のタイトル',
      artist:  getArtistNames(track),
      album:   'MusicBox',
      artwork,
    });

    navigator.mediaSession.setActionHandler('play',          () => play());
    navigator.mediaSession.setActionHandler('pause',         () => pause());
    navigator.mediaSession.setActionHandler('nexttrack',     () => next());
    navigator.mediaSession.setActionHandler('previoustrack', () => prev());
    navigator.mediaSession.setActionHandler('seekto', e => {
      if (isFinite(audio.duration) && e.seekTime !== undefined)
        audio.currentTime = e.seekTime;
    });
    navigator.mediaSession.setActionHandler('seekbackward', e => {
      audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', e => {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + (e.seekOffset || 10));
    });
  }

  function _setMsPlaybackState(state) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  /* ─── ファイル読み込み ─── */
  async function _loadTrack(trackId) {
    const gen = ++loadGen;
    const track = AppState.getTrack(trackId);
    if (!track) return false;

    if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
    // audio.src をリセットして前の音が鳴り続けないようにする
    audio.pause();
    audio.src = '';

    const buf = await Storage.getAudioFile(trackId);
    if (!buf) { Toast.error(`"${track.title}" のファイルが見つかりません`); return false; }
    if (gen !== loadGen) return false;

    currentURL = URL.createObjectURL(new Blob([buf]));
    audio.src  = currentURL;
    audio.playbackRate = AppState.playbackRate;
    AppState.setCurrentTrack(trackId);
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
      _setMsPlaybackState('playing');
      _updateMediaSession();
      _startLog();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('Play error:', e);
        Toast.error('再生できませんでした');
      }
    }
  }

  /* ─── 一時停止 ─── */
  function pause() {
    audio.pause();
    AppState.setPlaying(false);
    _setMsPlaybackState('paused');
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

    if (AppState.repeat === 'one' && fromEnded) {
      audio.currentTime = 0;
      try { await audio.play(); AppState.setPlaying(true); _startLog(); } catch {}
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
      pause();
      audio.currentTime = 0;
      AppState.setProgress(0, isFinite(audio.duration) ? audio.duration : 0);
    }
  }

  /* ─── 前の曲 ─── */
  async function prev() {
    _endLog();
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      if (AppState.isPlaying) { try { await audio.play(); _startLog(); } catch {} }
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
    if (!isFinite(audio.duration) || audio.duration === 0) return;
    audio.currentTime = (clamp(pct, 0, 100) / 100) * audio.duration;
  }

  /* ─── 音量 ─── */
  function setVolume(v) {
    AppState.setVolume(v);
    if (gainNode) gainNode.gain.value = v / 100;
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
  function setRepeat(v) { AppState.setRepeat(v); }

  /* ─── シャッフルキュー ─── */
  function _buildQueue(tracks) {
    shuffleQueue = [...tracks].sort(() => Math.random() - 0.5);
    const cur = AppState.currentTrackId;
    if (cur) {
      const i = shuffleQueue.findIndex(t => t.id === cur);
      if (i > 0) [shuffleQueue[0], shuffleQueue[i]] = [shuffleQueue[i], shuffleQueue[0]];
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
    return shuffleQueue[0]?.id || null;
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
    // MediaSession position state update
    if ('mediaSession' in navigator && isFinite(audio.duration) && audio.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration:     audio.duration,
          playbackRate: audio.playbackRate,
          position:     audio.currentTime,
        });
      } catch {}
    }
  }, 250));

  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('error', e => {
    console.error('Audio error', e);
    AppState.setPlaying(false);
    _setMsPlaybackState('none');
    Toast.error('再生エラーが発生しました');
  });
  audio.addEventListener('loadedmetadata', () => {
    AppState.setProgress(0, isFinite(audio.duration) ? audio.duration : 0);
  });
  // 一時停止が外部から発生した場合（ヘッドフォン抜き等）
  audio.addEventListener('pause', () => {
    if (AppState.isPlaying) {
      AppState.setPlaying(false);
      _setMsPlaybackState('paused');
    }
  });
  audio.addEventListener('play', () => {
    if (!AppState.isPlaying) AppState.setPlaying(true);
  });

  return {
    play, pause, togglePlay, next, prev, seek,
    setVolume, setSpeed, setShuffle, setRepeat,
    buildShuffleQueue: (tracks) => _buildQueue(tracks || AppState.getCurrentListTracks()),
    getCtx: () => ctx,
  };
})();
