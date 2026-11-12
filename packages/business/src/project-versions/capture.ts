import {taskEffectOrigin} from '../agent/task-effects-v2.ts';
import type {AgentTaskEffectOrigin} from '../agent/task-effects-v2.ts';
import {isProjectStore, registerProjectTransactionFence, registerProjectTransactionObserver} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import type {ProjectVersionSummary} from '../../../contracts/src/project-versions.ts';
import {captureProjectDocumentInside, readSnapshotProjectFormat, validateProjectDocument} from './document.ts';
import type {ProjectDocument} from './document.ts';
import {encodeProjectDocument} from './codec.ts';
import {storeProjectVersionInside, versionError} from './repository.ts';
import {pruneProjectVersionsInside} from './retention.ts';
import {registerProjectVersionCapturePort} from './capture-port.ts';

interface CaptureOptions {
  readonly assertMutationAllowed: () => void;
  readonly now?: () => Date;
  readonly timeZone?: () => string;
}
interface Ticket {
  readonly origin: AgentTaskEffectOrigin;
  readonly sequence: number;
  readonly boundary: number;
  readonly prepared: {readonly document: ProjectDocument; readonly date: Date} | {readonly error: unknown};
}
const sequence = (store: ProjectStore): number => Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence);
const boundary = (store: ProjectStore): number => Number(store.db.prepare('SELECT COALESCE(max(rowid),0) n FROM main.mio_changes').get()!.n);
const marked = (store: ProjectStore, runId: string): boolean => Boolean(store.db.prepare("SELECT 1 FROM main.project_version_capture_marks WHERE projectId=? AND kind='mio-turn' AND key=?").get(store.projectId, runId));
const assertInside = (store: ProjectStore): void => {
  if (!isProjectStore(store) || !store.db.isTransaction) throw new TypeError('Version capture requires the live project transaction');
};

/** Installed before Mio's own observers: a refused snapshot cannot leave its
 * acceptance recorder believing a rolled-back transaction was acknowledged. */
export function installProjectVersionCapture(store: ProjectStore, options: CaptureOptions): () => void {
  if (!isProjectStore(store) || typeof options.assertMutationAllowed !== 'function') throw new TypeError('Version capture requires application write admission');
  const now = options.now ?? (() => new Date());
  const begin = (): Ticket | undefined => {
    assertInside(store);
    const origin = taskEffectOrigin();
    if (!origin) return;
    options.assertMutationAllowed();
    if (origin.projectId !== store.projectId || !store.db.prepare('SELECT 1 FROM main.mio_runs WHERE id=? AND projectId=?').get(origin.runId, store.projectId))
      throw versionError('PROJECT_ID_MISMATCH', '版本捕获来源不属于当前项目。', 400);
    if (marked(store, origin.runId)) return;
    const before = sequence(store), rowid = boundary(store);
    let prepared: Ticket['prepared'];
    try {
      const date = now();
      if (!Number.isFinite(date.getTime())) throw new TypeError('Version capture requires a valid date');
      prepared = {document: captureProjectDocumentInside(store), date};
    } catch (error) {prepared = {error};}
    return {origin, sequence: before, boundary: rowid, prepared};
  };
  const commit = (ticket: Ticket | undefined): void => {
    if (!ticket) return;
    assertInside(store);
    if (taskEffectOrigin() !== ticket.origin) throw new TypeError('Version capture origin changed inside its transaction');
    if (sequence(store) === ticket.sequence || marked(store, ticket.origin.runId)) return;
    options.assertMutationAllowed();
    if ('error' in ticket.prepared) throw ticket.prepared.error;
    const {document, date} = ticket.prepared;
    const version = storeProjectVersionInside(store.db, {projectId: store.projectId, trigger: 'mio-turn', mioRunId: ticket.origin.runId,
      contentSequence: ticket.sequence, blob: encodeProjectDocument(document), mioChangeRowid: ticket.boundary, createdAt: date.toISOString()});
    store.db.prepare("INSERT INTO main.project_version_capture_marks(projectId,kind,key,createdAt) VALUES(?,'mio-turn',?,?)")
      .run(store.projectId, ticket.origin.runId, date.toISOString());
    pruneProjectVersionsInside(store.db, {projectId: store.projectId, now: date, timeZone: options.timeZone?.(), protectedIds: [version.id]});
  };
  // A single connection forbids nested/async transactions. Reset on each BEGIN
  // rather than keeping an uncommitted run mark in JavaScript across retries.
  let current: Ticket | undefined;
  const removePort = registerProjectVersionCapturePort(store, () => {
    const ticket = begin();
    return () => commit(ticket);
  });
  const removeFence = registerProjectTransactionFence(store.db, () => {current = undefined; current = begin();});
  const removeObserver = registerProjectTransactionObserver(store.db, () => {const ticket = current; current = undefined; commit(ticket);});
  return () => {removeObserver(); removeFence(); removePort(); current = undefined;};
}

/** The caller owns replay/CAS and its single synchronous restore transaction. */
export function saveBeforeBulkChangeInside(store: ProjectStore, options: CaptureOptions & {
  readonly trigger: 'restore' | 'bulk-change'; readonly document?: ProjectDocument; readonly requestId: string;
}): ProjectVersionSummary {
  assertInside(store);
  if (typeof options.assertMutationAllowed !== 'function' || !options.requestId) throw new TypeError('Bulk capture requires write admission and a request identity');
  options.assertMutationAllowed();
  const document = options.document ? validateProjectDocument(options.document) : captureProjectDocumentInside(store);
  if (document.projectId !== store.projectId || document.projectFormatVersion !== readSnapshotProjectFormat(store.db) || document.evidence.contentSequence !== sequence(store))
    throw versionError('PROJECT_ID_MISMATCH', '大改动前态不属于当前项目状态。', 400);
  const date = (options.now ?? (() => new Date()))();
  const version = storeProjectVersionInside(store.db, {projectId: store.projectId, trigger: options.trigger,
    contentSequence: document.evidence.contentSequence, blob: encodeProjectDocument(document), mioChangeRowid: boundary(store), createdAt: date.toISOString()});
  pruneProjectVersionsInside(store.db, {projectId: store.projectId, now: date, timeZone: options.timeZone?.(), protectedIds: [version.id]});
  return version;
}
