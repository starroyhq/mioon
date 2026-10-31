import {isDeepStrictEqual} from 'node:util';
import {agentTaskPolicySchema} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskPolicy} from '../../../contracts/src/agent-tasks-v2.ts';
import {isProjectId, projectIdSchema} from '../../../contracts/src/project-file.ts';
import {
  backgroundTaskIndexEntrySchema, outsidePathConfirmationSchema, projectInboxItemSchema, projectRulesTrustSchema,
} from '../../../contracts/src/project-registry.ts';
import type {BackgroundTaskIndexEntry, OutsidePathConfirmation, ProjectInboxItem, ProjectRulesTrust} from '../../../contracts/src/project-registry.ts';
import type {AppDatabase} from './connection.ts';
import {appLibraryError} from './errors.ts';
import {APP_DOCUMENT_LIMITS, APP_DOCUMENT_NAMES, APP_RECORD_LIMITS} from './schema.ts';
import type {AppDocumentName} from './schema.ts';

const decode = (data: unknown): unknown => JSON.parse(String(data));

// ---------------------------------------------------------------------------
// Global Mio policy (task card §3, item 7)

/** The project host's AgentPolicyStorePort: the global policy level and its
 * request receipts. Mio keeps the revision and conflict rules and receives this
 * port from its caller; the app library is never attached to a project
 * connection. */
export interface AgentPolicyStore {
  read(): AgentTaskPolicy | null;
  readRequest(requestId: string): {readonly digest: string; readonly policy: AgentTaskPolicy} | null;
  /** One transaction: the policy and, with a request, its receipt. A receipt
   * is never replaced (AGENT_POLICY_REQUEST_EXISTS), changed or deleted. */
  write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void;
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
    write(policy: AgentTaskPolicy, request?: {readonly requestId: string; readonly digest: string}): void {
      const data = JSON.stringify(agentTaskPolicySchema.parse(policy));
      if (request !== undefined && (!isRequestId(request.requestId) || typeof request.digest !== 'string' || !DIGEST.test(request.digest))) {
        throw new TypeError('A policy receipt needs a request ID of 1-200 characters and a SHA-256 digest');
      }
      database.atomically(() => {
        if (request && database.statement('SELECT 1 FROM agent_task_policy_requests_v2 WHERE requestId=?').get(request.requestId) !== undefined) {
          throw appLibraryError('AGENT_POLICY_REQUEST_EXISTS', {requestId: request.requestId});
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
      return row ? String(row.data) : null;
    },
    write(name: AppDocumentName, text: string): void {
      const checked = documentName(name);
      if (typeof text !== 'string') throw new TypeError('An app document is JSON text');
      if (Buffer.byteLength(text) > APP_DOCUMENT_LIMITS[checked]) throw appLibraryError('APP_LIBRARY_LIMIT', {document: checked, limit: APP_DOCUMENT_LIMITS[checked]});
      try {
        JSON.parse(text);
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
  list(): BackgroundTaskIndexEntry[];
  /** Replaces this project's entries in one transaction; an empty list removes
   * them. Every entry must belong to the project, each task once. */
  replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void;
}

export function createBackgroundTaskIndexStore(database: AppDatabase): BackgroundTaskIndexStore {
  return {
    list(): BackgroundTaskIndexEntry[] {
      return database.statement("SELECT data FROM background_task_index ORDER BY json_extract(data,'$.indexedAt'),projectId,kind,taskId").all()
        .map(row => backgroundTaskIndexEntrySchema.parse(decode(row.data)));
    },
    replace(projectId: string, entries: readonly BackgroundTaskIndexEntry[]): void {
      const owner = projectIdSchema.parse(projectId);
      const parsed = entries.map(entry => backgroundTaskIndexEntrySchema.parse(entry));
      if (parsed.some(entry => entry.projectId !== owner)) throw new TypeError('Task index entries must belong to the project');
      if (new Set(parsed.map(entry => `${entry.kind}:${entry.taskId}`)).size !== parsed.length) throw new TypeError('Task index entries must name each task once');
      database.atomically(() => {
        database.statement('DELETE FROM background_task_index WHERE projectId=?').run(owner);
        const insert = database.statement('INSERT INTO background_task_index(projectId,kind,taskId,data) VALUES(?,?,?,?)');
        for (const entry of parsed) insert.run(owner, entry.kind, entry.taskId, JSON.stringify(entry));
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
