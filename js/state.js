'use strict';

/* ============================================================
   EVENT BUS  —  pub/sub
   ============================================================ */
const EventBus = (() => {
  const listeners = {};
  return {
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return () => this.off(event, cb);
    },
    off(event, cb) {
      if (listeners[event]) listeners[event] = listeners[event].filter(x => x !== cb);
    },
    emit(event, data) {
      (listeners[event] || []).forEach(cb => { try { cb(data); } catch(e) { console.error(e); } });
    },
    once(event, cb) {
      const unsub = this.on(event, data => { unsub(); cb(data); });
    }
  };
})();

/* ============================================================
   APP STATE
   ============================================================ */
const AppState = {
  /* ---- Navigation ---- */
  currentScreen: 'player',   // player | editor | log | settings

  /* ---- Playback ---- */
  currentTrackId:    null,
  currentPlaylistId: 'all',
  isPlaying:         false,
  shuffle:           false,
  repeat:            'none',   // none | one | all
  playbackRate:      1.0,
  volume:            1.0,
  normalizeVolume:   false,
  currentTime:       0,
  duration:          0,

  /* ---- Player screen ---- */
  playerSortBy:    'manual',
  playerSortOrder: 'asc',
  playerSearch:    '',
  isMultiSelect:   false,
  selectedIds:     new Set(),

  /* ---- Editor screen ---- */
  editorSection:    'tracks',  // tracks | tags | artists
  editorSortBy:     'added',
  editorSortOrder:  'asc',
  editorSearch:     '',
  editorColumns:    4,

  /* ---- Log screen ---- */
  logPeriod: 'week',           // today | week | month | year | all

  /* ---- Data (loaded from IndexedDB) ---- */
  tracks:    [],   // Track[]
  playlists: [],   // Playlist[]
  tags:      [],   // Tag[]
  artists:   [],   // Artist[]

  /* ---- Getters ---- */
  getPlaylist(id) { return this.playlists.find(p => p.id === id) || null; },
  getAllPlaylist() { return this.playlists.find(p => p.isDefault) || null; },
  getTrack(id)    { return this.tracks.find(t => t.id === id) || null; },

  /** 現在の再生リストの曲 (ソート・検索適用後) */
  getCurrentListTracks() {
    const pl = this.getPlaylist(this.currentPlaylistId);
    let tracks;
    if (!pl) return [];
    if (pl.isDefault) {
      tracks = [...this.tracks];
    } else {
      tracks = pl.trackIds
        .map(id => this.tracks.find(t => t.id === id))
        .filter(Boolean);
    }

    // Search filter
    const q = this.playerSearch.trim().toLowerCase();
    if (q) {
      tracks = tracks.filter(t => {
        const title    = (t.title || '').toLowerCase();
        const artists  = t.artistIds.map(id => getArtist(id)?.name || '').join(' ').toLowerCase();
        const tags     = t.tagIds.map(id => getTag(id)?.name || '').join(' ').toLowerCase();
        const release  = (t.releaseDate || '').toLowerCase();
        return title.includes(q) || artists.includes(q) || tags.includes(q) || release.includes(q);
      });
    }

    // Sort
    if (this.playerSortBy !== 'manual' || !pl.isDefault) {
      tracks = sortTracks(tracks, this.playerSortBy, this.playerSortOrder);
    } else {
      // manual: use manualOrder within playlist
      const orderMap = {};
      pl.trackIds.forEach((id, i) => { orderMap[id] = i; });
      tracks.sort((a, b) => {
        const oa = orderMap[a.id] ?? 9999;
        const ob = orderMap[b.id] ?? 9999;
        return this.playerSortOrder === 'asc' ? oa - ob : ob - oa;
      });
    }
    return tracks;
  },

  /** エディタ用フィルター済み曲一覧 */
  getEditorTracks() {
    let tracks = [...this.tracks];
    const q = this.editorSearch.trim().toLowerCase();
    if (q) {
      tracks = tracks.filter(t => {
        const title   = (t.title || '').toLowerCase();
        const artists = t.artistIds.map(id => getArtist(id)?.name || '').join(' ').toLowerCase();
        const tags    = t.tagIds.map(id => getTag(id)?.name || '').join(' ').toLowerCase();
        const release = (t.releaseDate || '').toLowerCase();
        return title.includes(q) || artists.includes(q) || tags.includes(q) || release.includes(q);
      });
    }
    return sortTracks(tracks, this.editorSortBy, this.editorSortOrder);
  },

  /* ---- setters that emit events ---- */
  setScreen(s) {
    this.currentScreen = s;
    EventBus.emit('screen:change', s);
  },
  setPlaying(v) {
    this.isPlaying = v;
    EventBus.emit('playback:update', { isPlaying: v });
  },
  setCurrentTrack(id) {
    this.currentTrackId = id;
    EventBus.emit('track:change', id);
  },
  setCurrentPlaylist(id) {
    this.currentPlaylistId = id;
    EventBus.emit('playlist:select', id);
  },
  setShuffle(v) {
    this.shuffle = v;
    EventBus.emit('playback:update', { shuffle: v });
  },
  setRepeat(v) {
    this.repeat = v;
    EventBus.emit('playback:update', { repeat: v });
  },
  setSpeed(v) {
    this.playbackRate = v;
    EventBus.emit('playback:update', { playbackRate: v });
  },
  setVolume(v) {
    this.volume = v;
    EventBus.emit('playback:update', { volume: v });
  },
  setProgress(cur, dur) {
    this.currentTime = cur;
    this.duration    = dur;
    EventBus.emit('playback:progress', { currentTime: cur, duration: dur });
  },
  setMultiSelect(v) {
    this.isMultiSelect = v;
    if (!v) this.selectedIds.clear();
    EventBus.emit('select:change', v);
  },
  toggleSelect(id) {
    this.selectedIds.has(id) ? this.selectedIds.delete(id) : this.selectedIds.add(id);
    EventBus.emit('select:update', this.selectedIds.size);
  },
  selectAll(ids) {
    ids.forEach(id => this.selectedIds.add(id));
    EventBus.emit('select:update', this.selectedIds.size);
  },
  clearSelection() {
    this.selectedIds.clear();
    EventBus.emit('select:update', 0);
  },

  /* ---- Data mutations ---- */
  addTrack(track) {
    this.tracks.push(track);
    const all = this.getAllPlaylist();
    if (all) all.trackIds.push(track.id);
    EventBus.emit('data:tracks');
  },
  updateTrack(updated) {
    const i = this.tracks.findIndex(t => t.id === updated.id);
    if (i !== -1) this.tracks[i] = { ...this.tracks[i], ...updated };
    EventBus.emit('data:tracks');
  },
  removeTrack(id) {
    this.tracks = this.tracks.filter(t => t.id !== id);
    this.playlists.forEach(pl => {
      pl.trackIds = pl.trackIds.filter(tid => tid !== id);
    });
    if (this.currentTrackId === id) { this.setCurrentTrack(null); }
    this.selectedIds.delete(id);
    EventBus.emit('data:tracks');
  },
  addPlaylist(pl) {
    this.playlists.push(pl);
    EventBus.emit('data:playlists');
  },
  updatePlaylist(updated) {
    const i = this.playlists.findIndex(p => p.id === updated.id);
    if (i !== -1) this.playlists[i] = { ...this.playlists[i], ...updated };
    EventBus.emit('data:playlists');
  },
  removePlaylist(id) {
    this.playlists = this.playlists.filter(p => p.id !== id);
    if (this.currentPlaylistId === id) this.setCurrentPlaylist('all');
    EventBus.emit('data:playlists');
  },
  addTag(tag) {
    this.tags.push(tag);
    EventBus.emit('data:tags');
  },
  updateTag(updated) {
    const i = this.tags.findIndex(t => t.id === updated.id);
    if (i !== -1) this.tags[i] = { ...this.tags[i], ...updated };
    EventBus.emit('data:tags');
  },
  removeTag(id) {
    this.tags = this.tags.filter(t => t.id !== id);
    this.tracks.forEach(t => { t.tagIds = t.tagIds.filter(tid => tid !== id); });
    EventBus.emit('data:tags');
    EventBus.emit('data:tracks');
  },
  addArtist(artist) {
    this.artists.push(artist);
    EventBus.emit('data:artists');
  },
  updateArtist(updated) {
    const i = this.artists.findIndex(a => a.id === updated.id);
    if (i !== -1) this.artists[i] = { ...this.artists[i], ...updated };
    EventBus.emit('data:artists');
  },
  removeArtist(id) {
    this.artists = this.artists.filter(a => a.id !== id);
    this.tracks.forEach(t => { t.artistIds = t.artistIds.filter(aid => aid !== id); });
    EventBus.emit('data:artists');
    EventBus.emit('data:tracks');
  },

  /** 曲の手動順を更新（再生リスト内のインデックスで） */
  reorderPlaylistTracks(playlistId, newTrackIds) {
    const pl = this.getPlaylist(playlistId);
    if (pl) {
      pl.trackIds = newTrackIds;
      EventBus.emit('data:playlists');
    }
  }
};
