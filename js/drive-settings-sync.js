/*
 * drive-settings-sync.js
 * -----------------------------------------------------------------------
 * 機種プロファイル(読み取り設定)をGoogleアカウントに紐づけ、Google Drive上の
 * 「プロセカリザルト/settings.json」に自動同期する処理。
 *
 * 方針:
 *   - ログイン時に一度、Drive上の settings.json を確認する。
 *       - 存在すれば、それを「このアカウントの設定」として採用しローカル
 *         (localStorage)を上書きする。
 *       - 存在しなければ(=このアカウントで初めて使う)、ローカルの残留キャッシュを
 *         引き継がずデフォルト設定から始め、そのままDriveへアップロードして
 *         以後の同期対象にする(別アカウントの設定が混線するのを防ぐため)。
 *   - 設定が変更されるたび(device-profiles.js の saveDeviceProfiles 経由)に、
 *     自動でDriveへ書き込む。
 *
 * 「トランザクション」的な直列化について:
 * Drive の files.update は1リクエストが丸ごと1つの内容で上書きするため単体では
 * 原子的ですが、短時間に何度も設定を変更すると複数の書き込みリクエストが並行して
 * 飛び、ネットワークの遅延次第では古い内容が後から返ってきて新しい内容を
 * 上書きしてしまう(=最新の変更が失われる)おそれがあります。これを避けるため、
 * 書き込みは常に直列化し(同時に1件のみ実行)、実行中にさらに変更があった場合は
 * 完了を待ってから最新の状態でもう1回だけ追いかけて書き込みます。
 * -----------------------------------------------------------------------
 */

let settingsSyncFileId = null;     // Drive上のsettings.jsonのファイルID (未確認/未作成ならnull)
let settingsSyncInFlight = false;  // 書き込みリクエストが進行中かどうか
let settingsSyncPending = false;   // 進行中に、さらに新しい変更が来たかどうか
let settingsSyncStatus = 'idle';   // 'idle' | 'syncing' | 'synced' | 'error'
const settingsSyncListeners = [];  // 状態変化の購読者 (settings-page.js のインジケータ表示用)

function onSettingsSyncStatusChange(cb) {
  settingsSyncListeners.push(cb);
}

function setSettingsSyncStatus(status) {
  settingsSyncStatus = status;
  settingsSyncListeners.forEach(cb => {
    try { cb(status); } catch (e) { console.error(e); }
  });
}

// アカウント切り替え時に、前のアカウントのローカルキャッシュを引き継がないためのリセット。
function resetDeviceProfilesToDefault() {
  saveDeviceProfiles([seedDefaultProfile()], true);
}

// ログイン直後に1回だけ呼ぶ。Drive上の設定を確認し、ローカルへ反映する。
async function loadSettingsFromDriveOnLogin() {
  setSettingsSyncStatus('syncing');
  try {
    const root = await ensureRootFolder();
    const existing = await getFileByName(SETTINGS_FILE_NAME, root);
    if (existing) {
      settingsSyncFileId = existing.id;
      const text = await fetchDriveFileText(existing.id);
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.profiles) ? parsed.profiles : null);
      if (list && list.length > 0) {
        saveDeviceProfiles(list, true);
      } else {
        resetDeviceProfilesToDefault();
      }
      setSettingsSyncStatus('synced');
    } else {
      // このアカウントではまだ設定を同期したことが無い。ローカルの残留キャッシュ
      // (別アカウントのものである可能性がある)は採用せず、デフォルトから始めて
      // そのままDriveへアップロードし、以後の同期対象にする。
      resetDeviceProfilesToDefault();
      await pushSettingsToDrive(root);
      setSettingsSyncStatus('synced');
    }
  } catch (e) {
    console.error('設定の読み込みに失敗しました', e);
    // 読み込みに失敗した場合は、ローカルの内容(あれば)をそのまま使い続ける
    // (通信エラー時にDriveへ誤って空同期してしまわないよう、pushはしない)。
    setSettingsSyncStatus('error');
  }
}

// 設定が変更されるたびに device-profiles.js から呼ばれる。直列化されたDrive同期を要求する。
function requestSettingsSync() {
  if (!isGoogleSignedIn()) return; // 未ログイン時は同期しない(読み取り設定はログイン後のみ表示・変更可能なため通常発生しない)
  if (settingsSyncInFlight) { settingsSyncPending = true; return; }
  runSettingsSync();
}

async function runSettingsSync() {
  settingsSyncInFlight = true;
  setSettingsSyncStatus('syncing');
  try {
    const rootId = await ensureRootFolder();
    await pushSettingsToDrive(rootId);
    setSettingsSyncStatus('synced');
  } catch (e) {
    console.error('設定のDrive同期に失敗しました', e);
    setSettingsSyncStatus('error');
  } finally {
    settingsSyncInFlight = false;
    if (settingsSyncPending) {
      settingsSyncPending = false;
      runSettingsSync();
    }
  }
}

async function pushSettingsToDrive(rootId) {
  const list = getDeviceProfiles();
  const content = JSON.stringify({ type: 'prsk-device-profiles', version: 1, profiles: list }, null, 2);
  if (!settingsSyncFileId) {
    const existing = await getFileByName(SETTINGS_FILE_NAME, rootId);
    if (existing) settingsSyncFileId = existing.id;
  }
  if (settingsSyncFileId) {
    await updateDriveTextFileContent(settingsSyncFileId, content, 'application/json');
  } else {
    const created = await createDriveTextFile(SETTINGS_FILE_NAME, rootId, content, 'application/json');
    settingsSyncFileId = created.id;
  }
}

// ログアウト時に呼ぶ。次のログイン(同じ/別アカウントいずれも)で正しく再判定できるようにする。
function resetSettingsSyncState() {
  settingsSyncFileId = null;
  settingsSyncInFlight = false;
  settingsSyncPending = false;
  setSettingsSyncStatus('idle');
}
