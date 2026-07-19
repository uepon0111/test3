/*
 * selection-mode.js
 * -----------------------------------------------------------------------
 * カードの複数選択モードと一括削除。処理内容は元のindex.htmlから変更していません。
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

  try {
    for (const id of selectedIds) {
      await deleteDriveFile(id);
    }
    alert("削除しました");
    selectedIds.clear();
    updateSelectionUI();
    await fetchDataFromDrive();
  } catch (e) {
    alert("削除エラー: " + e.message);
    fetchDataFromDrive();
  }
}
