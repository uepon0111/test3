/**
 * trash.js — ゴミ箱管理・3日自動削除
 */
const Trash = (() => {
  const DAYS_MS = CONFIG.TRASH_DAYS * 24 * 60 * 60 * 1000;

  /** Move result to trash */
  async function moveToTrash(resultId) {
    await DB.moveToTrash(resultId);
  }

  /** Restore from trash */
  async function restore(trashId) {
    await DB.restoreFromTrash(trashId);
  }

  /** Permanently delete one item */
  async function permanentlyDelete(trashId) {
    const item = await DB.getTrashItem(trashId);
    if (!item) return;

    // Delete from Drive if connected
    if (item.driveFileId) {
      try { await Drive.deleteFile(item.driveFileId); } catch (e) { /* ignore */ }
    }

    await DB.deleteTrash(trashId);
  }

  /** Auto-delete items older than 3 days */
  async function runAutoDelete() {
    const items = await DB.getAllTrash();
    const now   = Date.now();
    for (const item of items) {
      if (item.deletedAt && (now - new Date(item.deletedAt).getTime()) > DAYS_MS) {
        await permanentlyDelete(item.id);
      }
    }
  }

  /** Empty entire trash */
  async function emptyTrash() {
    const items = await DB.getAllTrash();
    for (const item of items) {
      await permanentlyDelete(item.id);
    }
  }

  /** Get days remaining before permanent delete */
  function daysRemaining(deletedAt) {
    const elapsed = Date.now() - new Date(deletedAt).getTime();
    return Math.max(0, Math.ceil((DAYS_MS - elapsed) / (24 * 60 * 60 * 1000)));
  }

  return { moveToTrash, restore, permanentlyDelete, runAutoDelete, emptyTrash, daysRemaining };
})();
