'use strict';

/* ============================================================
   UTILS  —  共通ユーティリティ関数
   ============================================================ */

/** UUID v4 生成 */
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** 秒数 → m:ss / h:mm:ss */
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** バイト → 人間可読サイズ */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** 日付文字列 → YYYY-MM-DD */
function toDateStr(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → 表示用文字列 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** debounce */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** throttle */
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
  };
}

/** clamp */
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

/** ArrayBuffer → Base64 data URL */
function bufToDataUrl(buffer, mimeType) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return `data:${mimeType};base64,${btoa(bin)}`;
}

/** File → Base64 data URL (Promise) */
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** File → ArrayBuffer (Promise) */
function fileToArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}

/** 要素が存在すれば返す */
function el(id) { return document.getElementById(id); }

/**
 * アイコンを安全に切り替える。
 * lucide.createIcons() は <i data-lucide="..."> を <svg> に「置換」するため、
 * 一度変換された後は tag 名で <i> を探すセレクタが二度とマッチしなくなる。
 * このヘルパーは現在の要素が <i> でも <svg> でも確実に動作する。
 */
function setIcon(container, iconName) {
  if (!container) return;
  const old = container.querySelector('[data-lucide]');
  const fresh = document.createElement('i');
  fresh.setAttribute('data-lucide', iconName);
  if (old) {
    const style = old.getAttribute('style');
    if (style) fresh.setAttribute('style', style);
    old.replaceWith(fresh);
  } else {
    container.appendChild(fresh);
  }
  lucide.createIcons({ elements: [container] });
}

/** テキストコンテンツを安全に設定 */
function setText(id, text) {
  const e = el(id);
  if (e) e.textContent = text;
}

/** HTML を安全にエスケープ */
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ============================================================
   TOAST
   ============================================================ */
const Toast = (() => {
  const container = () => el('toast-container');
  function show(msg, type = 'default', duration = 2800) {
    const c = container();
    if (!c) return;
    const div = document.createElement('div');
    div.className = `toast${type !== 'default' ? ` toast--${type}` : ''}`;
    div.textContent = msg;
    c.appendChild(div);
    const remove = () => {
      div.classList.add('out');
      div.addEventListener('animationend', () => div.remove(), { once: true });
      setTimeout(() => div.remove(), 400);
    };
    const timer = setTimeout(remove, duration);
    div.addEventListener('click', () => { clearTimeout(timer); remove(); });
  }
  return {
    success: (m, d)  => show(m, 'success', d),
    error:   (m, d)  => show(m, 'error',   d),
    warning: (m, d)  => show(m, 'warning', d),
    info:    (m, d)  => show(m, 'default', d),
  };
})();

/* ============================================================
   CONFIRM DIALOG
   ============================================================ */
const Confirm = (() => {
  let resolve = null;
  function open(msg, title = '確認', okLabel = '実行', danger = true) {
    return new Promise(res => {
      resolve = res;
      el('confirm-title').textContent = title;
      el('confirm-msg').textContent   = msg;
      const okBtn = el('btn-confirm-ok');
      okBtn.textContent = okLabel;
      okBtn.className = danger ? 'danger-btn' : 'primary-btn';
      el('modal-confirm').classList.remove('hidden');
    });
  }
  document.addEventListener('click', e => {
    if (!resolve) return;
    if (e.target.id === 'btn-confirm-ok')     { resolve(true);  close(); }
    if (e.target.id === 'btn-confirm-cancel') { resolve(false); close(); }
  });
  function close() {
    el('modal-confirm').classList.add('hidden');
    resolve = null;
  }
  return { open };
})();

/* ============================================================
   CONTEXT MENU
   ============================================================ */
const CtxMenu = (() => {
  let current = null;
  function open(items, x, y) {
    close();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    items.forEach(item => {
      if (item.separator) {
        const sep = document.createElement('hr');
        sep.style.cssText = 'border:none;border-top:1px solid var(--color-border);margin:4px 0';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.className = `ctx-item${item.danger ? ' ctx-item--danger' : ''}`;
      if (item.icon) {
        const ico = document.createElement('i');
        ico.dataset.lucide = item.icon;
        ico.style.cssText = 'width:15px;height:15px';
        btn.appendChild(ico);
      }
      btn.appendChild(document.createTextNode(item.label));
      btn.addEventListener('click', () => { close(); item.action(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    current = menu;
    // Ensure inside viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  menu.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top  = `${y - rect.height}px`;
    lucide.createIcons({ elements: [menu] });
  }
  function close() {
    if (current) { current.remove(); current = null; }
  }
  document.addEventListener('click', e => {
    if (current && !current.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return { open, close };
})();

/* ============================================================
   MODAL HELPERS
   ============================================================ */
function openModal(id)  { el(id)?.classList.remove('hidden'); }
function closeModal(id) { el(id)?.classList.add('hidden'); }

function setupModalClose(modalId, ...selectors) {
  selectors.forEach(sel => {
    document.querySelectorAll(`#${modalId} ${sel}`).forEach(btn => {
      btn.addEventListener('click', () => closeModal(modalId));
    });
  });
}

/** 共通: クラス selector で閉じる */
function bindModalCloseByClass(cls, modalId) {
  document.querySelectorAll(`.${cls}`).forEach(b =>
    b.addEventListener('click', () => closeModal(modalId))
  );
}

/* ============================================================
   SORT HELPER
   ============================================================ */
function sortTracks(tracks, sortBy, sortOrder, allTracks) {
  const dir = sortOrder === 'asc' ? 1 : -1;
  const arr = [...tracks];
  if (sortBy === 'manual') {
    arr.sort((a, b) => ((a.manualOrder ?? 0) - (b.manualOrder ?? 0)) * dir);
  } else if (sortBy === 'title') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ja') * dir);
  } else if (sortBy === 'added') {
    arr.sort((a, b) => ((a.addedAt || 0) - (b.addedAt || 0)) * dir);
  } else if (sortBy === 'release') {
    arr.sort((a, b) => {
      const da = a.releaseDate || '';
      const db = b.releaseDate || '';
      return da < db ? -dir : da > db ? dir : 0;
    });
  }
  return arr;
}

/** タグの色を取得 (state.tags から) */
function getTagColor(tagId) {
  const tag = AppState.tags.find(t => t.id === tagId);
  return tag ? tag.color : '#94a3b8';
}
function getTag(tagId) { return AppState.tags.find(t => t.id === tagId) || null; }
function getArtist(artistId) { return AppState.artists.find(a => a.id === artistId) || null; }
function getTrack(trackId)   { return AppState.tracks.find(t => t.id === trackId)   || null; }

/** アーティスト名をカンマ区切りで返す */
function getArtistNames(track) {
  if (!track?.artistIds?.length) return '不明のアーティスト';
  return track.artistIds.map(id => getArtist(id)?.name || '不明のアーティスト').join(', ');
}
