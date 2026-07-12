/*
 * utils.js
 * -----------------------------------------------------------------------
 * 複数のファイルで共通して使う小さなヘルパー関数群。
 * -----------------------------------------------------------------------
 */

function escapeHtml(t) {
  return t ? t.toString().replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])) : '';
}

function normalizeString(str) {
  if (!str) return "";
  return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).toLowerCase().replace(/[\s\-_]/g, '');
}

function levenshtein(s1, s2) {
  if (s1.length > s2.length) [s1, s2] = [s2, s1];
  let dist = Array.from({ length: s1.length + 1 }, (_, i) => i);
  for (let i2 = 0; i2 < s2.length; i2++) {
    let newDist = [i2 + 1];
    for (let i1 = 0; i1 < s1.length; i1++) {
      if (s1[i1] === s2[i2]) newDist.push(dist[i1]);
      else newDist.push(1 + Math.min(dist[i1], dist[i1 + 1], newDist[newDist.length - 1]));
    }
    dist = newDist;
  }
  return dist[dist.length - 1];
}

function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateForFileName(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDateTimeJP(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function sanitizeForFileName(str) {
  return (str || '').replace(/[\\\/:*?"<>|]/g, '_').trim();
}

// Google Drive の `properties` は 1エントリあたり key+value 合計で124バイト(UTF-8)までという制限があるため、
// 文字列をバイト単位で安全に切り詰めるヘルパー。サロゲートペアなどの途中で切らないよう1文字(コードポイント)単位で処理する。
function truncateUtf8(str, maxBytes) {
  if (!str) return '';
  let bytes = 0;
  let result = '';
  const encoder = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  for (const ch of String(str)) {
    const chBytes = encoder ? encoder.encode(ch).length : ch.length;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    result += ch;
  }
  return result;
}

// mimeType からファイル拡張子を推定 (Drive上のファイル名に拡張子を付与するため)
function extensionFromMimeType(mime) {
  if (!mime) return '';
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
    'image/heif': '.heif',
  };
  return map[mime.toLowerCase()] || '';
}

function extensionFromFileName(name) {
  if (!name) return '';
  const m = name.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

// 画像ファイル(File オブジェクトなど)から拡張子を決定する。まずMIMEタイプを優先し、
// 判定できない場合は元のファイル名の拡張子にフォールバックする。
function resolveExtension(mimeType, originalName) {
  return extensionFromMimeType(mimeType) || extensionFromFileName(originalName) || '.png';
}

// value を安全に整数へ変換 (NaN の場合は fallback を返す)
function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
