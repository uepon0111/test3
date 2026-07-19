/*
 * title-autocomplete.js
 * -----------------------------------------------------------------------
 * 「入力した内容からリアルタイムで候補を表示して選択できる」検索欄を作るための
 * 小さな汎用コンポーネントです。以下の2箇所で使い回します。
 *
 *   1. アップロード/編集フォームの「曲名」欄 (upload-editor.js から初期化)
 *      候補ソース: 楽曲マスターDB (dbMusics) 全件
 *   2. ページ内の「曲名検索」フィルター欄 (grid-view.js から初期化)
 *      候補ソース: 現在読み込み済みのレコードに実際に存在する曲名のみ
 *                  (0件になる曲を候補に出しても意味が無いため)
 *
 * どちらも「読み方(ひらがな)」でも検索できるようにするのが要件のため、
 * マッチング自体はここに一本化し、utils.js の normalizeKanaSearch()
 * (カタカナ→ひらがな変換込みの正規化)を使って 曲名/読み方 の両方を検索対象にします。
 *
 * ドロップダウンは document.body 直下に position:fixed で1つだけ生成し、
 * 表示のたびに入力欄の位置を基準に再配置します。モーダル内の input は
 * overflow:auto な祖先を持つことがあり、position:absolute のままだと
 * スクロール領域でクリップされてしまうため、position:fixed + 手動再配置という
 * 構成にしています。
 * -----------------------------------------------------------------------
 */

// クエリ文字列 nq(正規化済み)が、正規化済みタイトル/読み方のどこにマッチするかで
// スコアを付ける。先頭一致を最優先、部分一致がそれに次ぎ、タイトル一致を読み方一致より
// 優先する。null を返した場合は非マッチ。
function scoreAutocompleteMatch(nq, normTitle, normPron) {
  if (!nq) return null;
  let idx = normTitle.indexOf(nq);
  if (idx === 0) return 0 + normTitle.length * 0.001;
  if (idx > 0) return 10 + idx * 0.01 + normTitle.length * 0.001;
  if (normPron) {
    idx = normPron.indexOf(nq);
    if (idx === 0) return 20 + normPron.length * 0.001;
    if (idx > 0) return 30 + idx * 0.01 + normPron.length * 0.001;
  }
  return null;
}

// source: [{ title, pronunciation, ...任意の追加フィールド }]
function searchAutocomplete(query, source, limit) {
  const nq = normalizeKanaSearch(query);
  if (!nq || !source || source.length === 0) return [];
  const scored = [];
  for (const item of source) {
    const normTitle = normalizeKanaSearch(item.title);
    const normPron = item.pronunciation ? normalizeKanaSearch(item.pronunciation) : '';
    const score = scoreAutocompleteMatch(nq, normTitle, normPron);
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit || 8).map(s => s.item);
}

// config:
//   inputEl     : 対象の <input type="text">
//   getSource() : 候補配列 [{title, pronunciation, ...}] を返す関数(呼び出しの都度評価するため、
//                 DBやレコード一覧が後から読み込まれても常に最新の状態で検索できる)
//   onSelect(item): 候補が選択された時のコールバック
//   limit       : 表示件数上限 (デフォルト8)
function initTitleAutocomplete(config) {
  const inputEl = config.inputEl;
  const dropdown = document.createElement('div');
  dropdown.className = 'autocomplete-dropdown';
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);

  let items = [];
  let highlightedIndex = -1;
  let isComposing = false;

  function hide() {
    dropdown.style.display = 'none';
    items = [];
    highlightedIndex = -1;
  }

  function reposition() {
    const r = inputEl.getBoundingClientRect();
    const maxHeight = 260;
    const spaceBelow = window.innerHeight - r.bottom;
    dropdown.style.left = Math.round(r.left) + 'px';
    dropdown.style.width = Math.round(r.width) + 'px';
    if (spaceBelow < maxHeight && r.top > spaceBelow) {
      dropdown.style.top = '';
      dropdown.style.bottom = Math.round(window.innerHeight - r.top) + 'px';
      dropdown.style.maxHeight = Math.max(80, Math.min(maxHeight, r.top - 8)) + 'px';
    } else {
      dropdown.style.bottom = '';
      dropdown.style.top = Math.round(r.bottom) + 'px';
      dropdown.style.maxHeight = Math.max(80, Math.min(maxHeight, spaceBelow - 8)) + 'px';
    }
  }

  function render() {
    if (items.length === 0) { hide(); return; }
    dropdown.innerHTML = items.map((it, i) => `
      <div class="autocomplete-item ${i === highlightedIndex ? 'highlighted' : ''}" data-idx="${i}">
        <div class="autocomplete-item-title">${escapeHtml(it.title)}</div>
        ${it.pronunciation ? `<div class="autocomplete-item-sub">${escapeHtml(it.pronunciation)}</div>` : ''}
      </div>
    `).join('');
    dropdown.querySelectorAll('.autocomplete-item').forEach(el => {
      // mousedown(+preventDefault)を使うことで、input の blur が先に発火して
      // ドロップダウンが閉じてしまう前に選択を確定させる(典型的なオートコンプリートの定石)。
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select(parseInt(el.dataset.idx, 10));
      });
    });
    reposition();
    dropdown.style.display = 'block';
  }

  function select(idx) {
    const it = items[idx];
    if (!it) return;
    config.onSelect(it);
    hide();
  }

  function updateSuggestions() {
    const source = config.getSource ? (config.getSource() || []) : [];
    items = searchAutocomplete(inputEl.value, source, config.limit || 8);
    highlightedIndex = items.length > 0 ? 0 : -1;
    render();
  }

  const debouncedUpdate = debounce(updateSuggestions, 80);

  inputEl.addEventListener('input', debouncedUpdate);
  inputEl.addEventListener('focus', () => { if (inputEl.value) updateSuggestions(); });
  inputEl.addEventListener('compositionstart', () => { isComposing = true; });
  inputEl.addEventListener('compositionend', () => { isComposing = false; updateSuggestions(); });
  inputEl.addEventListener('keydown', (e) => {
    if (dropdown.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightedIndex = Math.min(items.length - 1, highlightedIndex + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlightedIndex = Math.max(0, highlightedIndex - 1); render(); }
    else if (e.key === 'Enter') { if (isComposing || e.isComposing) return; if (highlightedIndex >= 0) { e.preventDefault(); select(highlightedIndex); } }
    else if (e.key === 'Escape') { hide(); }
  });
  // blur を setTimeout で少し遅らせ、候補クリック(mousedown)の select() が先に実行されるようにする。
  inputEl.addEventListener('blur', () => { setTimeout(hide, 120); });
  window.addEventListener('scroll', () => { if (dropdown.style.display !== 'none') reposition(); }, true);
  window.addEventListener('resize', () => { if (dropdown.style.display !== 'none') reposition(); });

  return { hide, refresh: updateSuggestions };
}
