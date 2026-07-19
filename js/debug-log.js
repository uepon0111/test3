/*
 * debug-log.js
 * -----------------------------------------------------------------------
 * 「実測ログ」モーダルの表示ロジック。
 * upload-editor.js が解析結果と一緒に item.debugLog / item.warnings / item.reasoning /
 * item.confidence として保存した情報を、人が読める形で描画します。
 *
 *   - 総合判断の結果(警告一覧)
 *   - 判断の過程(曲名の逆算などをどう判断したかのトレース)
 *   - 項目ごとの実測ログ(切り出し座標・二値化後の画像・OCRテキスト・信頼度)
 * -----------------------------------------------------------------------
 */

const DEBUG_LOG_FIELD_ORDER = [
  { key: 'difficulty', label: '難易度' },
  { key: 'level', label: '楽曲レベル' },
  { key: 'title', label: '曲名' },
  { key: 'breakdown', label: '判定内訳' },
  { key: 'combo', label: 'コンボ数' },
];

function openDebugLogModal(itemId) {
  const item = editorQueue.find(q => q.id === itemId);
  if (!item) return;
  renderDebugLogContent(item);
  document.getElementById('debugLogModal').style.display = 'flex';
}

function closeDebugLogModal() {
  document.getElementById('debugLogModal').style.display = 'none';
}

function confidenceBadgeHtml(level) {
  const map = {
    high: { text: '信頼度: 高', cls: 'conf-high' },
    medium: { text: '信頼度: 中', cls: 'conf-medium' },
    low: { text: '信頼度: 低', cls: 'conf-low' },
  };
  const m = map[level] || map.low;
  return `<span class="confidence-badge ${m.cls}">${m.text}</span>`;
}

const WARNING_ICON_BY_LEVEL = { error: 'error', warn: 'warning', info: 'info' };

function warningListHtml(warnings) {
  if (!warnings || warnings.length === 0) {
    return `<div class="log-warning-item log-level-ok"><span class="material-symbols-outlined">check_circle</span><span>目立った矛盾は検出されませんでした。</span></div>`;
  }
  return warnings.map(w => `
    <div class="log-warning-item log-level-${escapeHtml(w.level)}">
      <span class="material-symbols-outlined">${WARNING_ICON_BY_LEVEL[w.level] || 'info'}</span>
      <span>${escapeHtml(w.message)}</span>
    </div>
  `).join('');
}

function reasoningListHtml(reasoning) {
  if (!reasoning || reasoning.length === 0) return '<p class="log-empty">判断ステップの記録はありません(直接一致など単純なケース)。</p>';
  return `<ol class="reasoning-list">${reasoning.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ol>`;
}

function fieldCardHtml(label, log, confidenceLevel) {
  if (!log) return `<div class="log-field-card"><div class="log-field-header"><span class="log-field-label">${escapeHtml(label)}</span></div><p class="log-empty">データがありません</p></div>`;
  const rect = log.srcRect || {};
  const ratio = log.regionRatio || {};
  const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : '-');
  return `
    <div class="log-field-card">
      <div class="log-field-header">
        <span class="log-field-label">${escapeHtml(label)}</span>
        ${confidenceBadgeHtml(confidenceLevel)}
      </div>
      <div class="log-field-body">
        <img src="${log.dataUrl}" class="log-field-image" alt="${escapeHtml(label)} 二値化後画像">
        <div class="log-field-meta">
          <div><span class="log-meta-key">切り出し座標(px)</span>x:${rect.x}, y:${rect.y}, w:${rect.w}, h:${rect.h}</div>
          <div><span class="log-meta-key">切り出し座標(比率)</span>x:${fmt(ratio.x)}, y:${fmt(ratio.y)}, w:${fmt(ratio.w)}, h:${fmt(ratio.h)}</div>
          <div><span class="log-meta-key">二値化しきい値</span>${log.threshold} (${log.channelType === 'whiteness' ? '白さ基準' : '明度基準'})</div>
          <div><span class="log-meta-key">OCR結果</span><code>${escapeHtml(log.ocrText) || '(空)'}</code></div>
          <div><span class="log-meta-key">OCR信頼度</span>${log.confidence}%</div>
          ${log.ocrError ? `<div class="log-meta-error">⚠ ${escapeHtml(log.ocrError)}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderDebugLogContent(item) {
  const container = document.getElementById('debug-log-content');
  document.getElementById('debug-log-subtitle').innerText = item.data.title ? `「${item.data.title}」の実測ログ` : '実測ログ';

  if (!item.debugLog) {
    container.innerHTML = '<p class="log-empty">この画像はまだ解析されていません。先に「この画像を再解析」を実行してください。</p>';
    return;
  }

  const conf = item.confidence || {};
  const dl = item.debugLog;

  container.innerHTML = `
    <div class="log-section">
      <h4><span class="material-symbols-outlined" style="font-size:1.1rem;">fact_check</span> 総合判断の結果</h4>
      ${warningListHtml(item.warnings)}
    </div>
    <div class="log-section">
      <h4><span class="material-symbols-outlined" style="font-size:1.1rem;">route</span> 判断の過程</h4>
      ${reasoningListHtml(item.reasoning)}
    </div>
    <div class="log-section">
      <h4><span class="material-symbols-outlined" style="font-size:1.1rem;">image_search</span> 項目ごとの実測ログ</h4>
      <div class="log-field-grid">
        ${DEBUG_LOG_FIELD_ORDER.map(f => fieldCardHtml(f.label, dl[f.key], conf[f.key])).join('')}
      </div>
    </div>
  `;
}
