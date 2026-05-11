/**
 * storage.js — IndexedDB wrapper + multi-format audio metadata for Sonora
 *
 * Supported thumbnail extraction:
 *   MP3  — ID3v2.3 / ID3v2.4  (APIC frame)
 *   M4A  — iTunes MP4 atoms   (moov › udta › meta › ilst › covr)
 *   FLAC — PICTURE metadata block (type 6)
 *   OGG  — Vorbis METADATA_BLOCK_PICTURE comment
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES     = ['tracks','blobs','playlists','tags','logs','meta'];
  let _db = null;

  /* ═══════════════════════════════════════════════════════════
     INDEXEDDB
  ══════════════════════════════════════════════════════════ */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const ts = db.createObjectStore('tracks', { keyPath:'id' });
          ts.createIndex('by_artist',  'artist',      { unique:false });
          ts.createIndex('by_title',   'title',       { unique:false });
          ts.createIndex('by_added',   'dateAdded',   { unique:false });
          ts.createIndex('by_release', 'releaseDate', { unique:false });
          ts.createIndex('by_order',   'manualOrder', { unique:false });
        }
        if (!db.objectStoreNames.contains('blobs'))
          db.createObjectStore('blobs', { keyPath:'key' });
        if (!db.objectStoreNames.contains('playlists')) {
          const ps = db.createObjectStore('playlists', { keyPath:'id' });
          ps.createIndex('by_created','createdAt',{ unique:false });
        }
        if (!db.objectStoreNames.contains('tags')) {
          const tgs = db.createObjectStore('tags', { keyPath:'id' });
          tgs.createIndex('by_order','order',{ unique:false });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath:'id' });
          ls.createIndex('by_track',   'trackId',  { unique:false });
          ls.createIndex('by_playedAt','playedAt', { unique:false });
        }
        if (!db.objectStoreNames.contains('meta'))
          db.createObjectStore('meta', { keyPath:'key' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  function tx(s, mode='readonly') { return _db.transaction(s, mode).objectStore(s); }
  function req2p(r) {
    return new Promise((res,rej) => {
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e.target.error);
    });
  }
  function getAll(s, idx, q) {
    const store = tx(s);
    return req2p((idx ? store.index(idx) : store).getAll(q));
  }
  const getOne     = (s,k)   => req2p(tx(s).get(k));
  const put        = (s,obj) => req2p(tx(s,'readwrite').put(obj));
  const del        = (s,k)   => req2p(tx(s,'readwrite').delete(k));
  const clearStore = s       => req2p(tx(s,'readwrite').clear());
  const uid        = ()      => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  /* ═══════════════════════════════════════════════════════════
     TRACKS
  ══════════════════════════════════════════════════════════ */
  const getTracks = () => getAll('tracks');
  const getTrack  = id => getOne('tracks', id);

  async function addTrack(data) {
    const existing = await getTracks();
    const maxOrder = existing.reduce((m,t) => Math.max(m, t.manualOrder||0), 0);
    const track = {
      id:           data.id           || uid(),
      title:        data.title        || '不明なタイトル',
      artist:       data.artist       || '不明なアーティスト',
      dateAdded:    data.dateAdded    || Date.now(),
      releaseDate:  data.releaseDate  || null,
      tags:         data.tags         || [],
      manualOrder:  data.manualOrder  || (maxOrder + 1),
      driveFileId:  data.driveFileId  || null,
      driveThumbId: data.driveThumbId || null,
      blobKey:      data.blobKey      || null,
      thumbKey:     data.thumbKey     || null,
      duration:     data.duration     || 0,
    };
    await put('tracks', track);
    return track;
  }

  async function updateTrack(id, changes) {
    const track = await getTrack(id);
    if (!track) throw new Error('Track not found: ' + id);
    const updated = { ...track, ...changes };
    await put('tracks', updated);
    return updated;
  }

  async function deleteTrack(id) {
    const track = await getTrack(id);
    if (!track) return;
    const pls = await getPlaylists();
    // PERF FIX: update all affected playlists in parallel instead of sequentially
    await Promise.all(
      pls
        .filter(pl => pl.trackIds.includes(id))
        .map(pl => updatePlaylist(pl.id, { trackIds: pl.trackIds.filter(t => t !== id) }))
    );
    if (track.blobKey)  await del('blobs', track.blobKey);
    if (track.thumbKey) await del('blobs', track.thumbKey);
    const logs = await getAll('logs','by_track', id);
    // PERF FIX: delete all logs for this track in parallel
    await Promise.all(logs.map(l => del('logs', l.id)));
    await del('tracks', id);
  }

  function reorderTracks(orderedIds) {
    // Issue all gets inside one transaction, resolve only on oncomplete
    // (avoids the resolve-before-commit race condition of the sequential approach)
    return new Promise((resolve, reject) => {
      const t     = _db.transaction('tracks', 'readwrite');
      const store = t.objectStore('tracks');

      t.oncomplete = () => resolve();
      t.onerror    = e  => reject(e.target.error);
      t.onabort    = e  => reject(new Error('reorderTracks aborted'));

      orderedIds.forEach((id, idx) => {
        const r = store.get(id);
        r.onsuccess = e => {
          const track = e.target.result;
          if (track) { track.manualOrder = idx + 1; store.put(track); }
        };
        r.onerror = () => t.abort();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BLOBS
  ══════════════════════════════════════════════════════════ */
  async function saveBlob(data) {
    const key = 'blob_' + uid();
    await put('blobs', { key, data });
    return key;
  }
  async function getBlob(key) {
    if (!key) return null;
    const rec = await getOne('blobs', key);
    return rec ? rec.data : null;
  }
  const deleteBlob = key => key ? del('blobs', key) : Promise.resolve();
  async function getBlobUrl(key) {
    const data = await getBlob(key);
    return data ? URL.createObjectURL(new Blob([data])) : null;
  }
  async function getAudioBlobUrl(trackId) {
    const t = await getTrack(trackId);
    if (!t?.blobKey) return null;
    const data = await getBlob(t.blobKey);
    if (!data) return null;
    // Detect audio MIME type from magic bytes so browsers can decode correctly.
    // Without a MIME hint some browsers (especially on mobile) refuse to play.
    const b = new Uint8Array(data, 0, Math.min(12, data.byteLength));
    let mime = 'audio/mpeg'; // default — covers MP3 and most unknowns
    if (b[0]===0x66 && b[1]===0x4C && b[2]===0x61 && b[3]===0x43) {
      mime = 'audio/flac';
    } else if (b[0]===0x4F && b[1]===0x67 && b[2]===0x67 && b[3]===0x53) {
      mime = 'audio/ogg';
    } else if (b.length >= 8 &&
               b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70) {
      mime = 'audio/mp4'; // M4A / AAC / MP4
    }
    return URL.createObjectURL(new Blob([data], { type: mime }));
  }

  /* ═══════════════════════════════════════════════════════════
     PLAYLISTS
  ══════════════════════════════════════════════════════════ */
  const getPlaylists  = ()  => getAll('playlists');
  const getPlaylist   = id  => getOne('playlists', id);
  async function createPlaylist(name, desc='') {
    const pl = { id:uid(), name:name.trim()||'新しいプレイリスト', desc, trackIds:[], createdAt:Date.now() };
    await put('playlists', pl); return pl;
  }
  async function updatePlaylist(id, changes) {
    const pl = await getPlaylist(id);
    if (!pl) throw new Error('Playlist not found: ' + id);
    const updated = { ...pl, ...changes };
    await put('playlists', updated); return updated;
  }
  const deletePlaylist = id => del('playlists', id);
  async function addTrackToPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl || pl.trackIds.includes(tid)) return;
    await updatePlaylist(pid, { trackIds:[...pl.trackIds, tid] });
  }
  async function removeTrackFromPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl) return;
    await updatePlaylist(pid, { trackIds: pl.trackIds.filter(id => id !== tid) });
  }

  /* ═══════════════════════════════════════════════════════════
     TAGS
  ══════════════════════════════════════════════════════════ */
  async function getTags() {
    const tags = await getAll('tags','by_order');
    return tags.sort((a,b) => (a.order||0)-(b.order||0));
  }
  const getTag = id => getOne('tags', id);
  async function createTag(name, color='#DBEAFE', textColor='#1D4ED8') {
    const existing = await getTags();
    const tag = { id:uid(), name:name.trim(), color, textColor, order:existing.length };
    await put('tags', tag); return tag;
  }
  async function updateTag(id, changes) {
    const tag = await getTag(id);
    if (!tag) throw new Error('Tag not found: ' + id);
    const updated = { ...tag, ...changes };
    await put('tags', updated); return updated;
  }

  // PERF FIX: Run track updates in parallel instead of sequential awaits.
  async function deleteTag(id) {
    const tracks = await getTracks();
    const updates = tracks
      .filter(t => (t.tags||[]).includes(id))
      .map(t => updateTrack(t.id, { tags: t.tags.filter(g => g !== id) }));
    await Promise.all(updates);
    await del('tags', id);
  }

  // PERF FIX: Use a single transaction instead of sequential get+put per tag.
  function reorderTags(orderedIds) {
    return new Promise((resolve, reject) => {
      const t     = _db.transaction('tags', 'readwrite');
      const store = t.objectStore('tags');

      t.oncomplete = () => resolve();
      t.onerror    = e  => reject(e.target.error);
      t.onabort    = ()  => reject(new Error('reorderTags aborted'));

      orderedIds.forEach((id, i) => {
        const r = store.get(id);
        r.onsuccess = e => {
          const tag = e.target.result;
          if (tag) store.put({ ...tag, order: i });
        };
        r.onerror = () => t.abort();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     LOGS
  ══════════════════════════════════════════════════════════ */
  const getLogs = () => getAll('logs');
  async function addLog(trackId, dur=0) {
    const log = { id:uid(), trackId, playedAt:Date.now(), duration:dur };
    await put('logs', log);
    console.log('[Storage] Log added:', trackId, dur + 's');
    return log;
  }

  /* ═══════════════════════════════════════════════════════════
     META
  ══════════════════════════════════════════════════════════ */
  async function getMeta(key, fallback=null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }
  const setMeta    = (k,v) => put('meta', { key:k, value:v });
  const deleteMeta = k     => del('meta', k);

  /* ═══════════════════════════════════════════════════════════
     SNAPSHOT
  ══════════════════════════════════════════════════════════ */
  async function exportSnapshot() {
    const [tracks, playlists, tags, logs] = await Promise.all([
      getTracks(), getPlaylists(), getTags(), getLogs()
    ]);
    return {
      version:    1,
      exportedAt: Date.now(),
      tracks:     tracks.map(({ blobKey, thumbKey, ...rest }) => rest),
      playlists, tags, logs,
    };
  }
  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) return;

    // PERF FIX: Load all existing records up front in parallel,
    // then dispatch all writes in parallel — avoids sequential get+put per item.
    const [existingTracks, existingPlaylists, existingTags, existingLogs] = await Promise.all([
      getTracks(), getPlaylists(), getTags(), getLogs(),
    ]);

    const existingTrackIds    = new Set(existingTracks.map(t => t.id));
    const existingPlaylistMap = new Map(existingPlaylists.map(p => [p.id, p]));
    const existingTagIds      = new Set(existingTags.map(t => t.id));
    const existingLogIds      = new Set(existingLogs.map(l => l.id));

    await Promise.all([
      // Tracks: only insert truly new ones (skip existing to preserve local blobKey/thumbKey)
      ...((snapshot.tracks || [])
        .filter(t => !existingTrackIds.has(t.id))
        .map(t => put('tracks', { ...t, blobKey: null, thumbKey: null }))),

      // Playlists: insert new, merge trackIds for existing
      ...((snapshot.playlists || []).map(pl => {
        const ex = existingPlaylistMap.get(pl.id);
        if (!ex) return put('playlists', pl);
        return put('playlists', { ...ex, trackIds: [...new Set([...ex.trackIds, ...pl.trackIds])] });
      })),

      // Tags: only insert new ones
      ...((snapshot.tags || [])
        .filter(t => !existingTagIds.has(t.id))
        .map(t => put('tags', t))),

      // Logs: only insert new ones
      ...((snapshot.logs || [])
        .filter(l => !existingLogIds.has(l.id))
        .map(l => put('logs', l))),
    ]);
  }
  // PERF FIX: Clear all stores in parallel instead of sequentially.
  async function resetAll() {
    await Promise.all(STORES.map(s => clearStore(s)));
  }

  /* ═══════════════════════════════════════════════════════════
     LOW-LEVEL BINARY HELPERS
  ══════════════════════════════════════════════════════════ */
  /** Read 4-byte big-endian uint */
  function _u32be(b, o) {
    return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) >>> 0;
  }
  /** Read 4-byte little-endian uint */
  function _u32le(b, o) {
    return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24)) >>> 0;
  }
  /**
   * Detect image MIME from magic bytes.
   * BUG FIX: WebP detection previously checked b[o+4] ('W') while skipping
   * b[o+3] ('F' of 'RIFF'), which could misidentify any RIFF file as WebP.
   * Now correctly checks 'RIFF' at [0-3] and 'WEBP' at [8-11].
   */
  function _imgMime(b, o=0) {
    if (b[o]===0xFF && b[o+1]===0xD8) return 'image/jpeg';
    if (b[o]===0x89 && b[o+1]===0x50 && b[o+2]===0x4E && b[o+3]===0x47) return 'image/png';
    if (b[o]===0x47 && b[o+1]===0x49 && b[o+2]===0x46) return 'image/gif';
    if (b[o]===0x42 && b[o+1]===0x4D) return 'image/bmp';
    // RIFF....WEBP
    if (b[o]===0x52 && b[o+1]===0x49 && b[o+2]===0x46 && b[o+3]===0x46 &&
        b.length > o + 11 &&
        b[o+8]===0x57 && b[o+9]===0x45 && b[o+10]===0x42 && b[o+11]===0x50)
      return 'image/webp';
    return 'image/jpeg';
  }

  /* ═══════════════════════════════════════════════════════════
     METADATA RESULT TEMPLATE
  ══════════════════════════════════════════════════════════ */
  function _blankMeta(filename) {
    const base = (filename||'').replace(/\.[^.]+$/, '');
    const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
    return {
      title:       dash ? dash[2].trim() : base,
      artist:      dash ? dash[1].trim() : '',
      releaseDate: null,
      thumbData:   null,
      thumbMime:   null,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     ID3v2 PARSER  (MP3)
     Handles v2.3 and v2.4.
     Frames: TIT2, TPE1, TDRC, TYER, APIC
  ══════════════════════════════════════════════════════════ */
  function _parseID3(bytes, result) {
    if (bytes.length < 10) return false;
    // Magic: 'ID3'
    if (!(bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33)) return false;
    const major = bytes[3];
    if (major < 2 || major > 4) return false;

    // Flags (byte 5): bit 6 = extended header present
    const extHeader = (bytes[5] & 0x40) !== 0;

    // Syncsafe tag size (bytes 6-9)
    const tagSize = ((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|
                    ((bytes[8]&0x7F)<<7) | (bytes[9]&0x7F);
    let off = 10;

    // Skip extended header if present
    if (extHeader && major === 4) {
      const extSize = ((bytes[off]&0x7F)<<21)|((bytes[off+1]&0x7F)<<14)|
                      ((bytes[off+2]&0x7F)<<7) | (bytes[off+3]&0x7F);
      off += extSize;
    } else if (extHeader && major === 3) {
      const extSize = _u32be(bytes, off);
      off += 4 + extSize;
    }

    const end = Math.min(10 + tagSize, bytes.length);

    while (off + (major === 2 ? 6 : 10) < end) {
      let fid, fsz;

      if (major === 2) {
        // ID3v2.2: 3-char frame IDs, 3-byte size
        fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2]);
        fsz = (bytes[off+3]<<16)|(bytes[off+4]<<8)|bytes[off+5];
        off += 6;
      } else {
        // ID3v2.3 / v2.4: 4-char frame IDs, 4-byte size
        fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
        fsz = (major === 4)
          ? ((bytes[off+4]&0x7F)<<21)|((bytes[off+5]&0x7F)<<14)|
            ((bytes[off+6]&0x7F)<<7) | (bytes[off+7]&0x7F)  // syncsafe in v2.4
          : _u32be(bytes, off+4);                              // plain in v2.3
        off += 10;
      }

      if (fid === '\0\0\0\0' || fid === '\0\0\0') break; // padding
      if (fsz <= 0 || off + fsz > end) break;

      const fd = bytes.subarray(off, off + fsz);

      // Map v2.2 frame IDs to v2.3+ equivalents.
      // NOTE: PIC is intentionally NOT mapped to APIC — v2.2 PIC has a different
      // binary layout (3-char format code instead of null-terminated MIME string),
      // so it must be handled by its own dedicated case 'PIC' branch below.
      const id = major === 2
        ? ({ TT2:'TIT2', TP1:'TPE1', TYE:'TYER' }[fid] || fid)
        : fid;

      switch (id) {
        case 'TIT2': { const v=_id3Text(fd); if(v) result.title   = v; break; }
        case 'TPE1': { const v=_id3Text(fd); if(v) result.artist  = v; break; }
        case 'TALB': break; // album – ignored
        case 'TDRC':
        case 'TYER': {
          const v = _id3Text(fd);
          if (v && /^\d{4}/.test(v)) result.releaseDate = v.slice(0,4)+'-01-01';
          break;
        }
        case 'APIC': {
          if (!result.thumbData) {
            const pic = _id3APIC(fd);
            if (pic) { result.thumbData = pic.data; result.thumbMime = pic.mime; }
          }
          break;
        }
        // ID3v2.2 picture frame: enc(1) + format(3:'JPG'/'PNG') + picType(1) + desc + data
        case 'PIC': {
          if (!result.thumbData && fd.length > 5) {
            const picEnc = fd[0];
            let p = 1;
            const fmt = String.fromCharCode(fd[p], fd[p+1], fd[p+2]); p += 3;
            p++; // skip picType
            // Skip description — respect encoding for null terminator
            if (picEnc === 1 || picEnc === 2) {
              // UTF-16: scan for double-null \x00\x00
              while (p + 1 < fd.length && !(fd[p] === 0 && fd[p+1] === 0)) p += 2;
              p += 2; // consume double null
            } else {
              // Latin-1 / UTF-8: single-null terminated
              while (p < fd.length && fd[p] !== 0) p++;
              if (p < fd.length) p++;
            }
            if (p < fd.length) {
              const imgData = fd.slice(p); // .slice() gives own buffer (not shared)
              result.thumbData = imgData.buffer;
              result.thumbMime = _imgMime(imgData);
            }
          }
          break;
        }
      }
      off += fsz;
    }
    return true;
  }

  function _id3Text(data) {
    if (!data || data.length === 0) return '';
    const enc = data[0];
    const raw = data.subarray(1);
    try {
      let s;
      if (enc === 1 || enc === 2) s = new TextDecoder('utf-16').decode(raw);
      else if (enc === 3)          s = new TextDecoder('utf-8').decode(raw);
      else                         s = new TextDecoder('latin1').decode(raw);
      return s.replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  function _id3APIC(data) {
    if (!data || data.length < 6) return null;
    const enc = data[0];
    let pos = 1;

    // MIME string (null-terminated ASCII) — computed only to advance pos
    const mimeStart = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    // (mimeStr is not used: realMime below is detected from magic bytes)
    if (pos >= data.length) return null;
    pos++; // consume null

    pos++; // picture type byte

    // Description (null-terminated; UTF-16 uses double-null)
    if (enc === 1 || enc === 2) {
      // word-aligned scan for \0\0
      if (pos % 2 !== 0) pos++; // align to 2-byte boundary if needed
      while (pos + 1 < data.length) {
        if (data[pos] === 0 && data[pos+1] === 0) { pos += 2; break; }
        pos += 2;
      }
    } else {
      while (pos < data.length && data[pos] !== 0) pos++;
      if (pos < data.length) pos++;
    }

    if (pos >= data.length) return null;

    const imgData = data.slice(pos); // Uint8Array copy
    if (imgData.length < 4) return null;

    // Determine real MIME from magic bytes (ignore declared MIME if wrong)
    const realMime = _imgMime(imgData);
    return { data: imgData.buffer, mime: realMime };
  }

  /* ═══════════════════════════════════════════════════════════
     M4A / MP4 ATOM PARSER  (iTunes metadata)
     Navigates: ftyp → moov → udta → meta → ilst → covr → data
     Also reads: ©nam (title), ©ART (artist), ©day (date)
  ══════════════════════════════════════════════════════════ */
  function _parseM4A(bytes, result) {
    // Verify it's an MP4 container: bytes 4-7 should be 'ftyp' or 'moov'
    if (bytes.length < 8) return false;
    const firstAtom = String.fromCharCode(bytes[4],bytes[5],bytes[6],bytes[7]);
    if (firstAtom !== 'ftyp' && firstAtom !== 'moov' && firstAtom !== 'free') return false;

    // Walk top-level atoms looking for moov
    const moov = _findAtom(bytes, 0, bytes.length, 'moov');
    if (!moov) return false;

    // moov > udta > meta > ilst
    const udta = _findAtom(bytes, moov.data, moov.end, 'udta');
    if (!udta) return _tryM4AAlternate(bytes, moov, result);

    const meta = _findAtom(bytes, udta.data, udta.end, 'meta');
    if (!meta) return false;

    // meta has a 4-byte version/flags field before its children
    const ilstOff = meta.data + 4;
    const ilst = _findAtom(bytes, ilstOff, meta.end, 'ilst');
    if (!ilst) return false;

    // Walk ilst children
    let off = ilst.data;
    while (off + 8 < ilst.end) {
      const aSize = _u32be(bytes, off);
      if (aSize < 8 || off + aSize > ilst.end) break;
      const aType = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);

      // Each child has a 'data' sub-atom
      const dataAtom = _findAtom(bytes, off+8, off+aSize, 'data');
      if (dataAtom && dataAtom.end - dataAtom.data > 8) {
        // data atom: 4-byte type indicator + 4-byte locale + payload
        const payload = bytes.subarray(dataAtom.data + 8, dataAtom.end);

        if (aType === 'covr') {
          if (!result.thumbData && payload.length > 4) {
            result.thumbData = payload.slice(0).buffer;
            result.thumbMime = _imgMime(payload);
          }
        } else {
          // Text atoms: ©nam, ©ART, ©day, etc.
          try {
            const text = new TextDecoder('utf-8').decode(payload).trim();
            if (aType === '\xa9nam' && text) result.title       = text;
            if (aType === '\xa9ART' && text) result.artist      = text;
            if (aType === '\xa9day' && text && /^\d{4}/.test(text))
              result.releaseDate = text.slice(0,4) + '-01-01';
          } catch {}
        }
      }
      off += aSize;
    }
    return true;
  }

  function _tryM4AAlternate(bytes, moov, result) {
    // Some encoders use moov > trak > udta (non-standard)
    // Fall back: just scan ilst directly inside moov
    const ilst = _findAtomDeep(bytes, moov.data, moov.end, ['ilst']);
    if (!ilst) return false;
    let off = ilst.data;
    while (off + 8 < ilst.end) {
      const aSize = _u32be(bytes, off);
      if (aSize < 8 || off + aSize > ilst.end) break;
      const dataAtom = _findAtom(bytes, off+8, off+aSize, 'data');
      if (dataAtom && dataAtom.end - dataAtom.data > 8) {
        const aType = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);
        const payload = bytes.subarray(dataAtom.data + 8, dataAtom.end);
        if (aType === 'covr' && !result.thumbData && payload.length > 4) {
          result.thumbData = payload.slice(0).buffer;
          result.thumbMime = _imgMime(payload);
        }
      }
      off += aSize;
    }
    return !!result.thumbData;
  }

  /**
   * Find a single named atom (box) at the given level.
   * Returns { start, end, data } where data is the start of the atom's payload.
   */
  function _findAtom(bytes, start, end, name) {
    let off = start;
    while (off + 8 <= end) {
      let size = _u32be(bytes, off);
      if (size === 1) {
        // 64-bit extended size (8 bytes after type)
        // We don't handle >4GB atoms, but skip gracefully
        if (off + 16 > end) break;
        size = Number(
          (BigInt(bytes[off+8])<<56n)|(BigInt(bytes[off+9])<<48n)|
          (BigInt(bytes[off+10])<<40n)|(BigInt(bytes[off+11])<<32n)|
          (BigInt(bytes[off+12])<<24n)|(BigInt(bytes[off+13])<<16n)|
          (BigInt(bytes[off+14])<<8n)|BigInt(bytes[off+15])
        );
      } else if (size === 0) {
        size = end - off; // atom extends to EOF
      }
      if (size < 8) break;
      const type = String.fromCharCode(bytes[off+4],bytes[off+5],bytes[off+6],bytes[off+7]);
      if (type === name) return { start:off, end:off+size, data:off+8 };
      off += size;
    }
    return null;
  }

  /** Find atom at any depth following a path array */
  function _findAtomDeep(bytes, start, end, path) {
    let cur = { start, end, data:start };
    for (const name of path) {
      const next = _findAtom(bytes, cur.data, cur.end, name);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /* ═══════════════════════════════════════════════════════════
     FLAC PARSER
     Reads metadata blocks before audio data.
     Block type 4 = VORBIS_COMMENT (title/artist/date)
     Block type 6 = PICTURE
  ══════════════════════════════════════════════════════════ */
  function _parseFLAC(bytes, result) {
    // Magic: 'fLaC'
    if (!(bytes[0]===0x66 && bytes[1]===0x4C && bytes[2]===0x61 && bytes[3]===0x43)) return false;

    let off = 4;
    let isLast = false;

    while (!isLast && off + 4 <= bytes.length) {
      const header = bytes[off];
      isLast       = (header & 0x80) !== 0;
      const bType  = header & 0x7F;
      const bLen   = (bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3];
      off += 4;

      if (off + bLen > bytes.length) break;

      if (bType === 6) {
        // PICTURE block
        const pic = _parseFLACPicture(bytes, off, bLen);
        if (pic && !result.thumbData) {
          result.thumbData = pic.data;
          result.thumbMime = pic.mime;
        }
      } else if (bType === 4) {
        // VORBIS_COMMENT block (little-endian length-prefixed UTF-8)
        _parseVorbisComment(bytes, off, off + bLen, result);
      }
      // bType 0 = STREAMINFO, 1 = PADDING, 2 = APPLICATION, 3 = SEEKTABLE, 5 = CUESHEET

      off += bLen;
    }
    return true;
  }

  function _parseFLACPicture(bytes, start, len) {
    let off = start;
    const end = start + len;
    if (off + 8 > end) return null;

    // picType(4)
    off += 4;

    // MIME string: length(4) + string
    const mimeLen = _u32be(bytes, off); off += 4;
    if (off + mimeLen > end) return null;
    const mime = new TextDecoder('latin1').decode(bytes.subarray(off, off+mimeLen));
    off += mimeLen;

    // Description: length(4) + string
    if (off + 4 > end) return null;
    const descLen = _u32be(bytes, off); off += 4;
    off += descLen;

    // BUG FIX: guard against corrupted descLen putting off past end
    // before consuming the fixed 16-byte width/height/depth/color fields.
    if (off + 16 > end) return null;

    // Width(4) + Height(4) + ColorDepth(4) + ColorCount(4)
    off += 16;

    // Image data: length(4) + data
    if (off + 4 > end) return null;
    const dataLen = _u32be(bytes, off); off += 4;
    if (dataLen === 0 || off + dataLen > end) return null;

    const imgData = bytes.slice(off, off + dataLen);
    return { data: imgData.buffer, mime: mime || _imgMime(imgData) };
  }

  /* ═══════════════════════════════════════════════════════════
     OGG VORBIS PARSER
     Reads OGG pages and finds the Vorbis comment packet.
     Supports METADATA_BLOCK_PICTURE (base64-encoded FLAC PICTURE).
  ══════════════════════════════════════════════════════════ */
  function _parseOGG(bytes, result) {
    // OGG capture pattern: 'OggS' (0x4F 0x67 0x67 0x53)
    if (!(bytes[0]===0x4F && bytes[1]===0x67 && bytes[2]===0x67 && bytes[3]===0x53)) return false;

    // Collect raw packet data from OGG pages
    // We only need the first few pages (identification + comment headers)
    const packets = _oggCollectPackets(bytes, 4); // collect up to 4 pages

    for (const pkt of packets) {
      // Vorbis comment packet starts with: \x03vorbis
      if (pkt.length > 7 &&
          pkt[0]===0x03 && pkt[1]===0x76 && pkt[2]===0x6F &&
          pkt[3]===0x72 && pkt[4]===0x62 && pkt[5]===0x69 && pkt[6]===0x73) {
        _parseVorbisComment(pkt, 7, pkt.length, result);
        return true;
      }
      // Opus comment packet starts with: 'OpusTags'
      if (pkt.length > 8 &&
          pkt[0]===0x4F && pkt[1]===0x70 && pkt[2]===0x75 && pkt[3]===0x73 &&
          pkt[4]===0x54 && pkt[5]===0x61 && pkt[6]===0x67 && pkt[7]===0x73) {
        _parseVorbisComment(pkt, 8, pkt.length, result);
        return true;
      }
    }
    return false;
  }

  function _oggCollectPackets(bytes, maxPages) {
    const packets = [];
    let off = 0;
    let pages = 0;

    while (off + 27 <= bytes.length && pages < maxPages) {
      // OggS capture
      if (!(bytes[off]===0x4F && bytes[off+1]===0x67 && bytes[off+2]===0x67 && bytes[off+3]===0x53)) break;

      const numSegs    = bytes[off+26];
      if (off + 27 + numSegs > bytes.length) break;

      let pageDataLen = 0;
      for (let i = 0; i < numSegs; i++) pageDataLen += bytes[off + 27 + i];
      const dataStart = off + 27 + numSegs;
      if (dataStart + pageDataLen > bytes.length) break;

      // Collect segment data as a packet (simplified: treat page as one packet)
      packets.push(bytes.subarray(dataStart, dataStart + pageDataLen));
      off = dataStart + pageDataLen;
      pages++;
    }
    return packets;
  }

  /* Vorbis comment parser (shared between FLAC block-type-4 and OGG) */
  function _parseVorbisComment(bytes, start, end, result) {
    let off = start;
    if (off + 4 > end) return;

    // Vendor string length + string
    const vendorLen = _u32le(bytes, off); off += 4;
    off += vendorLen; // skip vendor string

    if (off + 4 > end) return;
    const count = _u32le(bytes, off); off += 4;

    for (let i = 0; i < count && off + 4 <= end; i++) {
      const len = _u32le(bytes, off); off += 4;
      if (off + len > end) break;
      const comment = new TextDecoder('utf-8').decode(bytes.subarray(off, off+len));
      off += len;

      const eq = comment.indexOf('=');
      if (eq < 0) continue;
      const key = comment.slice(0, eq).toUpperCase();
      const val = comment.slice(eq + 1).trim();

      if (key === 'TITLE'  && val && !result.title)  result.title  = val;
      if (key === 'ARTIST' && val && !result.artist) result.artist = val;
      if (key === 'DATE'   && val && /^\d{4}/.test(val) && !result.releaseDate)
        result.releaseDate = val.slice(0,4) + '-01-01';

      if ((key === 'METADATA_BLOCK_PICTURE' || key === 'COVERART') && !result.thumbData) {
        try {
          const b64 = val.replace(/[\r\n\s]/g,'');
          const bin = atob(b64);
          const buf = new Uint8Array(bin.length);
          for (let j=0; j<bin.length; j++) buf[j] = bin.charCodeAt(j);

          if (key === 'COVERART') {
            // Plain base64 image
            result.thumbData = buf.buffer;
            result.thumbMime = _imgMime(buf);
          } else {
            // METADATA_BLOCK_PICTURE: FLAC PICTURE block format
            const pic = _parseFLACPicture(buf, 0, buf.length);
            if (pic) { result.thumbData = pic.data; result.thumbMime = pic.mime; }
          }
        } catch {}
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════
     UNIFIED METADATA PARSER
     Detects format and dispatches to the right parser.
  ══════════════════════════════════════════════════════════ */
  /**
   * Parse audio metadata from an ArrayBuffer.
   * @param {ArrayBuffer} buffer
   * @param {string}      filename
   * @returns {{ title, artist, releaseDate, thumbData, thumbMime }}
   */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = _blankMeta(filename);
    if (!buffer || buffer.byteLength < 8) return result;

    const bytes = new Uint8Array(buffer);

    // Try each parser in order of magic-byte detection
    if (_parseID3(bytes, result))  return result; // MP3 (ID3v2)
    if (_parseFLAC(bytes, result)) return result; // FLAC
    if (_parseOGG(bytes, result))  return result; // OGG Vorbis / Opus
    if (_parseM4A(bytes, result))  return result; // M4A / MP4 / AAC

    return result; // Fallback: filename-derived title/artist only
  }

  /* ═══════════════════════════════════════════════════════════
     FILE META — reads from a File object
     Strategy:
       1. Peek first 10 bytes to detect format + find exact read size
       2. For ID3v2: read tagSize+10 bytes (exact, can be large for cover art)
       3. For FLAC:  read until first AUDIO block (all metadata comes first)
       4. For OGG:   read first ~1 MB (comment packet is near the start)
       5. For M4A:   read up to 8 MB (moov may be anywhere)
       6. Fallback:  read first 512 KB
  ══════════════════════════════════════════════════════════ */
  async function readAudioMeta(file) {
    let meta = _blankMeta(file.name);

    try {
      // Peek 12 bytes to decide read strategy
      const peek = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      let readSize = 512 * 1024; // default 512 KB

      if (peek[0]===0x49 && peek[1]===0x44 && peek[2]===0x33 && peek[3] >= 3) {
        // ID3v2: read exactly tagSize+10, capped at 30 MB
        const tagSize = ((peek[6]&0x7F)<<21)|((peek[7]&0x7F)<<14)|
                        ((peek[8]&0x7F)<<7) | (peek[9]&0x7F);
        readSize = Math.min(tagSize + 10, 30 * 1024 * 1024);

      } else if (peek[0]===0x66 && peek[1]===0x4C && peek[2]===0x61 && peek[3]===0x43) {
        // FLAC: read up to 10 MB (PICTURE block before audio data)
        readSize = Math.min(file.size, 10 * 1024 * 1024);

      } else if (peek[0]===0x4F && peek[1]===0x67 && peek[2]===0x67 && peek[3]===0x53) {
        // OGG: comment header is in the first few pages — 2 MB is plenty
        readSize = Math.min(file.size, 2 * 1024 * 1024);

      } else {
        // M4A / MP4 / AAC or unknown: try up to 8 MB
        // (moov atom may be near end for streaming-optimised files,
        //  but most encoders put it at the start)
        readSize = Math.min(file.size, 8 * 1024 * 1024);
      }

      const buf = await file.slice(0, readSize).arrayBuffer();
      meta = parseAudioMetaFromBuffer(buf, file.name);

      // If M4A with moov at end: try last 4 MB
      if (!meta.thumbData && readSize < file.size &&
          !(peek[0]===0x49) && !(peek[0]===0x66) && !(peek[0]===0x4F)) {
        const tailSize = Math.min(4 * 1024 * 1024, file.size);
        const tail = await file.slice(file.size - tailSize).arrayBuffer();
        const tailMeta = parseAudioMetaFromBuffer(tail, file.name);
        if (tailMeta.thumbData) {
          meta.thumbData = tailMeta.thumbData;
          meta.thumbMime = tailMeta.thumbMime;
        }
        // Merge text fields if still empty
        if (!meta.title  && tailMeta.title)  meta.title  = tailMeta.title;
        if (!meta.artist && tailMeta.artist) meta.artist = tailMeta.artist;
        if (!meta.releaseDate && tailMeta.releaseDate) meta.releaseDate = tailMeta.releaseDate;
      }

    } catch (e) {
      console.warn('[Storage] readAudioMeta error:', e);
    }

    // Duration via Audio element (doesn't need full file)
    const duration = await new Promise(resolve => {
      const a   = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.src = url; a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      setTimeout(()      => { try { URL.revokeObjectURL(url); } catch{} resolve(0); }, 6000);
    });

    return { ...meta, duration };
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════ */
  return {
    open, uid,
    getTracks, getTrack, addTrack, updateTrack, deleteTrack, reorderTracks,
    saveBlob, getBlob, deleteBlob, getBlobUrl, getAudioBlobUrl,
    getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist,
    getTags, getTag, createTag, updateTag, deleteTag, reorderTags,
    getLogs, addLog,
    getMeta, setMeta, deleteMeta,
    exportSnapshot, importSnapshot,
    resetAll,
    readAudioMeta,
    parseAudioMetaFromBuffer,
  };
})();
