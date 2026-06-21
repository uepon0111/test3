'use strict';

/* ============================================================
   METADATA  —  音声メタデータ抽出
   jsmediatags (ID3) + HTMLAudioElement (duration)
   ============================================================ */

const Metadata = (() => {

  /** jsmediatags で ID3 タグを読む (Promise) */
  function readID3(file) {
    return new Promise(resolve => {
      try {
        window.jsmediatags.read(file, {
          onSuccess(tag) { resolve(tag.tags || {}); },
          onError()      { resolve({}); }
        });
      } catch { resolve({}); }
    });
  }

  /** HTMLAudioElement で音声の長さを取得 (Promise) */
  function getDuration(file) {
    return new Promise(resolve => {
      const url   = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      const cleanup = () => { URL.revokeObjectURL(url); };
      audio.addEventListener('loadedmetadata', () => {
        const d = isFinite(audio.duration) ? audio.duration : 0;
        cleanup();
        resolve(d);
      });
      audio.addEventListener('error', () => { cleanup(); resolve(0); });
      audio.src = url;
    });
  }

  /** 音声のピークレベルを取得 (0.0〜1.0) */
  async function getPeakLevel(file) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor || !file?.arrayBuffer) return 0;
    let ctx = null;
    try {
      const arrayBuffer = await file.arrayBuffer();
      ctx = new Ctor();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      let peak = 0;
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i]);
          if (v > peak) peak = v;
          if (peak >= 1) return 1;
        }
      }
      return peak;
    } catch {
      return 0;
    } finally {
      try { await ctx?.close?.(); } catch {}
    }
  }

  /** ID3 picture → base64 data URL */
  function pictureToDataUrl(pic) {
    if (!pic || !pic.data) return null;
    try {
      const bytes = typeof pic.data === 'string'
        ? pic.data.split('').map(c => c.charCodeAt(0))
        : Array.from(pic.data);
      const b64   = btoa(bytes.reduce((a, b) => a + String.fromCharCode(b), ''));
      const mime  = pic.format || 'image/jpeg';
      return `data:${mime};base64,${b64}`;
    } catch { return null; }
  }

  /** ファイルからすべてのメタデータを抽出 */
  async function extract(file) {
    const [tags, duration, peakLevel] = await Promise.all([readID3(file), getDuration(file), getPeakLevel(file)]);

    const title    = tags.title || file.name.replace(/\.[^.]+$/, '') || '不明のタイトル';
    const artist   = tags.artist || null;   // null → 「不明のアーティスト」で作成
    const year     = tags.year   || null;
    const thumbnail = tags.picture ? pictureToDataUrl(tags.picture) : null;

    // 年から簡易日付を生成: "2021" → "2021-01-01"
    let releaseDate = null;
    if (year) {
      const y = String(year).trim();
      releaseDate = /^\d{4}$/.test(y) ? `${y}-01-01`
        : /^\d{4}-\d{2}-\d{2}$/.test(y) ? y
        : null;
    }

    return { title, artist, releaseDate, thumbnail, duration, peakLevel };
  }

  return { extract };
})();
