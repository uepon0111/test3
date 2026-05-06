'use strict';
/* ================================================
   App  –  top-level controller & routing
   ================================================ */
const App = {

  /* ── Boot ── */
  async init() {
    try {
      await DB.open();
    } catch (err) {
      alert('Storage unavailable: ' + err.message +
            '\n\nPlease ensure the page is served over HTTPS or localhost.');
      return;
    }

    Tags.init();
    List.init();
    Player.init();

    List.renderTagFilterBar();
    List.renderFileList();
    this.showScreen('screen-list');
  },

  /* ── Screen routing ── */
  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.toggle('active', s.id === id);
    });
  },

  /* ── Open player ── */
  async openPlayer(fileId) {
    await Player.openPlayer(fileId);
  },

  /* ── Add video file ── */
  async addFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file.');
      return;
    }

    Loading.show('Adding video…');
    try {
      const id   = crypto.randomUUID();
      /* Strip extension for a clean default display name */
      const name = file.name.replace(/\.[^/.]+$/, '') || file.name;

      await DB.saveVideo(id, file);

      Storage.addFile({
        id,
        name,
        tagIds:  [],
        markers: [],
        loop:    null,
        addedAt: Date.now()
      });

      List.renderTagFilterBar();
      List.renderFileList();
    } catch (err) {
      alert('Failed to add video:\n' + err.message);
    } finally {
      Loading.hide();
    }
  },

  /* ── Delete video file ── */
  async deleteFile(fileId) {
    Loading.show('Deleting video…');
    try {
      await DB.deleteVideo(fileId);
      Storage.deleteFile(fileId);
      List.renderFileList();
    } catch (err) {
      alert('Failed to delete video:\n' + err.message);
    } finally {
      Loading.hide();
    }
  },

  /* ── Refresh UI after tag changes ── */
  refreshAll() {
    List.renderTagFilterBar();
    List.renderFileList();
  }
};

/* ── Start ── */
document.addEventListener('DOMContentLoaded', () => App.init());
