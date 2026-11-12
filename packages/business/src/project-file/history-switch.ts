/** Whole-history replacement. Only the kernel opens the SQLite files; the
 * host holds project exclusivity and supplies application write admission. */
import {createHash} from 'node:crypto';
import {chmodSync, closeSync, constants, lstatSync, openSync, renameSync, rmSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {PROJECT_HISTORY_FILE} from '../../../contracts/src/project-file.ts';
import {readPrivateFile, validateManagedFile, validatePrivateDirectory, writePrivateFileAtomic} from '../../../contracts/src/private-storage.ts';
import {projectHistoryResolveResultSchema} from '../../../contracts/src/project-history-recovery.ts';
import {projectHistorySwitchIntentSchema as intentSchema, projectHistorySwitchActiveSchema as activeSchema} from '../../../contracts/src/project-history-recovery-records.ts';
import type {ProjectHistorySwitchIntent as Intent} from '../../../contracts/src/project-history-recovery-records.ts';
import type {HistoryFileIdentity, ProjectHistoryResolveInput, ProjectHistoryResolveResult} from '../../../contracts/src/project-history-recovery.ts';
import {buildDatabase, FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from './schema/databases.ts';
import type {ProjectFileFormat} from './schema/databases.ts';
import {clearProjectProcessRevisions} from './schema/history-upgrades.ts';
import {isProjectStore, openStagedProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';
import type {Format4Options, ProjectLocation} from './connection.ts';
import {inspectProjectFormatReadOnly, recoverProjectFile} from './connection.ts';
import {projectFileError} from './errors.ts';
import {readProjectContentStamp} from './content-stamp.ts';
import {syncCopiedDirectory, syncCopiedFile} from './backup.ts';
import {copyProjectVersionsInside} from '../project-versions/copy.ts';
import {createProjectVersions} from '../project-versions/service.ts';
import {canonicalJson, readSnapshotProjectFormat} from '../project-versions/document.ts';

const MAX_INTENT = 16 * 1024;
const ACTIVE = 'history-switch-active.json';
export type HistorySwitchBoundary = 'prepared' | 'copy-started' | 'staged' | 'before-commit' | 'after-commit' | 'committed' | 'before-archive' | 'archived' | 'before-publish' | 'published' | 'completed';
export interface HistorySwitchOptions {
  readonly projectFile: string;
  readonly location: ProjectLocation;
  readonly assertMutationAllowed: () => void;
  readonly format4?: Format4Options;
  /** Trusted crash tests, never an HTTP/environment-controlled hook. */
  readonly onBoundary?: (boundary: HistorySwitchBoundary) => void;
}
const failure = (message: string, code = 'PROJECT_HISTORY_SWITCH_INVALID'): AppError => new AppError(code, message, 409);
function historyVersionForProject(format: ProjectFileFormat, projectId: string, options: HistorySwitchOptions): number {
  if (format !== FORMAT4_PROJECT_SCHEMA_VERSION) return HISTORY_SCHEMA_VERSION;
  if (!options.format4) throw projectFileError('PROJECT_FORMAT_NEWER', {database: 'project', reason: 'format-newer', projectId,
    formatVersion: format, supportedFormatVersion: PROJECT_FILE_SCHEMA_VERSION});
  return FORMAT4_HISTORY_SCHEMA_VERSION;
}
const exists = (file: string): boolean => lstatSync(file, {throwIfNoEntry: false}) !== undefined;
const sameId = (file: string, identity: {dev: string; ino: string}): boolean => {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  return Boolean(info?.isFile() && String(info.dev) === identity.dev && String(info.ino) === identity.ino);
};
export function projectHistoryFileIdentity(file: string): HistoryFileIdentity {
  const info = lstatSync(file, {bigint: true});
  if (!info.isFile()) throw failure('本机记录不是普通文件，未处置。');
  return {dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs)};
}
export const historyResolutionDigest = (input: ProjectHistoryResolveInput): string => createHash('sha256').update(canonicalJson(input)).digest('hex');
const intentName = (id: string): string => `history-switch-${id}.json`;
const stagedName = (id: string): string => `history.staged-${id}.db`;
function read(root: string, name: string): unknown | null {
  const text = readPrivateFile(path.join(root, name), {root, allowMissing: true, maxBytes: MAX_INTENT, encoding: 'utf8'});
  if (text === null) return null;
  try { return JSON.parse(String(text)); } catch { throw failure('本机处置记录损坏，已保留所有文件。'); }
}
function write(root: string, name: string, value: unknown): void {
  writePrivateFileAtomic(path.join(root, name), JSON.stringify(value), {root, maxBytes: MAX_INTENT});
  syncCopiedDirectory(root);
}
function readIntent(root: string, requestId: string): Intent | null {
  const raw = read(root, intentName(requestId));
  if (raw === null) return null;
  const value = intentSchema.safeParse(raw);
  if (!value.success || value.data.input.requestId !== requestId || historyResolutionDigest(value.data.input) !== value.data.digest) throw failure('本机处置记录无效，已保留所有文件。');
  return value.data;
}
function active(root: string): string | null {
  const raw = read(root, ACTIVE);
  if (raw === null) return null;
  const value = activeSchema.safeParse(raw);
  if (!value.success) throw failure('未完成的处置记录无效，已保留所有文件。');
  return value.data.requestId;
}
function clearActive(root: string, requestId: string): void {
  if (active(root) !== requestId) return;
  rmSync(path.join(root, ACTIVE)); syncCopiedDirectory(root);
}
function checkProject(options: HistorySwitchOptions, intent: Intent): void {
  options.assertMutationAllowed();
  if (!sameId(options.projectFile, intent.projectIdentity)) throw failure('项目文件身份已变化，未处置。', 'PROJECT_HISTORY_BASELINE_CHANGED');
}
/** Inspect the staged evidence before taking a write connection when the
 * project pair differs from the prepared input. Without this proof, even a
 * rejected CAS must not create and remove a staged rollback journal. */
function provesCommittedStage(staged: string, root: string, intent: Intent, current: {contentSequence: number; contentToken: string}): boolean {
  validateManagedFile(staged, {root, private: true});
  const db = new DatabaseSync(staged, {readOnly: true, timeout: 0, defensive: true});
  try {
    const row = db.prepare('SELECT requestId,digest,CASE WHEN length(CAST(result AS BLOB))<=16384 THEN result END AS result FROM project_history_resolution WHERE singleton=1').get();
    if (!row || row.requestId !== intent.input.requestId || row.digest !== intent.digest || typeof row.result !== 'string') return false;
    const result = projectHistoryResolveResultSchema.safeParse(JSON.parse(row.result));
    return result.success && result.data.projectId === intent.input.projectId && result.data.requestId === intent.input.requestId
      && result.data.archive === intent.archive && result.data.action === intent.input.action
      && result.data.content.contentSequence === current.contentSequence && result.data.content.contentToken === current.contentToken;
  } catch {return false;} finally {db.close();}
}

/** Read an already committed receipt without touching the project connection.
 * Later edits never turn confirmation replay into a second restore. */
export function completedHistoryResolution(options: HistorySwitchOptions, input: ProjectHistoryResolveInput): ProjectHistoryResolveResult | null {
  const intent = readIntent(options.location.localDir, input.requestId);
  if (!intent) return null;
  if (intent.digest !== historyResolutionDigest(input)) throw failure('请求 ID 已用于不同的处置。', 'REQUEST_ID_REUSED');
  checkProject(options, intent);
  return intent.phase === 'completed' ? intent.result : null;
}

/** Build a private, empty execution history while the original owner still
 * holds both files. A partial prepared stage can be discarded safely: the
 * content transaction cannot start before `staged` is durably recorded. */
export function prepareHistorySwitch(store: ProjectStore, input: ProjectHistoryResolveInput, options: HistorySwitchOptions): void {
  const root = options.location.localDir, requestId = input.requestId;
  if (!isProjectStore(store) || store.projectFile !== path.resolve(options.projectFile) || store.localDir !== path.resolve(root) || store.projectId !== input.projectId)
    throw new TypeError('History replacement requires the live project and history owner');
  const historyVersion = historyVersionForProject(readSnapshotProjectFormat(store.db), store.projectId, options);
  validatePrivateDirectory(root);
  const old = readIntent(root, requestId);
  if (old && old.digest !== historyResolutionDigest(input)) throw failure('请求 ID 已用于不同的处置。', 'REQUEST_ID_REUSED');
  const pending = active(root);
  if (pending !== null && pending !== requestId) throw failure('另一个本机记录处置尚未结束。', 'PROJECT_HISTORY_SWITCH_PENDING');
  if (old && old.phase !== 'prepared') {write(root, ACTIVE, {requestId}); return;}
  if (store.historyState !== 'diverged') throw failure('项目已不再需要处置，请重新读取状态。', 'PROJECT_HISTORY_BASELINE_CHANGED');
  options.assertMutationAllowed();
  const history = path.join(root, PROJECT_HISTORY_FILE);
  const observed = projectHistoryFileIdentity(history);
  if (canonicalJson(observed) !== canonicalJson(input.historyIdentity) || canonicalJson(readProjectContentStamp(store.db)) !== canonicalJson(input.expected)) throw failure('项目内容或本机记录已变化，请重新确认。', 'PROJECT_HISTORY_BASELINE_CHANGED');
  const projectIdentity = projectHistoryFileIdentity(options.projectFile);
  const intent: Intent = old ?? {version: 1, input, digest: historyResolutionDigest(input), projectIdentity: {dev: projectIdentity.dev, ino: projectIdentity.ino},
    sourceIdentity: observed, archive: `history-${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}-${requestId}.db`,
    phase: 'prepared', stagedIdentity: null, result: null};
  checkProject(options, intent);
  write(root, intentName(requestId), intent); write(root, ACTIVE, {requestId}); options.onBoundary?.('prepared');
  const staged = path.join(root, stagedName(requestId));
  // This phase has never been attached to the project or used for restore.
  for (const file of [staged, `${staged}-journal`]) if (exists(file)) {validateManagedFile(file, {root, private: true}); rmSync(file);}
  const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd);
  const target = new DatabaseSync(staged, {enableForeignKeyConstraints: true, timeout: 0, defensive: true});
  try {
    target.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    buildDatabase(target, 'history', 'main', undefined, historyVersion);
    target.prepare('INSERT INTO history_state(singleton,projectId,seenContentSequence,seenContentToken) VALUES(1,?,?,?)').run(store.projectId, input.expected.contentSequence, input.expected.contentToken);
    options.onBoundary?.('copy-started');
    copyProjectVersionsInside(store.db, target, {projectId: store.projectId});
    options.assertMutationAllowed();
    target.exec('COMMIT');
  } finally { if (target.isTransaction) target.exec('ROLLBACK'); target.close(); }
  syncCopiedFile(staged); syncCopiedDirectory(root);
  const stagedIdentity = projectHistoryFileIdentity(staged);
  intent.stagedIdentity = {dev: stagedIdentity.dev, ino: stagedIdentity.ino}; intent.phase = 'staged';
  write(root, intentName(requestId), intent); options.onBoundary?.('staged');
}

/** Called before ordinary history admission (and before missing-history can
 * mean fresh). The staged database contains commit evidence in the same
 * super-journal transaction as an optional V1 restore. */
export function recoverHistorySwitch(options: HistorySwitchOptions): ProjectHistoryResolveResult | null {
  const root = options.location.localDir, requestId = active(root);
  if (requestId === null) return null;
  const intent = readIntent(root, requestId);
  if (!intent) throw failure('缺少未完成处置的记录，已保留所有文件。');
  checkProject(options, intent);
  // This entry runs before the normal opener. Preserve the same format gate
  // even for a prepared switch: replacing the file with an old/forged format
  // must not clear a pointer or rename any local record first.
  const recovery = recoverProjectFile(options.projectFile, options.format4 ? FORMAT4_PROJECT_SCHEMA_VERSION : PROJECT_FILE_SCHEMA_VERSION);
  if (recovery.state === 'invalid' || recovery.state === 'locked' || recovery.state === 'missing' || recovery.state === 'open-here' || recovery.state === 'access-denied') throw failure('项目文件暂不能安全完成本机记录切换，已保留所有文件。');
  const project = inspectProjectFormatReadOnly(options.projectFile);
  const historyVersion = historyVersionForProject(project.formatVersion, project.projectId, options);
  if (project.projectId !== intent.input.projectId) throw failure('项目身份已变化，已保留所有文件。', 'PROJECT_HISTORY_BASELINE_CHANGED');
  if (intent.phase === 'prepared') {
    const original = projectHistoryFileIdentity(path.join(root, PROJECT_HISTORY_FILE));
    if (canonicalJson(original) !== canonicalJson(intent.sourceIdentity)
      || project.contentSequence !== intent.input.expected.contentSequence || project.contentToken !== intent.input.expected.contentToken) {
      throw failure('项目或本机记录在复制前变化，已保留所有文件。', 'PROJECT_HISTORY_BASELINE_CHANGED');
    }
    clearActive(root, requestId);
    return null;
  }
  const history = path.join(root, PROJECT_HISTORY_FILE), staged = path.join(root, stagedName(requestId)), archive = path.join(root, intent.archive);
  if (intent.phase === 'completed') {clearActive(root, requestId); return intent.result;}
  if (intent.result && (project.contentSequence !== intent.result.content.contentSequence || project.contentToken !== intent.result.content.contentToken)) {
    throw failure('项目在本机记录发布前变化，已保留所有文件。', 'PROJECT_HISTORY_BASELINE_CHANGED');
  }
  if (!intent.stagedIdentity) throw failure('缺少暂存记录身份，已保留所有文件。');
  if (intent.phase === 'staged') {
    if (!sameId(staged, intent.stagedIdentity) || !sameId(history, intent.sourceIdentity)) throw failure('处置中的本机记录身份已变化。');
    if (canonicalJson(projectHistoryFileIdentity(history)) !== canonicalJson(intent.sourceIdentity)) throw failure('本机记录在复制后变化，未处置。', 'PROJECT_HISTORY_BASELINE_CHANGED');
    if ((project.contentSequence !== intent.input.expected.contentSequence || project.contentToken !== intent.input.expected.contentToken)
      && !provesCommittedStage(staged, root, intent, project)) throw failure('项目在复制后变化，未处置。', 'PROJECT_HISTORY_BASELINE_CHANGED');
    const store = openStagedProjectStore({projectFile: options.projectFile, location: options.location, historyFile: staged, expectedStamp: intent.input.expected,
      resolution: {requestId, digest: intent.digest}, ...(historyVersion === FORMAT4_HISTORY_SCHEMA_VERSION ? {format4: options.format4} : {})});
    try {
      const previous = store.db.prepare('SELECT requestId,digest,result FROM project_history_resolution WHERE singleton=1').get();
      if (previous) {
        if (previous.requestId !== requestId || previous.digest !== intent.digest) throw failure('暂存提交证据不属于本次处置。');
        intent.result = projectHistoryResolveResultSchema.parse(JSON.parse(String(previous.result)));
      } else {
        const recordCommit = (): void => {
          checkProject(options, intent!);
          const input = intent!.input;
          intent!.result = projectHistoryResolveResultSchema.parse({projectId: input.projectId, requestId, action: input.action, archive: intent!.archive,
            content: readProjectContentStamp(store.db), activation: 'pending'});
          store.db.prepare('INSERT INTO project_history_resolution(singleton,requestId,digest,result) VALUES(1,?,?,?)').run(requestId, intent!.digest, JSON.stringify(intent!.result));
          checkProject(options, intent!); options.onBoundary?.('before-commit');
        };
        const input = intent.input;
        if (input.action === 'restore-version') createProjectVersions(store, {assertMutationAllowed: options.assertMutationAllowed, executionDomain: 'empty',
          afterRestoreApplyInside: () => clearProjectProcessRevisions(store.db, input.projectId), beforeRestoreCommit: recordCommit}).restore({
          projectId: input.projectId, requestId, versionId: input.versionId, expectedContentSequence: input.expected.contentSequence,
          expectedContentToken: input.expected.contentToken, previewDigest: input.previewDigest,
        });
        else store.tx(() => {clearProjectProcessRevisions(store.db, input.projectId); recordCommit();});
        options.onBoundary?.('after-commit');
      }
    } finally {store.close();}
    syncCopiedFile(staged); syncCopiedDirectory(root);
    intent.phase = 'committed'; write(root, intentName(requestId), intent); options.onBoundary?.('committed');
  }
  checkProject(options, intent);
  if (intent.phase === 'committed') {
    options.onBoundary?.('before-archive');
    if (exists(archive)) {
      if (!sameId(archive, intent.sourceIdentity) || exists(history)) throw failure('归档目标已占用，未覆盖任何文件。');
    } else {
      if (!sameId(history, intent.sourceIdentity)) throw failure('原本机记录身份已变化，未覆盖任何文件。');
      renameSync(history, archive); syncCopiedDirectory(root);
    }
    chmodSync(archive, 0o400); syncCopiedFile(archive); syncCopiedDirectory(root);
    intent.phase = 'archived'; write(root, intentName(requestId), intent); options.onBoundary?.('archived');
  }
  if (intent.phase === 'archived') {
    checkProject(options, intent); options.onBoundary?.('before-publish');
    if (!sameId(archive, intent.sourceIdentity)) throw failure('归档身份已变化，已保留所有文件。');
    if (exists(history)) {
      if (!sameId(history, intent.stagedIdentity)) throw failure('本机记录目标已占用，未覆盖任何文件。');
    } else {
      if (!sameId(staged, intent.stagedIdentity)) throw failure('暂存本机记录身份已变化。');
      renameSync(staged, history); syncCopiedDirectory(root);
    }
    options.onBoundary?.('published');
    intent.phase = 'completed'; write(root, intentName(requestId), intent); options.onBoundary?.('completed');
  }
  clearActive(root, requestId);
  return intent.result;
}

/** Prepared is safe to present as a recovery session again. No content
 * transaction exists yet; only the same request may finish that stage. */
export function hasPreparedHistorySwitch(location: ProjectLocation): boolean {
  const requestId = active(location.localDir);
  return requestId !== null && readIntent(location.localDir, requestId)?.phase === 'prepared';
}
