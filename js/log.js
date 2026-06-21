'use strict';

/* ============================================================
   LOG SCREEN  —  ログ画面
   ============================================================ */

const LogScreen = (() => {

  let chartInst = null;

  /* ── 期間範囲を計算 ── */
  function _getRange(period) {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end   = Date.now();
    let start;
    switch (period) {
      case 'today': start = today.getTime(); break;
      case 'week':  start = today.getTime() - 6 * 86400000; break;
      case 'month': start = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); break;
      case 'year':  start = new Date(now.getFullYear(), 0, 1).getTime(); break;
      default:      start = 0; // all
    }
    return { start, end };
  }

  /* ── ログをロード（IndexedDB） ── */
  async function _loadLogs() {
    return Storage.getAll(Storage.STORE.PLAY_LOGS);
  }

  /* ── 周年を計算 ── */
  function _calcAnniversaries() {
    const today   = new Date();
    const mm      = String(today.getMonth() + 1).padStart(2, '0');
    const dd      = String(today.getDate()).padStart(2, '0');
    const todayMD = `${mm}-${dd}`;

    return AppState.tracks
      .filter(t => t.releaseDate && t.releaseDate.length >= 10)
      .map(t => {
        const relDate = new Date(t.releaseDate + 'T00:00:00');
        const relMD   = `${String(relDate.getMonth()+1).padStart(2,'0')}-${String(relDate.getDate()).padStart(2,'0')}`;
        if (relMD !== todayMD) return null;
        const years = today.getFullYear() - relDate.getFullYear();
        if (years <= 0) return null;
        return { track: t, years };
      })
      .filter(Boolean)
      .sort((a, b) => b.years - a.years);
  }

  /* ── 周年セクションを描画 ── */
  function _renderAnniversaries() {
    const wrap = el('log-anniv-content');
    if (!wrap) return;
    const items = _calcAnniversaries();
    if (!items.length) {
      wrap.innerHTML = '<div class="anniv-empty">本日の周年はありません</div>';
      el('log-anniv-sec').style.display = 'none';
      return;
    }
    el('log-anniv-sec').style.display = '';
    wrap.innerHTML = '';
    items.forEach(({ track, years }) => {
      const div = document.createElement('div');
      div.className = 'anniv-item';
      const img = document.createElement('img');
      img.className = 'anniv-thumb';
      img.src = track.thumbnail || '';
      img.alt = '';
      img.onerror = () => img.style.display = 'none';
      if (!track.thumbnail) img.style.display = 'none';
      const info = document.createElement('div');
      info.className = 'anniv-info';
      const title = document.createElement('div');
      title.className = 'anniv-title truncate';
      title.textContent = track.title;
      const artist = document.createElement('div');
      artist.className = 'anniv-artist';
      artist.textContent = getArtistNames(track);
      info.appendChild(title); info.appendChild(artist);
      const badge = document.createElement('div');
      badge.className = 'anniv-badge';
      badge.textContent = `${years}周年`;
      div.appendChild(img); div.appendChild(info); div.appendChild(badge);
      wrap.appendChild(div);
    });
  }

  /* ── サマリーを描画 ── */
  function _renderSummary(logs, range) {
    const filtered = logs.filter(l => l.playedAt >= range.start && l.playedAt <= range.end);
    const totalPlays  = filtered.length;
    const totalSec    = filtered.reduce((s, l) => s + (l.duration || 0), 0);
    const uniqueIds   = new Set(filtered.map(l => l.trackId)).size;

    el('stat-plays').textContent  = totalPlays.toLocaleString('ja-JP');
    el('stat-unique').textContent = uniqueIds.toLocaleString('ja-JP');

    const hours = Math.floor(totalSec / 3600);
    const mins  = Math.floor((totalSec % 3600) / 60);
    el('stat-time').textContent = hours > 0 ? `${hours}時間${mins}分` : `${mins}分`;
  }

  /* ── チャートを描画 ── */
  function _renderChart(logs, range, period) {
    const canvas = el('play-chart');
    if (!canvas) return;
    if (chartInst) { chartInst.destroy(); chartInst = null; }

    const filtered = logs.filter(l => l.playedAt >= range.start && l.playedAt <= range.end);

    // Determine buckets
    let labels = [], data = [];
    const now = new Date();

    if (period === 'today' || period === 'week') {
      const days = period === 'today' ? 1 : 7;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        const key = `${d.getMonth()+1}/${d.getDate()}`;
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const dayEnd   = dayStart + 86400000;
        labels.push(key);
        data.push(filtered.filter(l => l.playedAt >= dayStart && l.playedAt < dayEnd).length);
      }
    } else if (period === 'month') {
      const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), d).getTime();
        const dayEnd   = dayStart + 86400000;
        labels.push(`${d}日`);
        data.push(filtered.filter(l => l.playedAt >= dayStart && l.playedAt < dayEnd).length);
      }
    } else if (period === 'year') {
      for (let m = 0; m < 12; m++) {
        const mStart = new Date(now.getFullYear(), m, 1).getTime();
        const mEnd   = new Date(now.getFullYear(), m+1, 1).getTime();
        labels.push(`${m+1}月`);
        data.push(filtered.filter(l => l.playedAt >= mStart && l.playedAt < mEnd).length);
      }
    } else {
      // All: by month, last 12 months
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const mStart = d.getTime();
        const mEnd   = new Date(d.getFullYear(), d.getMonth()+1, 1).getTime();
        labels.push(`${d.getFullYear()}/${d.getMonth()+1}`);
        data.push(filtered.filter(l => l.playedAt >= mStart && l.playedAt < mEnd).length);
      }
    }

    chartInst = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '再生回数',
          data,
          backgroundColor: '#3b82f680',
          borderColor: '#3b82f6',
          borderWidth: 2,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: '#e2e8f0' }, ticks: { font: { size: 10 } } },
          y: { grid: { color: '#e2e8f0' }, ticks: { stepSize: 1, font: { size: 10 } }, beginAtZero: true }
        }
      }
    });
  }

  /* ── 再生多い曲 Top 10 ── */
  function _renderTopTracks(logs, range) {
    const wrap = el('top-tracks-content');
    if (!wrap) return;
    const filtered = logs.filter(l => l.playedAt >= range.start && l.playedAt <= range.end);
    const counts = {};
    filtered.forEach(l => { counts[l.trackId] = (counts[l.trackId] || 0) + 1; });
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, cnt]) => ({ track: AppState.getTrack(id), cnt }))
      .filter(x => x.track);

    wrap.innerHTML = '';
    if (!top.length) { wrap.innerHTML = '<div class="log-no-data">再生記録がありません</div>'; return; }

    top.forEach(({ track, cnt }, i) => {
      const row = document.createElement('div');
      row.className = 'top-track-item';
      const rank = document.createElement('div');
      rank.className = `top-rank${i < 3 ? ` rank-${i+1}` : ''}`;
      rank.textContent = i + 1;
      const thumb = document.createElement('img');
      thumb.className = 'top-track-thumb';
      thumb.src = track.thumbnail || ''; thumb.alt = '';
      if (!track.thumbnail) { thumb.style.background = 'var(--color-bg-3)'; thumb.style.display = 'block'; }
      const info = document.createElement('div');
      info.className = 'top-track-info';
      const t = document.createElement('div'); t.className = 'top-track-title truncate'; t.textContent = track.title;
      const a = document.createElement('div'); a.className = 'top-track-artist'; a.textContent = getArtistNames(track);
      info.appendChild(t); info.appendChild(a);
      const countEl = document.createElement('div');
      countEl.className = 'top-count';
      const num = document.createElement('div'); num.className = 'top-count-num'; num.textContent = cnt;
      const lbl = document.createElement('div'); lbl.className = 'top-count-label'; lbl.textContent = '再生';
      countEl.appendChild(num); countEl.appendChild(lbl);
      row.appendChild(rank); row.appendChild(thumb); row.appendChild(info); row.appendChild(countEl);
      // Click → switch to player and play
      row.addEventListener('click', () => AudioEngine.play(track.id));
      row.style.cursor = 'pointer';
      wrap.appendChild(row);
    });
  }

  /* ── よく聴いたアーティスト ── */
  function _renderTopArtists(logs, range) {
    const wrap = el('top-artists-content');
    if (!wrap) return;
    const filtered = logs.filter(l => l.playedAt >= range.start && l.playedAt <= range.end);
    const counts = {};
    filtered.forEach(l => {
      const track = AppState.getTrack(l.trackId);
      if (!track) return;
      track.artistIds.forEach(aid => { counts[aid] = (counts[aid] || 0) + 1; });
    });
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([id, cnt]) => ({ artist: getArtist(id), cnt }))
      .filter(x => x.artist);

    wrap.innerHTML = '';
    if (!top.length) { wrap.innerHTML = '<div class="log-no-data">再生記録がありません</div>'; return; }

    top.forEach(({ artist, cnt }) => {
      const row = document.createElement('div');
      row.className = 'top-list-item';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'top-artist-icon';
      if (artist.icon) {
        const img = document.createElement('img');
        img.src = artist.icon; img.alt = ''; img.style.cssText='width:100%;height:100%;object-fit:cover;border-radius:50%';
        iconWrap.appendChild(img);
      } else {
        const def = document.createElement('div');
        def.className = 'top-artist-icon-default';
        def.innerHTML = '<i data-lucide="user" style="width:16px;height:16px"></i>';
        iconWrap.appendChild(def);
      }
      const name = document.createElement('div');
      name.className = 'top-list-item-name truncate';
      name.textContent = artist.name;
      const countEl = document.createElement('div');
      countEl.className = 'top-count';
      const num = document.createElement('div'); num.className = 'top-count-num'; num.textContent = cnt;
      const lbl = document.createElement('div'); lbl.className = 'top-count-label'; lbl.textContent = '再生';
      countEl.appendChild(num); countEl.appendChild(lbl);
      row.appendChild(iconWrap); row.appendChild(name); row.appendChild(countEl);
      wrap.appendChild(row);
    });
    lucide.createIcons({ elements: [wrap] });
  }

  /* ── よく聴いたタグ ── */
  function _renderTopTags(logs, range) {
    const wrap = el('top-tags-content');
    if (!wrap) return;
    const filtered = logs.filter(l => l.playedAt >= range.start && l.playedAt <= range.end);
    const counts = {};
    filtered.forEach(l => {
      const track = AppState.getTrack(l.trackId);
      if (!track) return;
      track.tagIds.forEach(tid => { counts[tid] = (counts[tid] || 0) + 1; });
    });
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([id, cnt]) => ({ tag: getTag(id), cnt }))
      .filter(x => x.tag);

    wrap.innerHTML = '';
    if (!top.length) { wrap.innerHTML = '<div class="log-no-data">タグの再生記録がありません</div>'; return; }

    top.forEach(({ tag, cnt }) => {
      const chip = document.createElement('div');
      chip.className = 'top-tag-chip';
      chip.style.background = tag.color;
      chip.textContent = tag.name;
      const countEl = document.createElement('span');
      countEl.className = 'top-tag-count';
      countEl.textContent = cnt;
      chip.appendChild(countEl);
      wrap.appendChild(chip);
    });
  }

  /* ── ページ全体を描画 ── */
  async function render() {
    const period = AppState.logPeriod;
    const range  = _getRange(period);
    const logs   = await _loadLogs();

    _renderAnniversaries();
    _renderSummary(logs, range);
    _renderChart(logs, range, period);
    _renderTopTracks(logs, range);
    _renderTopArtists(logs, range);
    _renderTopTags(logs, range);
  }

  /* ── 期間ボタン ── */
  function _bindPeriodButtons() {
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        AppState.logPeriod = btn.dataset.period;
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        render();
      });
    });
  }

  /* ── 画面に入ったときに再描画 ── */
  function _bindScreenChange() {
    EventBus.on('screen:change', s => { if (s === 'log') render(); });
  }

  function init() {
    _bindPeriodButtons();
    _bindScreenChange();
  }

  return { init, render };
})();
