/*
 * selection-mode.js
 * -----------------------------------------------------------------------
 * カードの複数選択モードと一括削除。
 * 一括削除は、一部の項目が失敗しても残りの削除を最後まで試み、成功・失敗の件数を
 * まとめて報告する(先頭の失敗で処理全体が止まらないようにするため)。
 * -----------------------------------------------------------------------
 */

function toggleSelectMode() {
  isSelectMode = !isSelectMode;
  const btn = document.getElementById('btn-select-mode');
  if (isSelectMode) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
    selectedIds.clear();
    updateSelectionUI();
  }
  renderGrid(filteredRecords);
}

function toggleSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);

  const card = document.getElementById(`card-${id}`);
  if (card) {
    if (selectedIds.has(id)) card.classList.add('selected');
    else card.classList.remove('selected');
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const bar = document.getElementById('batch-actions');
  const countSpan = document.getElementById('selected-count');
  countSpan.innerText = selectedIds.size;
  if (selectedIds.size > 0) {
    bar.style.display = 'flex';
  } else {
    bar.style.display = 'none';
  }
}

function clearSelection() {
  selectedIds.clear();
  updateSelectionUI();
  renderGrid(filteredRecords);
}

// Individual Actions (Non-Select Mode)
function individualEdit(id) {
  selectedIds.clear();
  selectedIds.add(id);
  batchEdit();
}

async function individualDelete(id) {
  if (!confirm("このリザルトを削除しますか？")) return;
  const loader = document.getElementById('loader');
  loader.style.display = 'flex';
  document.getElementById('grid').innerHTML = '';
  try {
    await deleteDriveFile(id);
    alert("削除しました");
    await fetchDataFromDrive();
  } catch (e) {
    alert("エラー: " + e.message);
    fetchDataFromDrive();
  }
}

async function batchDelete() {
  if (!confirm(`選択した ${selectedIds.size} 件を削除しますか？`)) return;
  const loader = document.getElementById('loader');
  loader.style.display = 'flex';
  document.getElementById('grid').innerHTML = '';

  // 1件失敗しても残りは最後まで試みる(先頭の失敗で処理全体が止まり、後続が未削除のまま
  // 放置されるのを防ぐ)。成功・失敗の件数を最後にまとめて報告する。
  const ids = Array.from(selectedIds);
  const results = await Promise.allSettled(ids.map(id => deleteDriveFile(id)));
  const failedCount = results.filter(r => r.status === 'rejected').length;
  const successCount = results.length - failedCount;

  if (failedCount === 0) {
    alert(`削除しました (${successCount}件)`);
  } else {
    console.error('削除に失敗した項目があります', results.filter(r => r.status === 'rejected'));
    alert(`${successCount}件削除しました。${failedCount}件は削除に失敗しました。もう一度お試しください。`);
  }
  selectedIds.clear();
  updateSelectionUI();
  await fetchDataFromDrive();
}
