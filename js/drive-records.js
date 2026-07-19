/*
 * drive-records.js
 * -----------------------------------------------------------------------
 * 「リザルトレコード」としてのデータの意味づけを担当します。
 *
 * ルート("プロセカリザルト") > "Results" フォルダの直下に、リザルト画像を
 * 曲ごとのサブフォルダに分けずフラットに保存します。曲名・レベル・難易度・
 * 判定内訳(PERFECT/GREAT/GOOD/BAD/MISS)・コンボ数などは、画像ファイルの
 * Drive カスタムプロパティ(properties)にそのまま保存します。
 * これにより、曲数×難易度の数だけフォルダを作る必要がなくなり、
 * フォルダの検索・作成コストと一覧取得の手間を大幅に削減できます
 * (Drive の properties は1エントリあたり124バイトの制限があるため、
 * 1つのJSONにまとめず複数の短いキーに分けて保存しています)。
 *
 * 以前あった「ルート > FC > "{レベル}{難易度} 曲名" フォルダ > FCファイル」という
 * 旧方式フォルダ構成の読み取り・作成サポートは廃止しました(このバージョン以降は
 * 上記の新方式のみを読み書きします。旧方式のみで保存されていたデータは一覧に
 * 表示されなくなります)。
 * -----------------------------------------------------------------------
 */

// ============================================================
// properties <-> データオブジェクト の変換
// ============================================================

function buildDriveProperties(data) {
  // 注意: item.data 上のMISS件数のフィールド名は "missDetail" (PERFECT/GREAT/GOOD/BAD/MISSの
  // 内訳のうちMISSのみを指す)。"miss" ではないので読み間違えないこと。
  const good = toInt(data.good, 0), bad = toInt(data.bad, 0), miss = toInt(data.missDetail, 0);
  const missCount = good + bad + miss;
  return {
    v: '2',
    mid: (data.musicId !== null && data.musicId !== undefined && data.musicId !== '') ? String(data.musicId) : '',
    ttl: truncateUtf8(data.title || '', 100),
    lvl: (data.level !== undefined && data.level !== null) ? String(data.level) : '',
    dif: data.diff || '',
    pf: String(toInt(data.perfect, 0)),
    gr: String(toInt(data.great, 0)),
    gd: String(good),
    bd: String(bad),
    ms: String(miss),
    mc: String(missCount),
    cb: String(toInt(data.combo, 0)),
    fc: missCount === 0 ? '1' : '0',
    dv: data.device ? truncateUtf8(data.device, 40) : '',
  };
}

function parseDriveProperties(props) {
  props = props || {};
  const good = toInt(props.gd, 0), bad = toInt(props.bd, 0), miss = toInt(props.ms, 0);
  const mcRaw = props.mc;
  const missCount = (mcRaw !== undefined && mcRaw !== '') ? toInt(mcRaw, good + bad + miss) : (good + bad + miss);
  return {
    schemaVersion: props.v || '1',
    musicId: props.mid ? toInt(props.mid, null) : null,
    title: props.ttl || '',
    level: props.lvl || '',
    diff: props.dif || '',
    perfect: toInt(props.pf, 0),
    great: toInt(props.gr, 0),
    good, bad, miss,
    missCount,
    isFC: missCount === 0,
    combo: toInt(props.cb, 0),
    device: props.dv || '',
  };
}

// ============================================================
// ファイル名の組み立て
// ============================================================

// 例: "MS29 メランコリック (FC-3) 2026-07-08.png"
function buildResultFileName(data, ext) {
  const missCount = toInt(data.good, 0) + toInt(data.bad, 0) + toInt(data.missDetail, 0);
  const resultLabel = (missCount === 0) ? 'FC' : `FC-${missCount}`;
  const dateStr = formatDateForFileName(new Date());
  const titlePart = sanitizeForFileName(data.title || '無題');
  const levelPart = (data.level !== undefined && data.level !== null && data.level !== '') ? data.level : '';
  return `${data.diff || ''}${levelPart} ${titlePart} (${resultLabel}) ${dateStr}${ext}`;
}

// ============================================================
// Drive のファイル情報 -> 統一されたレコードオブジェクトへの変換
// ============================================================

function buildRecordFromFile(file) {
  const data = parseDriveProperties(file.properties);
  return {
    id: file.id,
    parentId: cachedResultsFolderId,
    mimeType: file.mimeType || '',
    musicId: data.musicId,
    title: data.title,
    level: data.level,
    difficulty: getDiffLabel(data.diff),
    difficultyRaw: data.diff,
    perfect: data.perfect,
    great: data.great,
    good: data.good,
    bad: data.bad,
    miss: data.miss,
    missCount: data.missCount,
    isFC: data.isFC,
    combo: data.combo,
    device: data.device,
    createdTime: file.createdTime || null,
    thumbnail: file.thumbnailLink || null,
  };
}

// ============================================================
// データ取得
// ============================================================

const RECORD_FIELDS = 'id, name, createdTime, thumbnailLink, properties, mimeType';

async function fetchRecordsForRoot(rootId) {
  const resultsFolder = await getFolderByName(RESULTS_FOLDER_NAME, rootId);
  if (!resultsFolder) return [];
  cachedResultsFolderId = resultsFolder.id; // 見つかったのでキャッシュ(アップロード時の再検索を省略できる)
  const query = `'${resultsFolder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const files = await fetchAllDriveItems(query, RECORD_FIELDS);
  return files.map(f => buildRecordFromFile(f));
}

// ルートフォルダが存在しない(＝一度もアップロードしたことがない)場合は空配列を返す。
// この関数はデータ取得専用であり、フォルダを新規作成することはしない(閲覧しただけで
// 空フォルダが作られてしまうのを避けるため)。
async function fetchAllRecords() {
  const root = await findRootFolderReadOnly();
  if (!root) return [];
  return await fetchRecordsForRoot(root.id);
}

// ============================================================
// データの作成・更新
// ============================================================

// 新規アップロード。Results フォルダへ画像を保存し、properties にデータを埋め込む。
// onProgress(fraction) を渡すとアップロードのバイト単位の進捗を通知する。
async function createNewRecord(file, data, onProgress) {
  const properties = buildDriveProperties(data);
  const ext = resolveExtension(file.type, file.name);
  const fileName = buildResultFileName(data, ext);
  return await uploadFileToResults(file, properties, fileName, onProgress);
}

// 既存レコードの更新 (その場でメタデータ更新のみ。画像本体の再アップロードは不要)。
async function updateExistingRecord(item) {
  const properties = buildDriveProperties(item.data);
  const ext = resolveExtension(item.mimeType, '') || '.png';
  const fileName = buildResultFileName(item.data, ext);
  return await updateResultFileMetadata(item.originalId, fileName, properties);
}
