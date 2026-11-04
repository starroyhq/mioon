import {isDeepStrictEqual} from 'node:util';
import {agentTaskPolicySchema, DEFAULT_AGENT_TASK_POLICY} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskPolicy} from '../../../contracts/src/agent-tasks-v2.ts';
import {isProjectId, projectIdSchema} from '../../../contracts/src/project-file.ts';
import {
  BACKGROUND_TASK_INDEX_LIMITS, BACKGROUND_TASK_PHASES, backgroundTaskIndexEntrySchema, normalizeBackgroundTaskIndexEntry,
  outsidePathConfirmationSchema, projectInboxItemSchema, projectRulesTrustSchema,
} from '../../../contracts/src/project-registry.ts';
import type {BackgroundTaskIndexEntry, BackgroundTaskPhase, StoredBackgroundTaskIndexEntry, OutsidePathConfirmation, ProjectInboxItem, ProjectRulesTrust} from '../../../contracts/src/project-registry.ts';
import type {AppDatabase} from './connection.ts';
import {appLibraryError} from './errors.ts';
import {APP_DOCUMENT_LIMITS, APP_DOCUMENT_NAMES, APP_RECORD_LIMITS} from './schema.ts';
import type {AppDocumentName} from './schema.ts';
import {agentDiagnosticSummarySchema} from '../../../contracts/src/agent-diagnostic-summary.ts';
import {rulesTextSchema} from '../../../contracts/src/mio-rules.ts';
import {mioIdentitySchemas} from '../../../contracts/src/mio-records.ts';

const decode = (data: unknown): unknown => JSON.parse(String(data));

/** Application-wide standing rules, independent of project trust. The absent
 * singleton has revision zero; receipts compose with CAS in the caller's tx. */
export interface UserRules {readonly text:string;readonly revision:number;readonly updatedAt:string|null}
export interface UserRulesStore {
 get():UserRules;
 cas(expectedRevision:number,text:string,updatedAt:string):UserRules;
}
export function createUserRulesStore(database:AppDatabase):UserRulesStore{
 function get():UserRules{
  const row=database.statement('SELECT text,revision,updatedAt FROM user_rules WHERE singleton=1').get();
  if(!row)return{text:'',revision:0,updatedAt:null};
  const text=rulesTextSchema.safeParse(row.text),revision=mioIdentitySchemas.count.safeParse(row.revision),updatedAt=mioIdentitySchemas.date.safeParse(row.updatedAt);
  if(!text.success||!revision.success||revision.data<1||!updatedAt.success)throw appLibraryError('APP_LIBRARY_INVALID',{reason:'unusable'});
  return{text:text.data,revision:revision.data,updatedAt:updatedAt.data};
 }
 return{get,cas(expectedRevision,text,updatedAt){
  const checkedText=rulesTextSchema.parse(text),checkedAt=mioIdentitySchemas.date.parse(updatedAt);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw new TypeError('Invalid user rules revision');
  return database.atomically(()=>{
   const current=get();
   if(current.revision!==expectedRevision)throw Object.assign(new Error('MIO_RULES_REVISION_CONFLICT'),{code:'MIO_RULES_REVISION_CONFLICT'});
   const revision=expectedRevision+1;
   database.statement('INSERT INTO user_rules(singleton,text,revision,updatedAt) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET text=excluded.text,revision=excluded.revision,updatedAt=excluded.updatedAt').run(checkedText,revision,checkedAt);
   return{text:checkedText,revision,updatedAt:checkedAt};
  });
 }};
}

// ---------------------------------------------------------------------------
// Global Mio policy (task card §3, item 7)

/** The project host's AgentPolicyStorePort: the global policy level and its
 * request receipts. Mio keeps the revision and conflict rules and receives this
 * port from its caller; the app library is never attached to a project
 * connection. */
export interface AgentPolicyStore {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  /** One transaction: optional revision CAS, the policy and its receipt. A receipt
   * is never replaced (AGENT_POLICY_REQUEST_EXISTS), changed or deleted. Omitting
   * expectedRevision retains the original composable unconditional-write port.
   * CAS owns its transaction, so returning cannot acknowledge an uncommitted
   * savepoint inside the caller's application transaction. */
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}, expectedRevision?: number): void;
}

const isRequestId = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 200;
const DIGEST = /^[0-9a-f]{64}$/u;

export function createAgentPolicyStore(database: AppDatabase): AgentPolicyStore {
  return {
    read(): AgentTaskPolicy | null {
      const row = database.statement('SELECT data FROM agent_task_policy_v2 WHERE id=1').get();
      return row ? agentTaskPolicySchema.parse(decode(row.data)) : null;
    },
    readRequest(requestId: string) {
      if (!isRequestId(requestId)) return null;
      const row = database.statement('SELECT digest,data FROM agent_task_policy_requests_v2 WHERE requestId=?').get(requestId);
      return row ? {digest: String(row.digest), policy: agentTaskPolicySchema.parse(decode(row.data))} : null;
    },
    write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}, expectedRevision?: number): void {
      const data = JSON.stringify(agentTaskPolicySchema.parse(policy));
      if (request !== undefined && (!isRequestId(request.requestId) || typeof request.digest !== 'string' || !DIGEST.test(request.digest))) {
        throw new TypeError('A policy receipt needs a request ID of 1-200 characters and a SHA-256 digest');
      }
      const commit = expectedRevision === undefined ? database.atomically : database.tx;
      commit(() => {
        if (request && database.statement('SELECT 1 FROM agent_task_policy_requests_v2 WHERE requestId=?').get(request.requestId) !== undefined) {
          throw appLibraryError('AGENT_POLICY_REQUEST_EXISTS', {requestId: request.requestId});
        }
        if (expectedRevision !== undefined) {
          const row = database.statement('SELECT data FROM agent_task_policy_v2 WHERE id=1').get();
          const current = row ? agentTaskPolicySchema.parse(decode(row.data)) : DEFAULT_AGENT_TASK_POLICY;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || current.revision !== expectedRevision) {
            throw Object.assign(new Error('AGENT_TASK_REVISION_CONFLICT'), {code: 'AGENT_TASK_REVISION_CONFLICT'});
          }
        }
        database.statement('INSERT INTO agent_task_policy_v2(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(data);
        if (request) database.statement('INSERT INTO agent_task_policy_requests_v2(requestId,digest,data) VALUES(?,?,?)').run(request.requestId, request.digest, data);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The three JSON files of the app data directory

/** ui-preferences-v1.json, workspace-settings-v1.json and last-project-v1.json,
 * kept as the text their modules wrote, each within the size its file had. The
 * modules keep their own revision, scope and replay rules. */
export interface AppDocumentStore {
  read(name: AppDocumentName): string | null;
  /** JSON text; replaces the document. */
  write(name: AppDocumentName, text: string): void;
  remove(name: AppDocumentName): void;
}

function documentName(name: unknown): AppDocumentName {
  if (typeof name !== 'string' || !(APP_DOCUMENT_NAMES as readonly string[]).includes(name)) throw new TypeError('Unknown app document');
  return name as AppDocumentName;
}

export function createAppDocumentStore(database: AppDatabase): AppDocumentStore {
  return {
    read(name: AppDocumentName): string | null {
      const row = database.statement('SELECT data FROM app_documents WHERE name=?').get(documentName(name));
      if (row && name === 'agent-diagnostic-summary-v1.json') {
        try {agentDiagnosticSummarySchema.parse(decode(row.data));} catch {throw appLibraryError('APP_LIBRARY_INVALID', {reason: 'unusable'});}
      }
      return row ? String(row.data) : null;
    },
    write(name: AppDocumentName, text: string): void {
      const checked = documentName(name);
      if (typeof text !== 'string') throw new TypeError('An app document is JSON text');
      if (Buffer.byteLength(text) > APP_DOCUMENT_LIMITS[checked]) throw appLibraryError('APP_LIBRARY_LIMIT', {document: checked, limit: APP_DOCUMENT_LIMITS[checked]});
      try {
        const value: unknown = JSON.parse(text);
        if (checked === 'agent-diagnostic-summary-v1.json') agentDiagnosticSummarySchema.parse(value);
      } catch {
        throw new TypeError('An app document is JSON text');
      }
      database.statement('INSERT INTO app_documents(name,data) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data').run(checked, text);
    },
    remove(name: AppDocumentName): void {
      database.statement('DELETE FROM app_documents WHERE name=?').run(documentName(name));
    },
  };
}

// ---------------------------------------------------------------------------
// Records keyed by project (project-registry.ts)

/** AGENTS.md trust: the content hash the user trusted, one per project. */
export interface ProjectRulesTrustStore {
  get(projectId: string): ProjectRulesTrust | null;
  /** Replaces the project's trust. */
  set(trust: ProjectRulesTrust): void;
  remove(projectId: string): void;
}

export function createProjectRulesTrustStore(database: AppDatabase): ProjectRulesTrustStore {
  return {
    get(projectId: string): ProjectRulesTrust | null {
      if (!isProjectId(projectId)) return null;
      const row = database.statement('SELECT data FROM project_rules_trust WHERE projectId=?').get(projectId);
      return row ? projectRulesTrustSchema.parse(decode(row.data)) : null;
    },
    set(trust: ProjectRulesTrust): void {
      const parsed = projectRulesTrustSchema.parse(trust);
      database.statement('INSERT INTO project_rules_trust(projectId,data) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data')
        .run(parsed.projectId, JSON.stringify(parsed));
    },
    remove(projectId: string): void {
      if (isProjectId(projectId)) database.statement('DELETE FROM project_rules_trust WHERE projectId=?').run(projectId);
    },
  };
}

/** Folders outside a project directory the user allowed media to be read from. */
export interface OutsidePathConfirmationStore {
  /** By directory. */
  list(projectId: string): OutsidePathConfirmation[];
  /** Replaces the confirmation of the same project and directory. */
  confirm(confirmation: OutsidePathConfirmation): void;
  /** One directory, or every confirmation of the project without one. */
  revoke(projectId: string, directory?: string): void;
}

export function createOutsidePathConfirmationStore(database: AppDatabase): OutsidePathConfirmationStore {
  return {
    list(projectId: string): OutsidePathConfirmation[] {
      if (!isProjectId(projectId)) return [];
      return database.statement('SELECT data FROM outside_path_confirmations WHERE projectId=? ORDER BY directory').all(projectId)
        .map(row => outsidePathConfirmationSchema.parse(decode(row.data)));
    },
    confirm(confirmation: OutsidePathConfirmation): void {
      const parsed = outsidePathConfirmationSchema.parse(confirmation);
      database.statement('INSERT INTO outside_path_confirmations(projectId,directory,data) VALUES(?,?,?) ON CONFLICT(projectId,directory) DO UPDATE SET data=excluded.data')
        .run(parsed.projectId, parsed.directory, JSON.stringify(parsed));
    },
    revoke(projectId: string, directory?: string): void {
      if (!isProjectId(projectId)) return;
      if (directory === undefined) database.statement('DELETE FROM outside_path_confirmations WHERE projectId=?').run(projectId);
      else database.statement('DELETE FROM outside_path_confirmations WHERE projectId=? AND directory=?').run(projectId, directory);
    },
  };
}

/** S3's BackgroundTaskIndexPort: projects with unfinished tasks. */
export interface BackgroundTaskIndexStore {
  /** By indexing time, then project, kind and task. */
  list(): StoredBackgroundTaskIndexEntry[];
  listProject(projectId: string): StoredBackgroundTaskIndexEntry[];
  /** Same semantic record is a no-op, including a changed polling timestamp.
   * A changed live record increments its stored revision. Archived sources
   * cannot be resurrected by a later event under the same identity. */
  upsert(entry: BackgroundTaskIndexEntry): void;
  /** Pure pre-COMMIT capacity check for the final batch; no transaction or
   * reservation is written. Callers apply done entries before new entries. */
  assertCanUpsert(entries: readonly BackgroundTaskIndexEntry[]): void;
  markProject(projectId: string, phase: BackgroundTaskPhase, reason: string | null): void;
  /** When a source is given, archives it and unverified legacy entries only;
   * a replay must not retire work from a different nonempty source. */
  archive(projectId: string, sourceHistory?: string | null): void;
  /** Replaces current entries atomically while retaining archived generations.
   * A done entry may be removed. Every task/source pair appears once. */
  replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void;
}

export function createBackgroundTaskIndexStore(database: AppDatabase): BackgroundTaskIndexStore {
  const order = " ORDER BY json_extract(data,'$.indexedAt'),projectId,kind,taskId,sourceHistory";
  const read = (row: Record<string, unknown>): StoredBackgroundTaskIndexEntry => {
    let entry: StoredBackgroundTaskIndexEntry;
    try {entry = normalizeBackgroundTaskIndexEntry(backgroundTaskIndexEntrySchema.parse(decode(row.data)));}
    catch {throw appLibraryError('APP_LIBRARY_INVALID', {reason: 'unusable'});}
    if (database.statement("SELECT 1 FROM json_tree(?) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1 LIMIT 1").get(String(row.data))
      || row.projectId !== entry.projectId || row.kind !== entry.kind || row.taskId !== entry.taskId || row.sourceHistory !== (entry.sourceHistory ?? '')
      || row.phase !== entry.phase || row.reason !== entry.reason || row.revision !== entry.revision || row.taskRevision !== entry.taskRevision)
      throw appLibraryError('APP_LIBRARY_INVALID', {reason: 'unusable'});
    return entry;
  };
  const key = (entry: StoredBackgroundTaskIndexEntry): string => JSON.stringify([entry.kind, entry.taskId, entry.sourceHistory]);
  const listProject = (projectId: string): StoredBackgroundTaskIndexEntry[] => {
    const owner = projectIdSchema.parse(projectId);
    return database.statement('SELECT * FROM background_task_index WHERE projectId=?' + order).all(owner).map(read);
  };
  const equal = (left: StoredBackgroundTaskIndexEntry, right: StoredBackgroundTaskIndexEntry): boolean => {
    const {revision: _leftRevision, indexedAt: _leftTime, ...a} = left;
    const {revision: _rightRevision, indexedAt: _rightTime, ...b} = right;
    return isDeepStrictEqual(a, b);
  };
  const assertExisting = (entry: StoredBackgroundTaskIndexEntry, current: StoredBackgroundTaskIndexEntry | null): void => {
    if (current?.phase === 'archived' && !equal(current, entry)
      || current && entry.taskRevision < current.taskRevision
      || current && entry.phase !== 'done' && !equal(current, entry) && current.revision >= Number.MAX_SAFE_INTEGER)
      throw appLibraryError('BACKGROUND_TASK_INDEX_CONFLICT', {projectId: entry.projectId});
  };
  const count = (projectId?: string): number => {
    const value = projectId === undefined ? database.statement('SELECT count(*) AS n FROM background_task_index').get()!.n
      : database.statement('SELECT count(*) AS n FROM background_task_index WHERE projectId=?').get(projectId)!.n;
    if (typeof value !== 'number') throw appLibraryError('APP_LIBRARY_INVALID', {reason: 'unusable'});
    return value;
  };
  const assertCapacity = (total: number, projects: ReadonlyMap<string, number>): void => {
    if (total > BACKGROUND_TASK_INDEX_LIMITS.application) throw appLibraryError('APP_LIBRARY_LIMIT', {record: 'background_task_index'});
    for (const [projectId, size] of projects) if (size > BACKGROUND_TASK_INDEX_LIMITS.project)
      throw appLibraryError('APP_LIBRARY_LIMIT', {record: 'background_task_index', projectId});
  };
  const find = (entry: StoredBackgroundTaskIndexEntry): StoredBackgroundTaskIndexEntry | null => {
    const row = database.statement('SELECT * FROM background_task_index WHERE projectId=? AND kind=? AND taskId=? AND sourceHistory=?')
      .get(entry.projectId, entry.kind, entry.taskId, entry.sourceHistory ?? '');
    return row ? read(row) : null;
  };
  const assertCanUpsert = (entries: readonly BackgroundTaskIndexEntry[]): void => {
    if (entries.length > BACKGROUND_TASK_INDEX_LIMITS.application) throw appLibraryError('APP_LIBRARY_LIMIT', {record: 'background_task_index'});
    const parsed = entries.map(normalizeBackgroundTaskIndexEntry), seen = new Set<string>(), projects = new Map<string, number>();
    const simulated = new Map<string, StoredBackgroundTaskIndexEntry | null>();
    const identity = (entry: StoredBackgroundTaskIndexEntry): string => JSON.stringify([entry.projectId, entry.kind, entry.taskId, entry.sourceHistory]);
    const current = (entry: StoredBackgroundTaskIndexEntry): StoredBackgroundTaskIndexEntry | null => {
      const id = identity(entry);
      if (!simulated.has(id)) simulated.set(id, find(entry));
      return simulated.get(id)!;
    };
    let total = count();
    for (const entry of parsed) {
      const id = identity(entry);
      if (seen.has(id)) throw new TypeError('Task index preflight must name each task once per source');
      seen.add(id);
    }
    const change = (entry: StoredBackgroundTaskIndexEntry, delta: number): void => {
      total += delta; projects.set(entry.projectId, (projects.get(entry.projectId) ?? count(entry.projectId)) + delta);
    };
    // Match the writer's done-first order and consume a legacy placeholder at
    // most once even when the same batch also finishes that legacy identity.
    for (const entry of [...parsed.filter(entry => entry.phase === 'done'), ...parsed.filter(entry => entry.phase !== 'done')]) {
      const before = current(entry); assertExisting(entry, before);
      if (before?.phase === 'archived') continue;
      if (entry.sourceHistory !== null && entry.phase !== 'archived') {
        const unverified = {...entry, sourceHistory: null}, legacy = current(unverified);
        if (legacy && legacy.phase !== 'archived') {simulated.set(identity(unverified), null); change(entry, -1);}
      }
      if (entry.phase === 'done') {
        if (before) change(entry, -1);
        simulated.set(identity(entry), null);
      } else {
        if (!before) change(entry, 1);
        simulated.set(identity(entry), entry);
      }
    }
    assertCapacity(total, projects);
  };
  const write = (entry: StoredBackgroundTaskIndexEntry): void => {
    const source = entry.sourceHistory ?? '';
    const current = find(entry); assertExisting(entry, current);
    if (current?.phase === 'archived') {
      if (equal(current, entry)) return;
      throw appLibraryError('BACKGROUND_TASK_INDEX_CONFLICT', {projectId: entry.projectId});
    }
    // A verified source adopts the old source-less discovery row in this same
    // app transaction. Archived placeholders and other real sources are never
    // consumed; legacy adoption must not require a temporary extra quota slot.
    if (entry.sourceHistory !== null && entry.phase !== 'archived') {
      const legacy = find({...entry, sourceHistory: null});
      if (legacy && legacy.phase !== 'archived') database.statement("DELETE FROM background_task_index WHERE projectId=? AND kind=? AND taskId=? AND sourceHistory='' AND phase<>'archived'")
        .run(entry.projectId, entry.kind, entry.taskId);
    }
    if (entry.phase === 'done') {
      if (current) database.statement('DELETE FROM background_task_index WHERE projectId=? AND kind=? AND taskId=? AND sourceHistory=?')
        .run(entry.projectId, entry.kind, entry.taskId, source);
      return;
    }
    if (current) {
      if (equal(current, entry)) return;
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw appLibraryError('BACKGROUND_TASK_INDEX_CONFLICT', {projectId: entry.projectId});
      const next = {...entry, revision: current.revision + 1}, data = JSON.stringify(next);
      if (Buffer.byteLength(data) > APP_RECORD_LIMITS.taskIndex) throw appLibraryError('APP_LIBRARY_LIMIT', {record: 'background_task_index'});
      database.statement('UPDATE background_task_index SET phase=?,reason=?,revision=?,taskRevision=?,data=? WHERE projectId=? AND kind=? AND taskId=? AND sourceHistory=?')
        .run(next.phase, next.reason, next.revision, next.taskRevision, data, entry.projectId, entry.kind, entry.taskId, source);
      return;
    }
    assertCapacity(count() + 1, new Map([[entry.projectId, count(entry.projectId) + 1]]));
    const data = JSON.stringify(entry);
    if (Buffer.byteLength(data) > APP_RECORD_LIMITS.taskIndex) throw appLibraryError('APP_LIBRARY_LIMIT', {record: 'background_task_index'});
    database.statement('INSERT INTO background_task_index(projectId,kind,taskId,sourceHistory,phase,reason,revision,taskRevision,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(entry.projectId, entry.kind, entry.taskId, source, entry.phase, entry.reason, entry.revision, entry.taskRevision, data);
  };
  return {
    list: () => database.statement('SELECT * FROM background_task_index' + order).all().map(read),
    listProject,
    upsert: entry => {const parsed = normalizeBackgroundTaskIndexEntry(entry); database.atomically(() => write(parsed));},
    assertCanUpsert,
    markProject(projectId, phase, reason) {
      if (!BACKGROUND_TASK_PHASES.includes(phase)) throw new TypeError('Invalid task index phase');
      database.atomically(() => {
        for (const entry of listProject(projectId)) {
          if (entry.phase === 'archived' || entry.phase === 'done') continue;
          write(normalizeBackgroundTaskIndexEntry({...entry, phase, reason}));
        }
      });
    },
    archive(projectId, sourceHistory) {
      if (sourceHistory !== undefined && sourceHistory !== null && !/^[a-f0-9]{64}$/u.test(sourceHistory)) throw new TypeError('Invalid source history');
      database.atomically(() => {
        for (const entry of listProject(projectId)) {
          if (entry.phase === 'archived' || entry.phase === 'done'
            || sourceHistory !== undefined && entry.sourceHistory !== null && entry.sourceHistory !== sourceHistory) continue;
          write({...entry, phase: 'archived', reason: 'HISTORY_REPLACED'});
        }
      });
    },
    replace(projectId, entries) {
      const owner = projectIdSchema.parse(projectId), parsed = entries.map(normalizeBackgroundTaskIndexEntry);
      if (parsed.some(entry => entry.projectId !== owner)) throw new TypeError('Task index entries must belong to the project');
      if (new Set(parsed.map(key)).size !== parsed.length) throw new TypeError('Task index entries must name each task once per source');
      const wanted = new Set(parsed.map(key));
      database.atomically(() => {
        for (const entry of listProject(owner)) {
          if (entry.phase !== 'archived' && !wanted.has(key(entry))) database.statement('DELETE FROM background_task_index WHERE projectId=? AND kind=? AND taskId=? AND sourceHistory=?')
            .run(owner, entry.kind, entry.taskId, entry.sourceHistory ?? '');
        }
        for (const entry of parsed.filter(entry => entry.phase === 'done')) write(entry);
        for (const entry of parsed.filter(entry => entry.phase !== 'done')) write(entry);
      });
    },
  };
}

/** S3's ProjectInboxPort: results that arrived while their project could not
 * be opened. */
export interface ProjectInboxStore {
  /** Adding the same item again changes nothing; another item under its ID is
   * PROJECT_INBOX_ITEM_CONFLICT. */
  add(item: ProjectInboxItem): void;
  /** By arrival, then ID. */
  list(projectId: string): ProjectInboxItem[];
  remove(projectId: string, itemId: string): void;
}

export function createProjectInboxStore(database: AppDatabase): ProjectInboxStore {
  return {
    add(item: ProjectInboxItem): void {
      const parsed = projectInboxItemSchema.parse(item);
      database.atomically(() => {
        const row = database.statement('SELECT data FROM project_inbox WHERE projectId=? AND itemId=?').get(parsed.projectId, parsed.id);
        if (row) {
          if (isDeepStrictEqual(projectInboxItemSchema.parse(decode(row.data)), parsed)) return;
          throw appLibraryError('PROJECT_INBOX_ITEM_CONFLICT', {projectId: parsed.projectId, itemId: parsed.id});
        }
        database.statement('INSERT INTO project_inbox(projectId,itemId,data) VALUES(?,?,?)').run(parsed.projectId, parsed.id, JSON.stringify(parsed));
      });
    },
    list(projectId: string): ProjectInboxItem[] {
      if (!isProjectId(projectId)) return [];
      return database.statement("SELECT data FROM project_inbox WHERE projectId=? ORDER BY json_extract(data,'$.receivedAt'),itemId").all(projectId)
        .map(row => projectInboxItemSchema.parse(decode(row.data)));
    },
    remove(projectId: string, itemId: string): void {
      if (isProjectId(projectId) && typeof itemId === 'string') database.statement('DELETE FROM project_inbox WHERE projectId=? AND itemId=?').run(projectId, itemId);
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-project receipts

/** The exact replay of an app-level operation (creating, packing or copying a
 * project). project-registry.ts has no receipt schema yet; this is the shape
 * the existing request receipts share: an operation such as `project.create`,
 * the request ID, the digest of its canonical input and the response (any
 * JSON). Receipts are never changed. */
export interface AppOperationReceipt {
  readonly operation: string;
  readonly requestId: string;
  readonly digest: string;
  readonly response: unknown;
  /** ISO 8601 in UTC, as `new Date().toISOString()` writes it. */
  readonly createdAt: string;
}

const OPERATION = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const RECEIPT_KEYS = ['createdAt', 'digest', 'operation', 'requestId', 'response'];

/** The receipt with its response as JSON text; TypeError for anything else. */
function checkedReceipt(receipt: unknown): AppOperationReceipt & {readonly text: string} {
  const value = receipt as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== RECEIPT_KEYS.join()) {
    throw new TypeError('A receipt has exactly operation, requestId, digest, response and createdAt');
  }
  const {operation, requestId, digest, response, createdAt} = value;
  if (typeof operation !== 'string' || operation.length > 100 || !OPERATION.test(operation)) throw new TypeError('Invalid receipt operation');
  if (!isRequestId(requestId)) throw new TypeError('Invalid receipt request ID');
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new TypeError('Invalid receipt digest');
  if (typeof createdAt !== 'string' || !UTC_TIME.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw new TypeError('Invalid receipt time');
  let text: string | undefined;
  try {
    text = JSON.stringify(response);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new TypeError('A receipt response must be JSON');
  return {operation, requestId, digest, response, createdAt, text};
}

export interface AppOperationReceiptStore {
  read(operation: string, requestId: string): AppOperationReceipt | null;
  /** Writing the same receipt again changes nothing; another receipt under its
   * operation and request ID is APP_OPERATION_RECEIPT_CONFLICT. */
  write(receipt: AppOperationReceipt): void;
}

export function createAppOperationReceiptStore(database: AppDatabase): AppOperationReceiptStore {
  const read = (operation: string, requestId: string): AppOperationReceipt | null => {
    if (typeof operation !== 'string' || typeof requestId !== 'string') return null;
    const row = database.statement('SELECT operation,requestId,digest,response,createdAt FROM app_operation_receipts WHERE operation=? AND requestId=?').get(operation, requestId);
    if (!row) return null;
    const {text: _text, ...receipt} = checkedReceipt({
      operation: row.operation, requestId: row.requestId, digest: row.digest, response: decode(row.response), createdAt: row.createdAt,
    });
    return receipt;
  };
  return {
    read,
    write(receipt: AppOperationReceipt): void {
      const checked = checkedReceipt(receipt);
      if (Buffer.byteLength(checked.text) > APP_RECORD_LIMITS.receiptResponse) throw appLibraryError('APP_LIBRARY_LIMIT', {limit: APP_RECORD_LIMITS.receiptResponse});
      database.atomically(() => {
        const existing = read(checked.operation, checked.requestId);
        if (existing) {
          if (existing.digest === checked.digest && existing.createdAt === checked.createdAt && isDeepStrictEqual(existing.response, decode(checked.text))) return;
          throw appLibraryError('APP_OPERATION_RECEIPT_CONFLICT', {operation: checked.operation, requestId: checked.requestId});
        }
        database.statement('INSERT INTO app_operation_receipts(operation,requestId,digest,response,createdAt) VALUES(?,?,?,?,?)')
          .run(checked.operation, checked.requestId, checked.digest, checked.text, checked.createdAt);
      });
    },
  };
}
