/** Fresh42 application handlers reuse the owned graph and managed importer.
 * No provider, listener, migration or restored43 operation is created here. */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {getOpacityCandidateAssembly, isOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import type {OpacityCandidateStore} from './opacity-candidate-store.ts';
import {matchesOpacityCandidateExport} from './opacity-candidate-render-authority.ts';
import {createManagedAssetImportHandler} from './managed-asset-import.ts';

type Value = Record<string, unknown>;
type Handler = (input: Value, context?: {signal?: AbortSignal}) => unknown;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = createRequire(import.meta.url);
const contracts: unknown = require('../../contracts/src/index.mjs');
const inspection: unknown = require('./inspection.mjs');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const unavailable = (): never => {throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This internal candidate application operation is unavailable.', 409);};
export const OPACITY_CANDIDATE_APPLICATION_BASIC_OPERATIONS = Object.freeze(['project.create', 'project.list', 'project.get', 'asset.import', 'asset.list', 'asset.get', 'export.list', 'export.get', 'provider.list', 'workspace.restore.inspect']);
/** Literal old parser plus two closed read forms; no general profile switch. */
export function parseOpacityCandidateApplicationInput(operation: string, input: unknown): Value {
  if (!OPACITY_CANDIDATE_APPLICATION_BASIC_OPERATIONS.includes(operation)) return unavailable();
  if (operation === 'asset.get' || operation === 'export.list') {
    const key = operation === 'asset.get' ? 'assetId' : 'projectId';
    if (!object(input) || Object.keys(input).length !== 1 || !uuid(input[key])) throw new AppError('VALIDATION_ERROR', '输入字段无效');
    return {[key]: input[key]};
  }
  if (!object(contracts) || typeof contracts.parse !== 'function') return unavailable();
  const parsed: unknown = contracts.parse(operation, input);
  if (!object(parsed)) return unavailable();
  return parsed;
}
export function createOpacityCandidateApplicationHandlers(store: OpacityCandidateStore, options: {
  signal?: AbortSignal;
  ensureTimeline(projectId: string): unknown;
  history(projectId: string): unknown;
}) {
  const assembly = getOpacityCandidateAssembly(store);
  if (!assembly || !isOpacityCandidateApplicationStore(store)) return unavailable();
  const checkpoint = (): void => {assembly.checkpoint(); if (!isOpacityCandidateApplicationStore(store)) unavailable();};
  const now = (): string => new Date().toISOString();
  const required = (table: 'projects' | 'assets' | 'exports', id: unknown): Value => {
    checkpoint(); if (!uuid(id)) throw new AppError('NOT_FOUND', '找不到记录', 404);
    const row = store.db.prepare(`SELECT id,${table === 'projects' ? '' : 'projectId,'}CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ${table === 'exports' ? 4194304 : 16384} THEN data END AS data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new AppError('NOT_FOUND', '找不到记录', 404, {id});
    let value: unknown; try {value = typeof row.data === 'string' ? JSON.parse(row.data) as unknown : undefined;} catch {return unavailable();}
    if (!object(value) || value.id !== row.id || row.id !== id || table !== 'projects' && (value.projectId !== row.projectId || !uuid(row.projectId))) return unavailable();
    if (table !== 'projects') required('projects', value.projectId);
    return value;
  };
  const assets = (projectId: string): unknown[] => {
    required('projects', projectId);
    if (!object(inspection) || typeof inspection.createOwnedMediaGraphReader !== 'function') return unavailable();
    const graph: unknown = inspection.createOwnedMediaGraphReader(store.db, projectId);
    if (!object(graph) || typeof graph.asset !== 'function') return unavailable();
    const readAsset = graph.asset;
    return store.db.prepare('SELECT id FROM assets WHERE projectId=? ORDER BY id').all(projectId).map(row => readAsset(row.id) as unknown);
  };
  const checkedExport = (id: unknown): Value => {
    const value = required('exports', id);
    if (!matchesOpacityCandidateExport(store, value)) return unavailable();
    return value;
  };
  const exports = (projectId: string): Value[] => {
    required('projects', projectId);
    return store.db.prepare('SELECT id FROM exports WHERE projectId=? ORDER BY id').all(projectId).map(row => checkedExport(row.id));
  };
  const handlers: Record<string, Handler> = {
    'project.create': input => {checkpoint(); const stamp = now(); return store.put('projects', {id: randomUUID(), name: input.name, description: input.description ?? '', revision: 1, createdAt: stamp, updatedAt: stamp});},
    'project.list': () => {checkpoint(); return store.db.prepare('SELECT id FROM projects').all().map(row => required('projects', row.id)).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));},
    'project.get': input => store.tx(() => {
      const project = required('projects', input.projectId), projectId = project.id;
      if (typeof projectId !== 'string') return unavailable();
      const timeline = options.ensureTimeline(projectId);
      return {project, timeline, timelineHistory: options.history(projectId), assets: assets(projectId), exports: exports(projectId),
        ...Object.fromEntries((['shots', 'nodes', 'edges', 'jobs', 'versions'] as const).map(table => [table, store.list(table, projectId)]))};
    }),
    'asset.list': input => typeof input.projectId === 'string' ? assets(input.projectId) : unavailable(),
    'asset.get': input => {const value = required('assets', input.assetId); return assets(String(value.projectId)).find(asset => object(asset) && asset.id === value.id) ?? unavailable();},
    'asset.import': createManagedAssetImportHandler(store, {signal: options.signal, required: (_table, id) => required('projects', id), now,
      guarded: true, effectFence: () => checkpoint, unsafe: () => new AppError('TIMELINE_SOURCE_UNAVAILABLE', '项目中的时间线或关联素材不可用', 409),
      safeError: error => object(error) && ['RESTORE_STORE_UNVERIFIED', 'RESTORE_OPERATION_UNAVAILABLE', 'TIMELINE_SOURCE_UNAVAILABLE'].includes(String(error.code))}),
    'export.list': input => typeof input.projectId === 'string' ? exports(input.projectId) : unavailable(),
    'export.get': input => checkedExport(input.exportId),
    'provider.list': () => [],
    'workspace.restore.inspect': () => ({restored: false}),
  };
  return Object.freeze(handlers);
}
