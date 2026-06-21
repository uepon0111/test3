'use strict';

/* ============================================================
   VIRTUAL SCROLL  —  大量アイテムを高速描画
   ============================================================ */

/* ---- VirtualList  (リスト = 固定高さの行) ---- */
class VirtualList {
  constructor(opts) {
    // opts: viewport, spacerTop, content, spacerBot, getItems, renderItem, rowHeight, buffer
    this.viewport   = opts.viewport;
    this.spacerTop  = opts.spacerTop;
    this.content    = opts.content;
    this.spacerBot  = opts.spacerBot;
    this.getItems   = opts.getItems;      // () => Item[]
    this.renderItem = opts.renderItem;    // (item, index) => HTMLElement
    this.ROW_H      = opts.rowHeight || 72;
    this.BUFFER     = opts.buffer    || 3;

    this._items       = [];
    this._startIndex  = 0;
    this._rendered    = 0;
    this._raf         = null;

    this.viewport.addEventListener('scroll', () => this._onScroll(), { passive: true });
  }

  /** 再描画（データ変更時に呼ぶ） */
  refresh() {
    this._items      = this.getItems();
    this._startIndex = -1;  // キャッシュを無効化して強制再描画
    this._rendered   = 0;
    this._render();
  }

  _onScroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _render() {
    const items  = this._items;
    const total  = items.length;
    const vpH    = this.viewport.clientHeight;
    const scrollY = this.viewport.scrollTop;

    const firstVisible = Math.floor(scrollY / this.ROW_H);
    const start = Math.max(0, firstVisible - this.BUFFER);
    const visibleCount = Math.ceil(vpH / this.ROW_H) + this.BUFFER * 2 + 2;
    const end   = Math.min(total, start + visibleCount);

    this.spacerTop.style.height = `${start * this.ROW_H}px`;
    this.spacerBot.style.height = `${Math.max(0, total - end) * this.ROW_H}px`;

    // If same range, skip re-render
    if (start === this._startIndex && end - start === this._rendered && this.content.children.length > 0) return;

    this._startIndex = start;
    this._rendered   = end - start;
    this.content.innerHTML = '';
    for (let i = start; i < end; i++) {
      this.content.appendChild(this.renderItem(items[i], i));
    }
  }

  /** スクロールを上に戻す */
  scrollToTop() { this.viewport.scrollTop = 0; }

  /** 特定インデックスにスクロール */
  scrollToIndex(index) {
    this.viewport.scrollTop = index * this.ROW_H;
  }
}

/* ---- VirtualGrid  (グリッド = 複数列) ---- */
class VirtualGrid {
  constructor(opts) {
    this.viewport    = opts.viewport;
    this.spacerTop   = opts.spacerTop;
    this.content     = opts.content;
    this.spacerBot   = opts.spacerBot;
    this.getItems    = opts.getItems;
    this.renderItem  = opts.renderItem;
    this.getColumns  = opts.getColumns; // () => number
    this.CARD_H      = opts.cardHeight || 260;
    this.BUFFER      = opts.buffer     || 2;

    this._items      = [];
    this._cols       = 4;
    this._startRow   = 0;
    this._rendRows   = 0;
    this._raf        = null;

    this.viewport.addEventListener('scroll', () => this._onScroll(), { passive: true });
    window.addEventListener('resize', debounce(() => this._resize(), 120));
  }

  refresh() {
    this._cols     = this.getColumns();
    this._items    = this.getItems();
    this._startRow = -1;  // キャッシュを無効化
    this._rendRows = 0;
    this.content.dataset.cols = this._cols;
    this._render();
  }

  _resize() {
    const newCols = this.getColumns();
    if (newCols !== this._cols) { this._cols = newCols; this.content.dataset.cols = newCols; this._render(); }
  }

  _onScroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
  }

  _render() {
    const items   = this._items;
    const cols    = this._cols;
    const total   = items.length;
    const rows    = Math.ceil(total / cols);
    const vpH     = this.viewport.clientHeight;
    const scrollY = this.viewport.scrollTop;
    const rowH    = this.CARD_H;

    const firstVisRow = Math.floor(scrollY / rowH);
    const startRow    = Math.max(0, firstVisRow - this.BUFFER);
    const visRows     = Math.ceil(vpH / rowH) + this.BUFFER * 2 + 2;
    const endRow      = Math.min(rows, startRow + visRows);

    this.spacerTop.style.height = `${startRow * rowH}px`;
    this.spacerBot.style.height = `${Math.max(0, rows - endRow) * rowH}px`;

    if (startRow === this._startRow && endRow - startRow === this._rendRows && this.content.children.length > 0) return;

    this._startRow = startRow;
    this._rendRows = endRow - startRow;
    this.content.innerHTML = '';

    const startIdx = startRow * cols;
    const endIdx   = Math.min(total, endRow * cols);
    for (let i = startIdx; i < endIdx; i++) {
      this.content.appendChild(this.renderItem(items[i], i));
    }
  }

  scrollToTop() { this.viewport.scrollTop = 0; }
}
