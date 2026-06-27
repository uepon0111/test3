/**
 * virtual-scroll.js — グリッドレイアウト用仮想スクロール
 */
class VirtualScroll {
  constructor(container, options = {}) {
    this.container   = container;
    this.inner       = container.querySelector('.virtual-scroll-inner') || container;
    this.cardHeight  = options.cardHeight  || 240;
    this.gapY        = options.gapY        || 12;
    this.gapX        = options.gapX        || 12;
    this.overscan    = options.overscan    || 2;
    this.renderItem  = options.renderItem  || (() => null);
    this.onScroll    = options.onScroll    || null;

    this._items   = [];
    this._cols    = 1;
    this._mounted = new Map(); // index → element

    this._ro = new ResizeObserver(() => this._update());
    this._ro.observe(container);
    container.addEventListener('scroll', () => this._onScroll());
  }

  setItems(items) {
    for (const [, el] of this._mounted) el.remove();
    this._mounted.clear();
    this._items = items;
    this._update();
  }

  refresh() {
    for (const [, el] of this._mounted) el.remove();
    this._mounted.clear();
    this._render();
  }

  _getCols() {
    const w = this.inner.offsetWidth || this.container.clientWidth;
    if (w >= 1200) return 4;
    if (w >= 900)  return 3;
    if (w >= 600)  return 2;
    return 1;
  }

  _rowCount() {
    return Math.ceil(this._items.length / this._cols);
  }

  _totalHeight() {
    const rows = this._rowCount();
    return rows * this.cardHeight + Math.max(0, rows - 1) * this.gapY;
  }

  _cardWidth() {
    // inner.offsetWidth = actual content width (excludes container padding)
    const innerW = this.inner.offsetWidth || (this.container.clientWidth - 24);
    const avail  = innerW - this.gapX * (this._cols - 1);
    return Math.max(1, Math.floor(avail / this._cols));
  }

  _getVisibleRange() {
    const scrollTop  = this.container.scrollTop;
    const viewHeight = this.container.clientHeight;
    const rowH       = this.cardHeight + this.gapY;

    const startRow = Math.max(0, Math.floor(scrollTop / rowH) - this.overscan);
    const endRow   = Math.min(
      this._rowCount() - 1,
      Math.ceil((scrollTop + viewHeight) / rowH) + this.overscan
    );
    return {
      startIdx: startRow * this._cols,
      endIdx:   Math.min((endRow + 1) * this._cols - 1, this._items.length - 1),
    };
  }

  _getPositionOf(idx) {
    const row = Math.floor(idx / this._cols);
    const col = idx % this._cols;
    const rowH = this.cardHeight + this.gapY;
    const colW = this._cardWidth() + this.gapX;
    return {
      top:   row * rowH,
      left:  col * colW,
      width: this._cardWidth(),
      height: this.cardHeight,
    };
  }

  _update() {
    const newCols = this._getCols();
    if (newCols !== this._cols) {
      for (const [, el] of this._mounted) el.remove();
      this._mounted.clear();
    }
    this._cols = newCols;
    const totalH = this._totalHeight();
    this.inner.style.height    = totalH + 'px';
    this.inner.style.position  = 'relative';
    this.inner.style.minHeight = totalH + 'px';
    this._render();
  }

  _render() {
    const { startIdx, endIdx } = this._getVisibleRange();
    const needed = new Set();
    for (let i = startIdx; i <= endIdx; i++) needed.add(i);

    // Remove unmounted
    for (const [idx, el] of this._mounted) {
      if (!needed.has(idx)) { el.remove(); this._mounted.delete(idx); }
    }

    // Add needed
    for (let i = startIdx; i <= endIdx; i++) {
      if (this._mounted.has(i)) continue;
      const item = this._items[i];
      if (!item) continue;
      const el = this.renderItem(item, i);
      if (!el) continue;
      const pos = this._getPositionOf(i);
      el.style.position = 'absolute';
      el.style.top      = pos.top    + 'px';
      el.style.left     = pos.left   + 'px';
      el.style.width    = pos.width  + 'px';
      el.style.height   = pos.height + 'px';
      this.inner.appendChild(el);
      this._mounted.set(i, el);
    }
  }

  _onScroll() {
    this._render();
    if (this.onScroll) this.onScroll(this.container.scrollTop);
  }

  scrollToTop() {
    this.container.scrollTop = 0;
  }

  destroy() {
    this._ro.disconnect();
  }
}
