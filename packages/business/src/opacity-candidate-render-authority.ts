/** Candidate-only acceptance and worker authority. JSON identities are evidence;
 * only exact owned-store, claim, prepared-map and attempt objects grant effects. */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {captureOpacityPreparedSourceProjection, isOpacityRenderRecord} from '../../contracts/src/timeline-opacity-render-candidate.ts';
import {getOpacityCandidateAssembly, freezeOpacityCandidateInput} from './opacity-candidate-store.ts';
import {isFloatTimelineExport, claimFloatTimelineExport, requeueFloatTimelineExport, assertFloatTimelineExportRead} from './timeline-float-outcome.ts';
import {createTimelineColourLutReader} from './timeline-colour-lut.ts';
import type {ColourLutReader} from './timeline-colour-lut.ts';

type Row = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
const require = createRequire(import.meta.url);
const sources: unknown = require('./timeline-sources.ts');
const managed: unknown = require('./managed-media.ts');
const delivery: unknown = require('../../contracts/src/timeline-delivery.ts');
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, part: unknown) => object(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)).digest('hex');
function unavailable(): never {throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'The candidate render attempt is no longer authorized.', 409);}
function method(module: unknown, name: string): Method {if (!object(module) || typeof module[name] !== 'function') return unavailable();return module[name] as Method;}
function owner(store: unknown) {
  const assembly = getOpacityCandidateAssembly(store);
  if (!assembly || !object(store) || !(store.db instanceof DatabaseSync) || typeof store.root !== 'string' || typeof store.put !== 'function') return unavailable();
  assembly.checkpoint();return {store, assembly, db: store.db, root: store.root, put: store.put as Method};
}
function identity(value: Row): string {
  return digest(Object.fromEntries(['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'orderedVersionIds', 'snapshot', 'createdAt']
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
}
function inputFor(value: Row): Row {
  const fields = method(delivery, 'timelineRenderDeliveryFields')(value.snapshot);
  if (!object(fields)) return unavailable();
  return {projectId: value.projectId, requestId: value.requestId, expectedRevision: value.timelineRevision, purpose: value.purpose, ...fields};
}
function readRow(db: DatabaseSync, id: string, projectId: string): Row | null {
  const row = db.prepare('SELECT id,projectId,CASE WHEN typeof(data)=\'text\' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4194304 THEN data END AS data FROM exports WHERE id=? AND projectId=?').get(id, projectId);
  if (!row || typeof row.data !== 'string') return null;
  try {const value: unknown = JSON.parse(row.data);return object(value) && value.id === row.id && value.projectId === row.projectId ? value : null;} catch {return null;}
}
/** Same sealed acceptance identity/receipt/origin checks as restored exports,
 * with the fixed candidate complete-record validator over the original curve. */
export function matchesOpacityCandidateExport(store: unknown, value: unknown): boolean {
  try {
    const {assembly, db} = owner(store);
    if (!object(value) || !uuid(value.id) || !uuid(value.projectId) || value.mode !== 'timeline' || !isOpacityRenderRecord(value, inputFor(value))) return false;
    const current = readRow(db, value.id, value.projectId);
    if (!current || identity(current) !== identity(value) || !isOpacityRenderRecord(current, inputFor(current))) return false;
    assertFloatTimelineExportRead(db, current, {isTimelineRenderRecord: isOpacityRenderRecord,
      readOwnedAsset: (projectId, id) => method(sources, 'readOwnedTimelineAsset')(db, projectId, id)});
    const receipt = db.prepare('SELECT requestHash,CASE WHEN typeof(response)=\'text\' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304 THEN response END AS response FROM timeline_requests WHERE requestId=?').get(String(value.requestId));
    if (!receipt || typeof receipt.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.requestHash) || typeof receipt.response !== 'string') return false;
    const saved: unknown = JSON.parse(receipt.response);
    if (!object(saved) || saved.status !== 'queued' || saved.assetId !== null || saved.url !== null || !isOpacityRenderRecord(saved, inputFor(saved)) || identity(saved) !== identity(value)) return false;
    const restored = assembly.getRestoreContext();
    if (!restored) return true;
    if (db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(value.id)) return false;
    const origin = db.prepare('SELECT workspaceOrigin,requestScope,requestId,requestHash,identityHash FROM workspace_restore_export_origins WHERE exportId=? AND projectId=?').get(value.id, value.projectId);
    return origin?.workspaceOrigin === restored.workspaceOrigin && origin.requestScope === 'timeline.render' && origin.requestId === value.requestId && origin.requestHash === receipt.requestHash && origin.identityHash === identity(value);
  } catch {return false;}
}
export function bindOpacityCandidateExport(store: unknown, input: unknown, value: unknown, requestHash: string): void {
  const {assembly} = owner(store);
  if (!isOpacityRenderRecord(value, input)) return unavailable();
  assembly.bindExport('timeline.render', input, value, requestHash);
}

interface Claim {readonly store: object; readonly id: string; readonly token: object; live: boolean}
const claims = new WeakMap<object, Claim>();
const storeClaims = new WeakMap<object, Map<string, object>>();
/** A fresh private claim, independent of the request's AsyncLocalStorage life.
 * Reclaiming the same SQL identity revokes the previous attempt, including ABA. */
export function claimOpacityCandidateExport(store: unknown, value: unknown, updatedAt: string): Row {
  const owned = owner(store);
  if (!owned.db.isTransaction || !object(value) || !uuid(value.id) || !uuid(value.projectId) || !matchesOpacityCandidateExport(store, value)) return unavailable();
  const current = readRow(owned.db, value.id, value.projectId);
  if (!current || current.status !== 'queued' || value.status !== 'queued' || typeof updatedAt !== 'string') return unavailable();
  const projection = captureOpacityPreparedSourceProjection(value.snapshot, value.purpose === 'preview' ? 'preview' : 'export').sourceValidationSnapshot;
  const projected = {...value, snapshot: projection};
  const running = isFloatTimelineExport(projected) ? {...claimFloatTimelineExport(projected, updatedAt), snapshot: value.snapshot} : {...value, status: 'running', updatedAt};
  const claimed = freezeOpacityCandidateInput(running), token = Object.freeze({});
  owned.put('exports', claimed);
  let active = storeClaims.get(owned.store);if (!active) {active = new Map();storeClaims.set(owned.store, active);}
  active.set(value.id, token);claims.set(claimed, {store: owned.store, id: value.id, token, live: true});
  return claimed;
}
export function isOpacityCandidateExportClaim(store: unknown, value: unknown): boolean {
  try {
    const owned = owner(store);
    if (!object(value)) return false;
    const claim = claims.get(value), current = uuid(value.id) && uuid(value.projectId) ? readRow(owned.db, value.id, value.projectId) : null;
    return Boolean(claim?.live && claim.store === store && storeClaims.get(owned.store)?.get(claim.id) === claim.token &&
      current?.status === 'running' && current.updatedAt === value.updatedAt && current.renderAttemptId === value.renderAttemptId && matchesOpacityCandidateExport(store, value));
  } catch {return false;}
}
export function revokeOpacityCandidateExportClaim(store: unknown, value: unknown): void {
  if (!object(value)) return;
  const claim = claims.get(value);if (!claim || claim.store !== store) return;
  claim.live = false;if (storeClaims.get(claim.store)?.get(claim.id) === claim.token) storeClaims.get(claim.store)?.delete(claim.id);
}
/** Recovery is a cold-store edge, never an operation that steals a live claim.
 * It carries forward the exact accepted raw snapshot and existing float rules. */
export function recoverOpacityCandidateExport(store: unknown, value: unknown, updatedAt: string): boolean {
  const owned = owner(store);
  if (!owned.db.isTransaction || !object(value) || !uuid(value.id) || !uuid(value.projectId) ||
      storeClaims.get(owned.store)?.has(value.id) || !matchesOpacityCandidateExport(store, value)) return false;
  const current = readRow(owned.db, value.id, value.projectId);
  if (!current || current.status !== 'running' || value.status !== 'running' || typeof updatedAt !== 'string') return false;
  const projection = captureOpacityPreparedSourceProjection(value.snapshot, value.purpose === 'preview' ? 'preview' : 'export').sourceValidationSnapshot;
  const projected = {...value, snapshot: projection};
  const row = isFloatTimelineExport(projected) ? {...requeueFloatTimelineExport(projected), snapshot: value.snapshot} : value;
  owned.put('exports', {...row, status: 'queued', updatedAt});return true;
}

function freezeTree(value: unknown): void {if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {for (const child of Object.values(value)) freezeTree(child);Object.freeze(value);}}
interface Preparation {readonly store: object; readonly row: Row; readonly snapshot: Row; readonly identities: ReadonlyMap<string, unknown>; readonly entries: ReadonlyMap<string, object>; readonly projection: Row; readonly signal?: AbortSignal; readonly readLut: ColourLutReader | undefined; live: boolean; used: boolean}
const preparations = new WeakMap<object, Preparation>();
interface PreparationOptions {readonly signal?: AbortSignal; readonly beforeEffect?: () => void}
/** Actual fixed source preparation performs owned graph/hash/probe checks. A
 * caller-built Map never acquires this registration, even with copied fields. */
export async function prepareOpacityCandidateRenderInputs(store: unknown, row: unknown, options: PreparationOptions = {}): Promise<Map<string, unknown>> {
  const owned = owner(store);
  if (!object(row) || !object(row.snapshot) || !isOpacityCandidateExportClaim(store, row)) return unavailable();
  const rawSnapshot = row.snapshot, {sourceValidationSnapshot: projection} = captureOpacityPreparedSourceProjection(rawSnapshot, row.purpose === 'preview' ? 'preview' : 'export');
  if (Object.hasOwn(options, 'readLut')) return unavailable();
  const readLut = Object.hasOwn(rawSnapshot, 'colourPlan') && typeof row.projectId === 'string' ? createTimelineColourLutReader(owned.db, row.projectId) : undefined;
  const check = (): void => {if (options.signal?.aborted || !isOpacityCandidateExportClaim(store, row)) return unavailable();options.beforeEffect?.();};
  check();
  const prepared: unknown = await method(sources, 'prepareTimelineInputs')(projection, {root: owned.root, projectId: row.projectId, signal: options.signal, beforeEffect: check,
    readLut, retainOpacitySourceIdentity: true,
    readAsset: (id: unknown) => {check();return method(sources, 'readOwnedTimelineAsset')(owned.db, row.projectId, id);},
    validateLinks: (timeline: unknown) => {check();method(sources, 'validateFrozenTimelineSourceGraph')(owned.db, row.projectId, timeline);}});
  check();if (!(prepared instanceof Map)) return unavailable();
  const identities = new Map<string, unknown>(), entries = new Map<string, object>();
  for (const [id, item] of prepared) {if (typeof id !== 'string' || !object(item) || !object(item.opacitySourceIdentity)) return unavailable();identities.set(id, Object.freeze({...item.opacitySourceIdentity}));freezeTree(item);entries.set(id, item);}
  freezeTree(projection);Object.freeze(prepared);
  const proof: Preparation = {store: owned.store, row, snapshot: rawSnapshot, identities, entries, projection, readLut, ...(options.signal ? {signal: options.signal} : {}), live: true, used: false};
  preparations.set(prepared, proof);validatePreparation(store, row, prepared, proof);return prepared as Map<string, unknown>;
}
function validatePreparation(store: unknown, row: Row, prepared: Map<unknown, unknown>, proof: Preparation): void {
  try {
  const owned = owner(store);
  if (!proof.live || proof.store !== store || proof.row !== row || proof.snapshot !== row.snapshot || proof.signal?.aborted || !isOpacityCandidateExportClaim(store, row)) return unavailable();
  method(sources, 'validatePreparedTimelineSources')(owned.db, row.projectId, proof.projection, prepared, {root: owned.root});
  if (prepared.size !== proof.identities.size) return unavailable();
  for (const [id, expected] of proof.identities) {
    const verified: unknown = prepared.get(id), asset = method(sources, 'readOwnedTimelineAsset')(owned.db, row.projectId, id);
    if (!object(verified) || proof.entries.get(id) !== verified || !object(asset)) return unavailable();
    const actual = method(managed, 'validateManagedSource')(owned.root, asset);
    if (!object(actual) || method(managed, 'sameManagedFile')(expected, actual.info) !== true || method(managed, 'sameManagedFile')(expected, verified.opacitySourceIdentity) !== true) return unavailable();
  }
  } catch (error) {proof.live = false;throw error;}
}
export interface OpacityCandidateRenderAttempt {readonly snapshot: Row; readonly readLut: ColourLutReader | undefined; readonly signal: AbortSignal | undefined; assert(): void; close(): void}
interface AttemptState {readonly store: unknown; readonly row: Row; readonly prepared: Map<unknown, unknown>; readonly proof: Preparation; readonly signal?: AbortSignal; live: boolean; readonly revoke: () => void}
const attempts = new WeakMap<object, AttemptState>();
const activeAttempts = new WeakMap<object, Map<string, AttemptState>>();
export function assertOpacityCandidateRenderAttempt(value: unknown): asserts value is OpacityCandidateRenderAttempt {
  if (!object(value)) return unavailable();
  const state = attempts.get(value);
  if (!state || !state.live || state.signal?.aborted) return unavailable();
  try {validatePreparation(state.store, state.row, state.prepared, state.proof);} catch (error) {state.revoke();throw error;}
}
export function createOpacityCandidateRenderAttempt(store: unknown, row: unknown, prepared: unknown, options: {signal?: AbortSignal} = {}): OpacityCandidateRenderAttempt {
  owner(store);
  if (!object(row) || !object(row.snapshot) || !(prepared instanceof Map)) return unavailable();
  const proof = preparations.get(prepared);if (!proof || proof.used) return unavailable();
  validatePreparation(store, row, prepared, proof);
  if (!object(store) || typeof row.id !== 'string') return unavailable();
  const signal = proof.signal && options.signal && proof.signal !== options.signal ? AbortSignal.any([proof.signal, options.signal]) : proof.signal ?? options.signal;
  let active = activeAttempts.get(store);if (!active) {active = new Map();activeAttempts.set(store, active);}
  active.get(row.id)?.revoke();proof.used = true;
  let state: AttemptState;
  const revoke = (): void => {state.live = false;proof.live = false;signal?.removeEventListener('abort', revoke);if (active.get(String(row.id)) === state) active.delete(String(row.id));};
  const readLut: ColourLutReader | undefined = proof.readLut ? (binding, verifyBytes = true) => {assertOpacityCandidateRenderAttempt(attempt);return proof.readLut?.(binding, verifyBytes);} : undefined;
  const attempt: OpacityCandidateRenderAttempt = Object.freeze({snapshot: row.snapshot, readLut, signal, assert: () => assertOpacityCandidateRenderAttempt(attempt), close: revoke});
  state = {store, row, prepared, proof, ...(signal ? {signal} : {}), live: true, revoke};
  attempts.set(attempt, state);active.set(row.id, state);signal?.addEventListener('abort', revoke, {once: true});attempt.assert();return attempt;
}
