/*
 * settings-sync.js
 * -----------------------------------------------------------------------
 * 機種プロファイル(読み取り設定)を Google Drive 上の settings.json と同期し、
 * 同じGoogleアカウントであればブラウザ・端末が変わっても同じ読み取り設定を使える
 * ようにします。
 *
 *   - ログイン直後 (pullOrInitSettingsFromDrive): Driveに settings.json が既にあれば
 *     それを取得してローカルへ反映する(Driveを正とする)。無ければ、現在のローカル設定を
 *     初回データとしてDriveへアップロードする(以前からこのアプリを使っていたユーザーの
 *     設定を失わないため)。
 *   - 設定変更のたび (onDeviceProfilesChanged): device-profiles.js 側の保存処理から
 *     フックされ、自動的にDriveへ書き込む。連続保存(インポート操作など)で同期リクエストが
 *     競合しないよう、settingsSyncInFlight で直列化している。
 *
 * サーバーを持たない静的サイトのため、Drive上の1ファイルをそのまま「サーバー」代わりに
 * 使う簡易な設計です。複数端末からの秒単位の同時編集までは考慮しておらず、最後に書き込んだ
 * 内容が残ります(個人〜少人数利用を想定した現実的な割り切り)。同期の成功・失敗は
 * settingsSyncState を通じて設定モーダルのバッジに反映されます(settings-page.js 側)。
 * -----------------------------------------------------------------------
 */

function setSettingsSyncState(newState) {
  settingsSyncState = newState;
  if (typeof onSettingsSyncStateChanged === 'function') onSettingsSyncStateChanged(newState);
}

// ログイン直後に1回だけ呼ぶ。Driveとローカルのどちらを正とするかを決めて初期同期する。
async function pullOrInitSettingsFromDrive() {
  if (!currentAccountKey) return;
  setSettingsSyncState('syncing');
  try {
    const { rootId } = await ensureRootAndResultsFolders();
    const existing = await getFileByName(SETTINGS_FILE_NAME, rootId);

    if (existing) {
      cachedSettingsFileId = existing.id;
      const remote = await downloadJsonFile(existing.id);
      if (remote && Array.isArray(remote.deviceProfiles) && remote.deviceProfiles.length > 0) {
        saveDeviceProfiles(remote.deviceProfiles, { skipSync: true });
        // 設定モーダルが既に開かれていた場合(直前に開かれた等のタイミング差)に備えて、
        // 表示中の内容をこの最新データへ更新する。まだ一度も開かれていなければ何もしない
        // (次に開かれた際にどのみち最新値が使われるため)。
        if (typeof onProfilesUpdatedExternally === 'function') onProfilesUpdatedExternally();
      }
    } else {
      // Driveにまだ設定ファイルが無い(このアカウントで初回、または旧バージョンからの移行) ->
      // 現在のローカル設定(無ければ既定値)を初期データとしてアップロードする。
      const local = getDeviceProfiles();
      const created = await createJsonFile(SETTINGS_FILE_NAME, rootId, {
        deviceProfiles: local, syncedAt: new Date().toISOString(),
      });
      cachedSettingsFileId = created.id;
    }
    setSettingsSyncState('synced');
  } catch (e) {
    console.error('設定の初期同期に失敗しました', e);
    setSettingsSyncState('error');
  }
}

// device-profiles.js の saveDeviceProfiles() から呼ばれるフック。設定を変更するたびに実行される。
function onDeviceProfilesChanged(list) {
  if (!currentAccountKey) return; // 未ログイン時はDrive同期先が無いため何もしない
  settingsSyncInFlight = (settingsSyncInFlight || Promise.resolve())
    .catch(() => {}) // 前回の同期が失敗していても、後続の同期は止めない
    .then(() => pushSettingsToDrive(list));
}

async function pushSettingsToDrive(list) {
  setSettingsSyncState('syncing');
  try {
    const { rootId } = await ensureRootAndResultsFolders();
    const payload = { deviceProfiles: list, syncedAt: new Date().toISOString() };

    if (!cachedSettingsFileId) {
      const existing = await getFileByName(SETTINGS_FILE_NAME, rootId);
      cachedSettingsFileId = existing ? existing.id : null;
    }

    if (cachedSettingsFileId) {
      await updateJsonFileContent(cachedSettingsFileId, payload);
    } else {
      const created = await createJsonFile(SETTINGS_FILE_NAME, rootId, payload);
      cachedSettingsFileId = created.id;
    }
    setSettingsSyncState('synced');
  } catch (e) {
    console.error('設定のGoogle Drive同期に失敗しました', e);
    setSettingsSyncState('error');
  }
}

// 同期エラー時に設定モーダルの「再試行」から呼ぶ。
function retrySettingsSync() {
  onDeviceProfilesChanged(getDeviceProfiles());
}
