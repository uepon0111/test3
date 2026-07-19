/*
 * autocomplete.js
 * -----------------------------------------------------------------------
 * 入力欄にリアルタイム候補ドロップダウンを付与する、汎用の軽量オートコンプリート部品です。
 * 曲名の手動登録欄 (upload-editor.js) とページ内の曲名検索欄 (grid-view.js) の
 * 両方から利用します(候補の中身=何を検索するかは呼び出し側が getSuggestions で渡す)。
 *
 * ドロップダウンはモーダル内・スクロール領域内などどこに置かれた入力欄でも
 * overflow:hidden な祖先要素に隠れてしまわないよう、document.body 直下に
 * position:fixed で描画し、入力欄の位置(スクロール・リサイズ)に追従させます。
 * -----------------------------------------------------------------------
 */

function attachAutocomplete(inputEl, options) {
  const opts = Object.assign({
    minChars: 1,
    debounceMs: 150,
    limit: 8,
    getSuggestions: () => [],          // (query, limit) => Array<item> | Promise<Array<item>>
    getPrimaryText: (item) => String(item),
    getSecondaryText: () => '',
    onSelect: () => {},
    emptyText: null,                    // nullなら候補0件の時は単に何も出さない
  }, options || {});

  const dropdown = document.createElement('div');
  dropdown.className = 'ac-dropdown';
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);

  let items = [];
  let highlightIndex = -1;
  let isOpen = false;
  let searchToken = 0; // 連続入力時に古い検索結果が後から描画されるのを防ぐ

  function closeDropdown() {
    isOpen = false;
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }

  function reposition() {
    const rect = inputEl.getBoundingClientRect();
    const estHeight = Math.min(items.length || 1, opts.limit) * 46 + 10;
    let top = rect.bottom + 4;
    if (top + estHeight > window.innerHeight && rect.top > estHeight) {
      top = rect.top - estHeight - 4; // 画面下端に収まらない場合は入力欄の上に表示
    }
    dropdown.style.left = Math.max(4, rect.left) + 'px';
    dropdown.style.top = top + 'px';
    dropdown.style.width = rect.width + 'px';
  }

  function updateHighlightClasses() {
    dropdown.querySelectorAll('.ac-item').forEach(el => {
      el.classList.toggle('ac-item-active', parseInt(el.dataset.idx, 10) === highlightIndex);
    });
  }

  function scrollHighlightedIntoView() {
    const el = dropdown.querySelector('.ac-item-active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function selectItem(idx) {
    const item = items[idx];
    if (!item) return;
    closeDropdown();
    opts.onSelect(item);
  }

  function renderDropdown() {
    if (items.length === 0) {
      if (!opts.emptyText) { closeDropdown(); return; }
      dropdown.innerHTML = `<div class="ac-empty">${escapeHtml(opts.emptyText)}</div>`;
    } else {
      dropdown.innerHTML = items.map((item, i) => {
        const primary = escapeHtml(opts.getPrimaryText(item));
        const secondary = opts.getSecondaryText(item);
        return `
          <div class="ac-item${i === highlightIndex ? ' ac-item-active' : ''}" data-idx="${i}">
            <span class="ac-item-primary">${primary}</span>${secondary ? `<span class="ac-item-secondary">${escapeHtml(secondary)}</span>` : ''}
          </div>`;
      }).join('');
      dropdown.querySelectorAll('.ac-item').forEach(el => {
        // mousedownの時点でpreventDefaultし、inputのフォーカスが外れる(blur)前に選択処理を行う。
        // こうすることでフォーカスが移らず、blurによるクローズ処理と競合しない。
        el.addEventListener('mousedown', (e) => { e.preventDefault(); selectItem(parseInt(el.dataset.idx, 10)); });
        el.addEventListener('mouseenter', () => { highlightIndex = parseInt(el.dataset.idx, 10); updateHighlightClasses(); });
      });
    }
    isOpen = true;
    dropdown.style.display = 'block';
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
  }

  async function runSearch() {
    const q = inputEl.value.trim();
    if (q.length < opts.minChars) { closeDropdown(); return; }
    const myToken = ++searchToken;
    const result = await Promise.resolve(opts.getSuggestions(q, opts.limit));
    if (myToken !== searchToken) return; // 入力が変わっていたら古い結果は捨てる
    items = result || [];
    highlightIndex = -1;
    renderDropdown();
  }

  const debouncedSearch = debounce(runSearch, opts.debounceMs);

  inputEl.addEventListener('input', debouncedSearch);
  inputEl.addEventListener('focus', () => { if (inputEl.value.trim().length >= opts.minChars) runSearch(); });
  inputEl.addEventListener('blur', () => { setTimeout(closeDropdown, 120); });
  inputEl.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightIndex = Math.min(highlightIndex + 1, items.length - 1);
      updateHighlightClasses(); scrollHighlightedIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightIndex = Math.max(highlightIndex - 1, 0);
      updateHighlightClasses(); scrollHighlightedIntoView();
    } else if (e.key === 'Enter') {
      if (highlightIndex >= 0) { e.preventDefault(); selectItem(highlightIndex); }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  return { close: closeDropdown };
}
