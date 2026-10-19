/** Fixed ordinary42/restored43 application delivery adapter. Wire data and copied adapters
 * cannot select the candidate playback/download rules. */
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {isOpacityRenderRecord} from '../../contracts/src/timeline-opacity-render-candidate.ts';
import {getOpacityCandidateAssembly, isOpacityCandidateApplicationStore, isRestoredOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import {matchesOpacityCandidateExport} from './opacity-candidate-render-authority.ts';
import type {TimelineDeliveryReadGuards} from './timeline-delivery-read.ts';

const require = createRequire(import.meta.url);
const sources: unknown = require('./timeline-sources.mjs');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface Binding {assertRecord(value: unknown): boolean; assertDatabase(value: DatabaseSync): void; checkpoint(): void}
const bindings = new WeakMap<object, Binding>();
const applicationStore = (store: unknown): boolean => isOpacityCandidateApplicationStore(store) || isRestoredOpacityCandidateApplicationStore(store);
function unavailable(): never {throw Object.assign(new Error('Candidate delivery is unavailable.'), {code: 'FILE_UNAVAILABLE', status: 404});}
const extensions: Readonly<Record<string, string>> = Object.freeze({'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a'});

/** Candidate application sources are exclusively canonical managed imports. An
 * output never becomes an unguarded source by changing its provenance label. */
export function readOpacityCandidateApplicationSource(store: unknown, assetId: string): Readonly<Record<string, unknown>> | null {
  try {
    const assembly = getOpacityCandidateAssembly(store);
    if (!assembly || !applicationStore(store) || !object(store) || !(store.db instanceof DatabaseSync) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId) ||
        !object(sources) || typeof sources.readOwnedTimelineAsset !== 'function') return null;
    assembly.checkpoint(); const db = store.db;
    const owner = db.prepare('SELECT projectId FROM assets WHERE id=?').get(assetId);
    if (!owner || typeof owner.projectId !== 'string') return null;
    const asset: unknown = Reflect.apply(sources.readOwnedTimelineAsset, sources, [db, owner.projectId, assetId]);
    if (!object(asset) || asset.id !== assetId || asset.projectId !== owner.projectId || asset.provenance !== 'user-import' ||
        typeof asset.mimeType !== 'string' || !extensions[asset.mimeType] || asset.relativePath !== `media/${assetId}.${extensions[asset.mimeType]}`) return null;
    // An unreadable reverse owner cannot be treated as proof of no owner. The
    // byte discriminator runs before JSON extraction, keeping this bounded.
    if (db.prepare("SELECT 1 FROM exports WHERE CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 4194304 THEN CASE WHEN json_valid(data) THEN CASE WHEN json_type(data)='object' AND json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS projectId AND json_type(data,'$.assetId') IN ('text','null') THEN json_extract(data,'$.assetId')=? ELSE 1 END ELSE 1 END ELSE 1 END LIMIT 1").get(assetId)) return null;
    assembly.checkpoint(); return asset;
  } catch {return null;}
}

/** Recheck after the existing file responder's path/open/stat awaits. */
export function assertOpacityCandidateApplicationSource(store: unknown, expected: Readonly<Record<string, unknown>>): void {
  const current = typeof expected.id === 'string' ? readOpacityCandidateApplicationSource(store, expected.id) : null;
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) unavailable();
}

export function createOpacityCandidateTimelineDeliveryGuards(store: unknown): TimelineDeliveryReadGuards {
  const assembly = getOpacityCandidateAssembly(store);
  if (!assembly || !applicationStore(store) || !object(store) || !(store.db instanceof DatabaseSync) ||
      !object(sources) || typeof sources.readOwnedTimelineAsset !== 'function') return unavailable();
  const db = store.db, readAsset = sources.readOwnedTimelineAsset;
  const checkpoint = (): void => {
    if (!applicationStore(store) || getOpacityCandidateAssembly(store) !== assembly || store.db !== db) unavailable();
    assembly.checkpoint();
  };
  const guards: TimelineDeliveryReadGuards = Object.freeze({
    isTimelineRenderRecord(this: TimelineDeliveryReadGuards, value: unknown, input: Readonly<Record<string, unknown>>): boolean {
      if (this !== guards) return unavailable();
      checkpoint(); return isOpacityRenderRecord(value, input) && matchesOpacityCandidateExport(store, value);
    },
    readOwnedAsset(this: TimelineDeliveryReadGuards, projectId: string, assetId: string): unknown {
      if (this !== guards) return unavailable();
      checkpoint(); const asset: unknown = Reflect.apply(readAsset, sources, [db, projectId, assetId]); checkpoint(); return asset;
    },
  });
  bindings.set(guards, Object.freeze({checkpoint, assertDatabase(value: DatabaseSync): void {checkpoint(); if (value !== db) unavailable();}, assertRecord(value: unknown): boolean {
    checkpoint(); const valid = matchesOpacityCandidateExport(store, value); checkpoint(); return valid;
  }}));
  checkpoint(); return guards;
}

/** Internal identity lookup; only the exact fixed adapter grants these rules. */
export function getOpacityCandidateTimelineDeliveryBinding(guards: TimelineDeliveryReadGuards): Binding | null {
  const binding = bindings.get(guards);
  if (!binding) return null;
  binding.checkpoint(); return binding;
}
