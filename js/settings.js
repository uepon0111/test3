'use strict';

/* ============================================================
   SETTINGS SCREEN  —  設定画面
   ============================================================ */

const SettingsScreen = (() => {

  async function renderStorageInfo() {
    const wrap = el('storage-info');
    if (!wrap) return;
    try {
      const est   = await Storage.getStorageEstimate();
      const used  = est.usage  || 0;
      const quota = est.quota  || 0;
      const pct   = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
      const wCls  = pct > 85 ? ' danger' : pct > 65 ? ' warn' : '';
      const plCnt = AppState.playlists.filter(p => !p.isDefault).length;

      wrap.innerHTML = `
        <div class="storage-bar-wrap">
          <div class="storage-bar-label">
            <span>ストレージ使用量</span>
            <strong>${formatBytes(used)} / ${quota > 0 ? formatBytes(quota) : '不明'} (${pct}%)</strong>
          </div>
          <div class="storage-usage-bar">
            <div class="storage-usage-fill${wCls}" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="storage-stats">
          <div class="storage-stat">
            <div class="storage-stat-num">${AppState.tracks.length.toLocaleString('ja-JP')}</div>
            <div class="storage-stat-label">曲</div>
          </div>
          <div class="storage-stat">
            <div class="storage-stat-num">${plCnt}</div>
            <div class="storage-stat-label">プレイリスト</div>
          </div>
          <div class="storage-stat">
            <div class="storage-stat-num">${AppState.tags.length}</div>
            <div class="storage-stat-label">タグ</div>
          </div>
          <div class="storage-stat">
            <div class="storage-stat-num">${AppState.artists.length}</div>
            <div class="storage-stat-label">アーティスト</div>
          </div>
        </div>`;

      if (pct > 85) Toast.warning('ストレージ残量が少なくなっています（85%超）', 6000);
    } catch {
      if (wrap) wrap.innerHTML = '<p class="settings-text settings-text--muted">ストレージ情報を取得できませんでした</p>';
    }
  }

  function init() {
    const normalizeToggle = el('normalize-volume');
    if (normalizeToggle) normalizeToggle.checked = !!AppState.normalizeVolume;

    normalizeToggle?.addEventListener('change', async () => {
      AppState.normalizeVolume = normalizeToggle.checked;
      AudioEngine.setNormalizeVolume(normalizeToggle.checked);
      await Storage.setSetting('normalize_volume', normalizeToggle.checked);
      Toast.info(normalizeToggle.checked ? '音量一定化モードを有効にしました' : '音量一定化モードを無効にしました');
    });

    /* Clear all data */
    el('btn-clear-all')?.addEventListener('click', async () => {
      const ok = await Confirm.open(
        'すべての曲・プレイリスト・タグ・アーティスト・再生ログを削除します。\nこの操作は取り消せません。',
        'すべてのデータを削除', '削除する', true
      );
      if (!ok) return;
      try {
        await Storage.clearAll();
        Toast.success('削除しました。再読み込みします…');
        setTimeout(() => location.reload(), 1500);
      } catch { Toast.error('削除に失敗しました'); }
    });

    /* Update storage info + EQ canvas on screen enter */
    EventBus.on('screen:change', async s => {
      if (s !== 'settings') return;
      await renderStorageInfo();
      Equalizer.drawCanvas();
    });
  }

  return { init, renderStorageInfo };
})();
