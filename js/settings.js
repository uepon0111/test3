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

    /* 音量一定化モード */
    const normToggle = el('setting-normalize-volume');
    if (normToggle) {
      normToggle.checked = AppState.normalizeVolume;
      normToggle.addEventListener('change', async () => {
        AppState.setNormalizeVolume(normToggle.checked);
        await AudioEngine.applyDspSettings();
        Toast.success(normToggle.checked ? '音量一定化モードをオンにしました' : '音量一定化モードをオフにしました');
      });
    }

    /* 無音削除モード */
    const trimToggle = el('setting-trim-silence');
    if (trimToggle) {
      trimToggle.checked = AppState.trimSilence;
      trimToggle.addEventListener('change', async () => {
        AppState.setTrimSilence(trimToggle.checked);
        await AudioEngine.applyDspSettings();
        Toast.success(trimToggle.checked ? '無音削除モードをオンにしました' : '無音削除モードをオフにしました');
      });
    }

    /* Update storage info + EQ canvas on screen enter */
    EventBus.on('screen:change', async s => {
      if (s !== 'settings') return;
      await renderStorageInfo();
      Equalizer.drawCanvas();
    });
  }

  return { init, renderStorageInfo };
})();
