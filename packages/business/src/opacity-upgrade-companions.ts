/** Fixed offline40→42 companion policy. This reader never opens a store,
 * repairs a file, migrates drafts, or grants execution authority. */
import path from 'node:path';
import {createRequire} from 'node:module';
import type {DatabaseSync} from 'node:sqlite';
import {calculateWorkspaceScope} from '../../contracts/src/workspace-scope.ts';
import type {WorkspaceStatIdentity} from '../../contracts/src/workspace-scope.ts';
import {clipDraftDiskSchema, LOCAL_DRAFT_LIMITS} from '../../contracts/src/local-drafts.ts';
import {createLocalDeliverySchemas, LOCAL_DELIVERY_LIMITS} from '../../contracts/src/local-delivery.ts';
import {createLocalShotTextSchemas, LOCAL_SHOT_TEXT_LIMITS} from '../../contracts/src/local-shot-text.ts';
import {lastProjectDiskSchema, LAST_PROJECT_LIMITS} from '../../contracts/src/last-project.ts';
import type {LastProjectDisk} from '../../contracts/src/last-project.ts';

export type OpacityUpgradeCompanionChannel = 'web' | 'production' | 'development';
export interface OpacityUpgradeFileIdentity {
  readonly dev: number | bigint; readonly ino: number | bigint; readonly size: number;
  readonly mtimeMs: number; readonly ctimeMs: number; readonly birthtimeMs: number;
  readonly uid: number; readonly mode: number; readonly nlink: number;
}
const definitions = [
  {name: 'last-project-v1.json', maxBytes: LAST_PROJECT_LIMITS.fileBytes, kind: 'last-project'},
  {name: 'local-drafts-v1.json', maxBytes: LOCAL_DRAFT_LIMITS.envelopeBytes, kind: 'clip'},
  {name: 'local-delivery-v1.json', maxBytes: LOCAL_DELIVERY_LIMITS.envelopeBytes, kind: 'delivery'},
  {name: 'local-shot-text-v1.json', maxBytes: LOCAL_SHOT_TEXT_LIMITS.envelopeBytes, kind: 'shot-text'},
  {name: 'local-drafts-v3.json', maxBytes: LOCAL_DRAFT_LIMITS.envelopeBytes, kind: 'unsupported'},
  {name: 'local-drafts-restored43-v1.json', maxBytes: LOCAL_DRAFT_LIMITS.envelopeBytes, kind: 'unsupported'},
] as const;
export type OpacityUpgradeCompanionName = typeof definitions[number]['name'];
export interface OpacityUpgradeCompanionFile {
  readonly name: OpacityUpgradeCompanionName;
  readonly identity: OpacityUpgradeFileIdentity | null;
  readonly bytes: Buffer | null;
}
export interface OpacityUpgradeCompanionCapture {
  readonly workspaceScope: string;
  readonly files: readonly OpacityUpgradeCompanionFile[];
  readonly lastProject: Readonly<LastProjectDisk> | null;
  readonly excludedEmpty: readonly OpacityUpgradeCompanionName[];
}
export interface OpacityUpgradeCompanionOptions {
  readonly root: string; readonly channel: OpacityUpgradeCompanionChannel; readonly db: DatabaseSync;
  readonly directoryIdentity: WorkspaceStatIdentity; readonly databaseIdentity: WorkspaceStatIdentity;
}
export type OpacityUpgradeCompanionErrorCode = 'OPACITY_UPGRADE_COMPANION_INVALID' | 'OPACITY_UPGRADE_COMPANION_SCOPE_MISMATCH' |
  'OPACITY_UPGRADE_COMPANION_ACTIVE' | 'OPACITY_UPGRADE_COMPANION_UNSUPPORTED' | 'OPACITY_UPGRADE_COMPANION_CHANGED';
const messages: Record<OpacityUpgradeCompanionErrorCode, string> = {
  OPACITY_UPGRADE_COMPANION_INVALID: 'A local companion cannot be safely validated. Upgrade stopped; source files were not repaired or reset.',
  OPACITY_UPGRADE_COMPANION_SCOPE_MISMATCH: 'A local companion belongs to another workspace or channel. Upgrade stopped; source files are unchanged.',
  OPACITY_UPGRADE_COMPANION_ACTIVE: 'Local drafts or retained execution intents cannot be migrated. Resolve them in the original workspace before upgrading; source files are unchanged.',
  OPACITY_UPGRADE_COMPANION_UNSUPPORTED: 'An unsupported candidate or restored draft companion is present in the ordinary40 source. Upgrade stopped; the file is unchanged.',
  OPACITY_UPGRADE_COMPANION_CHANGED: 'The source workspace or a companion changed during validation. Upgrade stopped; source files are unchanged.',
};
export class OpacityUpgradeCompanionError extends Error {
  readonly code: OpacityUpgradeCompanionErrorCode;
  constructor(code: OpacityUpgradeCompanionErrorCode) {super(messages[code]); this.code = code;}
}
function fail(code: OpacityUpgradeCompanionErrorCode = 'OPACITY_UPGRADE_COMPANION_INVALID'): never {throw new OpacityUpgradeCompanionError(code);}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = createRequire(import.meta.url);
const storage: unknown = require('../../contracts/src/private-storage.mjs');
function storageCall(name: string, args: unknown[]): unknown {
  if (!object(storage) || typeof storage[name] !== 'function') return fail();
  return Reflect.apply(storage[name], storage, args) as unknown;
}
function identity(value: unknown): OpacityUpgradeFileIdentity {
  if (!object(value) || !['number', 'bigint'].includes(typeof value.dev) || !['number', 'bigint'].includes(typeof value.ino) ||
      ['size', 'uid', 'mode', 'nlink'].some(key => typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || Number(value[key]) < 0) ||
      ['mtimeMs', 'ctimeMs', 'birthtimeMs'].some(key => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return fail();
  return Object.freeze({dev: value.dev, ino: value.ino, size: value.size, uid: value.uid, mode: value.mode, nlink: value.nlink,
    mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, birthtimeMs: value.birthtimeMs}) as OpacityUpgradeFileIdentity;
}
function sameNode(actual: WorkspaceStatIdentity, expected: WorkspaceStatIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino &&
    (expected.birthtimeMs === undefined || actual.birthtimeMs === expected.birthtimeMs);
}
function sameFile(left: OpacityUpgradeFileIdentity, right: OpacityUpgradeFileIdentity): boolean {
  return sameNode(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink;
}
function sourceIdentity(options: OpacityUpgradeCompanionOptions): void {
  const directory = identity(storageCall('validatePrivateDirectory', [options.root]));
  const database = identity(storageCall('validateManagedFile', [path.join(options.root, 'workbench.sqlite'), {root: options.root}]));
  if (!sameNode(directory, options.directoryIdentity) || !sameNode(database, options.databaseIdentity)) fail('OPACITY_UPGRADE_COMPANION_CHANGED');
}
function readFile(root: string, definition: typeof definitions[number]): OpacityUpgradeCompanionFile {
  const file = path.join(root, definition.name), options = {root, private: true, allowMissing: true, maxBytes: definition.maxBytes};
  const before = storageCall('validateManagedFile', [file, options]);
  if (before === null) return Object.freeze({name: definition.name, identity: null, bytes: null});
  const first = identity(before), bytes = storageCall('readPrivateFile', [file, options]);
  const after = storageCall('validateManagedFile', [file, options]);
  if (after === null || !Buffer.isBuffer(bytes) || bytes.length !== first.size || !sameFile(first, identity(after))) fail('OPACITY_UPGRADE_COMPANION_CHANGED');
  return Object.freeze({name: definition.name, identity: first, bytes: Buffer.from(bytes)});
}
function json(bytes: Buffer, db: DatabaseSync): unknown {
  let text: string;
  try {text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);} catch {return fail();}
  // SQLite's JSON parser compares decoded property names, so escaped duplicate
  // spellings cannot bypass this check. This statement only queries JSON.
  try {
    if (db.prepare('SELECT 1 FROM json_tree(?) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1 LIMIT 1').get(text)) return fail();
    return JSON.parse(text) as unknown;
  } catch {return fail();}
}
function scopeMatches(value: {workspaceScope: string}, workspaceScope: string): void {
  if (value.workspaceScope !== workspaceScope) fail('OPACITY_UPGRADE_COMPANION_SCOPE_MISMATCH');
}
function requireProject(db: DatabaseSync, projectId: string): void {
  const rows = db.prepare("SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=36 THEN id END AS id, CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM main.projects WHERE id=? LIMIT 2").all(projectId);
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== projectId || typeof row.data !== 'string') return fail();
  const project = json(Buffer.from(row.data), db);
  if (!object(project) || project.id !== projectId) fail();
}
// Tombstone-only formats do not contain an input to validate. Refusing every
// retained intent is intentional, including terminal intents whose frozen text
// and request identity would otherwise be lost by this narrow upgrade.
const deliverySchema = createLocalDeliverySchemas(() => false).disk;
const shotTextSchema = createLocalShotTextSchemas(() => false).disk;
function hasActiveEntries(value: unknown): boolean {
  return object(value) && Array.isArray(value.entries) && value.entries.some(entry => object(entry) &&
    (Object.hasOwn(entry, 'draft') && entry.draft !== null || Object.hasOwn(entry, 'intent') && entry.intent !== null));
}
/** Capture only six documented companion paths under the already-locked cold
 * source. Missing paths are retained as snapshots for the caller's final check.
 * Empty/tombstone-only input files are explicitly excluded, never copied. */
export function captureOpacityUpgradeCompanions(options: OpacityUpgradeCompanionOptions): OpacityUpgradeCompanionCapture {
  try {
    if (!path.isAbsolute(options.root) || path.resolve(options.root) !== options.root || !['web', 'production', 'development'].includes(options.channel)) fail();
    sourceIdentity(options);
    const workspaceScope = calculateWorkspaceScope({channel: options.channel, root: options.root, directory: options.directoryIdentity, db: options.databaseIdentity});
    const files: OpacityUpgradeCompanionFile[] = [], excludedEmpty: OpacityUpgradeCompanionName[] = [];
    let lastProject: LastProjectDisk | null = null;
    for (const definition of definitions) {
      const file = readFile(options.root, definition); files.push(file);
      if (file.bytes === null) continue;
      if (definition.kind === 'unsupported') fail('OPACITY_UPGRADE_COMPANION_UNSUPPORTED');
      const value = json(file.bytes, options.db);
      if (definition.kind === 'last-project') {
        const parsed = lastProjectDiskSchema.safeParse(value); if (!parsed.success) return fail();
        scopeMatches(parsed.data, workspaceScope); requireProject(options.db, parsed.data.projectId);
        lastProject = Object.freeze(parsed.data); continue;
      }
      if (hasActiveEntries(value)) fail('OPACITY_UPGRADE_COMPANION_ACTIVE');
      if (definition.kind === 'clip') {
        const parsed = clipDraftDiskSchema.safeParse(value); if (!parsed.success) return fail();
        scopeMatches(parsed.data, workspaceScope);
        const keys = new Set<string>();
        for (const entry of parsed.data.entries) {
          const key = JSON.stringify([entry.projectId, entry.timelineId, entry.clipId]);
          if (keys.has(key) || Buffer.byteLength(JSON.stringify(entry)) > LOCAL_DRAFT_LIMITS.rowBytes) return fail();
          keys.add(key);
        }
      } else if (definition.kind === 'delivery') {
        const parsed = deliverySchema.safeParse(value); if (!parsed.success) return fail();
        scopeMatches(parsed.data, workspaceScope);
      } else {
        const parsed = shotTextSchema.safeParse(value); if (!parsed.success) return fail();
        scopeMatches(parsed.data, workspaceScope);
      }
      excludedEmpty.push(definition.name);
    }
    sourceIdentity(options);
    return Object.freeze({workspaceScope, files: Object.freeze(files), lastProject, excludedEmpty: Object.freeze(excludedEmpty)});
  } catch (error) {if (error instanceof OpacityUpgradeCompanionError) throw error; return fail();}
}
/** Recheck the same six paths, including continued absence. This performs no
 * cleanup and leaves root/database/lock admission to the owning pipeline. */
export function verifyOpacityUpgradeCompanionCapture(capture: OpacityUpgradeCompanionCapture, options: {readonly root: string}): void {
  try {
    if (!path.isAbsolute(options.root) || path.resolve(options.root) !== options.root || capture.files.length !== definitions.length) fail('OPACITY_UPGRADE_COMPANION_CHANGED');
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index]!, before = capture.files[index];
      if (!before || before.name !== definition.name) fail('OPACITY_UPGRADE_COMPANION_CHANGED');
      const current = readFile(options.root, definition);
      if (before.identity === null ? current.identity !== null || before.bytes !== null || current.bytes !== null :
          current.identity === null || before.bytes === null || current.bytes === null || !sameFile(before.identity, current.identity) || !before.bytes.equals(current.bytes)) {
        fail('OPACITY_UPGRADE_COMPANION_CHANGED');
      }
    }
  } catch (error) {if (error instanceof OpacityUpgradeCompanionError) throw error; fail('OPACITY_UPGRADE_COMPANION_CHANGED');}
}
export interface OpacityUpgradeLastProjectTarget {
  readonly root: string; readonly channel: OpacityUpgradeCompanionChannel;
  readonly directoryIdentity: WorkspaceStatIdentity; readonly databaseIdentity: WorkspaceStatIdentity;
}
/** The caller owns target creation, byte publication, fsync and final source
 * rechecks. Only workspaceScope changes; preference identity/revision/time stay. */
export function rebindOpacityUpgradeLastProject(capture: OpacityUpgradeCompanionCapture, target: OpacityUpgradeLastProjectTarget): LastProjectDisk | null {
  if (!capture.lastProject) return null;
  if (!path.isAbsolute(target.root) || path.resolve(target.root) !== target.root || !['web', 'production', 'development'].includes(target.channel)) return fail();
  const workspaceScope = calculateWorkspaceScope({channel: target.channel, root: target.root, directory: target.directoryIdentity, db: target.databaseIdentity});
  const result = lastProjectDiskSchema.safeParse({...capture.lastProject, workspaceScope});
  if (!result.success) return fail();
  return Object.freeze(result.data);
}
