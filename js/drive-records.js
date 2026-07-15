/*
 * drive-records.js
 * -----------------------------------------------------------------------
 * 「リザルトレコード」としてのデータの意味づけを担当します。
 *
 * ■ 新方式 (このバージョンから)
 *   ルート("プロセカリザルト") > "Results" フォルダの直下に、リザルト画像を
 *   曲ごとのサブフォルダに分けずフラットに保存します。曲名・レベル・難易度・
 *   判定内訳(PERFECT/GREAT/GOOD/BAD/MISS)・コンボ数などは、画像ファイルの
 *   Drive カスタムプロパティ(properties)にそのまま保存します。
 *   これにより、曲数×難易度の数だけフォルダを作る必要がなくなり、
 *   フォルダの検索・作成コストと一覧取得の手間を大幅に削減できます
 *   (Drive の properties は1エントリあたり124バイトの制限があるため、
 *   1つのJSONにまとめず複数の短いキーに分けて保存しています)。
 *
 * ■ 旧方式 (後方互換のための読み取り専用サポート)
 *   これまで運用してきた「ルート > FC > "{レベル}{難易度} 曲名" フォルダ > FCファイル」
 *   という構成のデータも引き続き一覧に表示されるよう読み込みます。
 *   旧データを編集して保存すると、その時点で新方式(Resultsフォルダ)へ
 *   自動的に移行されます(画像本体はそのまま・移動のみなので再アップロード不要)。
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
// 旧方式(フォルダ名)の解析 - 元のindex.htmlの処理を踏襲
// ============================================================

function parseLegacyFolderTitle(folderName) {
  const regex = /^(\d+)([AMEH])\s+(.+)$/;
  const match = folderName.match(regex);
  if (!match) return null;
  const newCode = LEGACY_DIFF_CODE_MAP[match[2]];
  if (!newCode) return null;
  return { level: parseInt(match[1], 10), difficultyRaw: newCode, title: match[3] };
}

function parseLegacyScore(fileName) {
  const match = fileName.match(/^FC(?:-(\d+))?/);
  return match ? (match[1] === undefined ? 0 : parseInt(match[1], 10)) : null;
}

// ============================================================
// Drive のファイル情報 -> 統一されたレコードオブジェクトへの変換
// ============================================================

function buildRecordFromNewFile(file) {
  const data = parseDriveProperties(file.properties);
  return {
    id: file.id,
    schema: 'new',
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

function buildRecordFromLegacyFile(file, folderInfo) {
  const missCount = parseLegacyScore(file.name);
  return {
    id: file.id,
    schema: 'legacy',
    parentId: folderInfo.folderId,
    mimeType: file.mimeType || '',
    musicId: null,
    title: folderInfo.title,
    level: folderInfo.level,
    difficulty: getDiffLabel(folderInfo.difficultyRaw),
    difficultyRaw: folderInfo.difficultyRaw,
    // 旧データは判定内訳・コンボ数を記録していなかったため不明(0)として扱う。
    // ミス数の合計だけはファイル名から分かるため、そちらは正しい値を保持する。
    perfect: 0, great: 0, good: 0, bad: 0, miss: 0,
    missCount: (missCount !== null ? missCount : 0),
    isFC: (missCount === 0),
    combo: 0,
    device: '',
    createdTime: file.createdTime || null,
    thumbnail: file.thumbnailLink || null,
  };
}

// ============================================================
// データ取得
// ============================================================

const NEW_RECORD_FIELDS = 'id, name, createdTime, thumbnailLink, properties, mimeType';
const LEGACY_RECORD_FIELDS = 'id, name, parents, thumbnailLink, createdTime, mimeType';

async function fetchNewSchemeRecordsForRoot(rootId) {
  const resultsFolder = await getFolderByName(RESULTS_FOLDER_NAME, rootId);
  if (!resultsFolder) return [];
  cachedResultsFolderId = resultsFolder.id; // 見つかったのでキャッシュ(アップロード時の再検索を省略できる)
  const query = `'${resultsFolder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const files = await fetchAllDriveItems(query, NEW_RECORD_FIELDS);
  return files.map(f => buildRecordFromNewFile(f));
}

async function fetchLegacyRecords(rootId) {
  const legacyFolder = await findLegacyFolder(rootId);
  if (!legacyFolder) return [];

  const folderQuery = `'${legacyFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const songFolders = await fetchAllDriveItems(folderQuery, "id, name");
  if (songFolders.length === 0) return [];

  const folderMap = new Map();
  songFolders.forEach(folder => {
    const metadata = parseLegacyFolderTitle(folder.name);
    if (metadata) folderMap.set(folder.id, { ...metadata, folderId: folder.id });
  });
  if (folderMap.size === 0) return [];

  // 旧バージョンと同じ検索方法(ファイル名に'FC'を含むもの)を踏襲しています。
  const fileQuery = `name contains 'FC' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const candidateFiles = await fetchAllDriveItems(fileQuery, LEGACY_RECORD_FIELDS);

  const records = [];
  candidateFiles.forEach(file => {
    if (!file.parents || file.parents.length === 0) return;
    const parentId = file.parents.find(p => folderMap.has(p));
    if (parentId) records.push(buildRecordFromLegacyFile(file, folderMap.get(parentId)));
  });
  return records;
}

// ルートフォルダが存在しない(＝一度もアップロードしたことがない)場合は空配列を返す。
// この関数はデータ取得専用であり、フォルダを新規作成することはしない(閲覧しただけで
// 空フォルダが作られてしまうのを避けるため)。
async function fetchAllRecords() {
  const root = await findRootFolderReadOnly();
  if (!root) return [];
  const [newRecords, legacyRecords] = await Promise.all([
    fetchNewSchemeRecordsForRoot(root.id),
    fetchLegacyRecords(root.id),
  ]);
  return newRecords.concat(legacyRecords);
}

// ============================================================
// データの作成・更新
// ============================================================

// 新規アップロード。Results フォルダへ画像を保存し、properties にデータを埋め込む。
async function createNewRecord(file, data) {
  const properties = buildDriveProperties(data);
  const ext = resolveExtension(file.type, file.name);
  const fileName = buildResultFileName(data, ext);
  return await uploadFileToResults(file, properties, fileName);
}

// 既存レコードの更新。新方式はその場でメタデータ更新のみ、旧方式は Results フォルダへの
// 移動を伴う(＝この保存操作をもって新方式へ移行される)。
async function updateExistingRecord(item) {
  const properties = buildDriveProperties(item.data);
  const ext = resolveExtension(item.mimeType, '') || '.png';
  const fileName = buildResultFileName(item.data, ext);

  let moveParams = null;
  if (item.schema === 'legacy') {
    const { resultsId } = await ensureRootAndResultsFolders();
    moveParams = { addParents: resultsId, removeParents: item.originalParent };
  }
  return await updateResultFileMetadata(item.originalId, fileName, properties, moveParams);
}
