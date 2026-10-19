import {createHash} from 'node:crypto';
import {AppError} from '@mioon/contracts';
import {readPrivateFile} from '@mioon/contracts/private-storage';
import {canonicalImageInput as canonical, IMAGE_EDIT_LIMITS, imageEditSourceSchema} from '../../../contracts/src/images.ts';
import {createOwnedMediaGraphReader} from '../inspection.ts';
import {validateManagedSource} from '../managed-media.ts';
import {validatePng} from './png.ts';
import type {DatabaseSync} from 'node:sqlite';

export type ImageEditSource = ReturnType<typeof imageEditSourceSchema.parse>;
export interface InspectionAsset {
  readonly id: string; readonly projectId: string; readonly relativePath: string; readonly sha256: string; readonly mimeType: string;
  readonly width: number; readonly height: number; readonly sizeBytes: number; readonly name: string; readonly provenance: string;
}
interface OwnedMediaGraph {
  asset(assetId: string): InspectionAsset;
  legacySource(assetId: string): unknown;
  imageSource(assetId: string): unknown;
  frameSource(assetId: string): unknown;
}
export interface EditSourceStore {readonly db: DatabaseSync; readonly root: string}
export interface VerifiedEditSource {descriptor: ImageEditSource; bytes: Buffer}
export interface ImageEditSourceResolver {
  verify(input: unknown, expected?: unknown): Promise<VerifiedEditSource>;
  assertOwned(input: unknown, expected?: unknown): ImageEditSource;
  assertCurrent(input: unknown, verified: VerifiedEditSource): true;
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
function fail(): never { throw new AppError('IMAGE_SOURCE_INVALID', 'The managed PNG source could not be verified.', 409); }
// Resource admission only, shared by resolver/review/service wrappers using the
// same DB handle. This is not durable acceptance or cross-process authority.
export const IMAGE_EDIT_VERIFICATION_LIMITS = Object.freeze({perDatabase: 4, perProject: 2});
interface EditsVerificationAdmission {count: number; projects: Map<unknown, number>}
const verifications = new WeakMap<DatabaseSync, EditsVerificationAdmission>();
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export type ImageEditFields = {purpose?: 'edit'; inputImage?: unknown; sourceImage?: unknown};
export function imageEditFields(snapshot: unknown): ImageEditFields {
  const record = object(snapshot);
  return record?.purpose === 'edit' ? {purpose: 'edit', inputImage: record.inputImage, sourceImage: record.sourceImage} : {};
}
// A closed descriptor, never a path, URL, arbitrary provenance object or bytes.
export function describeImageEditSource(asset: InspectionAsset, imageSource: unknown, frameSource: unknown): ImageEditSource {
  let origin: unknown;
  if (imageSource && !frameSource && ['generated', 'synthetic-mock'].includes(asset.provenance)) origin = {kind: asset.provenance, imageSource};
  else if (frameSource && !imageSource && asset.provenance === 'extracted-frame') origin = {kind: 'extracted-frame', frameSource};
  else if (!imageSource && !frameSource && asset.provenance === 'user-import') origin = {kind: 'user-import'};
  else fail();
  const result = {assetId: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.sizeBytes, width: asset.width, height: asset.height, name: asset.name, origin};
  if (!imageEditSourceSchema.safeParse(result).success) fail();
  return result as ImageEditSource;
}

/** Fixed-purpose backend helper. It accepts only a project-scoped edit request,
 * fully validates reverse ownership and retains bytes exclusively in memory. */
export function createImageEditSourceResolver(store: EditSourceStore, {signal}: {signal?: AbortSignal} = {}): ImageEditSourceResolver {
  function owned(input: unknown, expected?: unknown): {asset: InspectionAsset; descriptor: ImageEditSource} {
    const value = object(input), inputImage = object(value?.inputImage);
    if (value?.purpose !== 'edit' || !inputImage) fail();
    try {
      const graph = createOwnedMediaGraphReader(store.db, value.projectId as string) as unknown as OwnedMediaGraph;
      const asset = graph.asset(inputImage.assetId as string);
      // Legacy generated image/video owners cannot masquerade as an import.
      if (graph.legacySource(asset.id)) fail();
      const descriptor = describeImageEditSource(asset, graph.imageSource(asset.id), graph.frameSource(asset.id));
      if (descriptor.assetId !== inputImage.assetId || descriptor.sha256 !== inputImage.sha256 || expected && canonical(descriptor) !== canonical(expected)) fail();
      return {asset, descriptor};
    } catch { fail(); }
  }
  function bytesFor(asset: InspectionAsset, descriptor: ImageEditSource): Buffer {
    try {
      const source = validateManagedSource(store.root, asset, {maxBytes: IMAGE_EDIT_LIMITS.sourceBytes});
      const raw = readPrivateFile(source.file, {root: store.root, private: false, maxBytes: IMAGE_EDIT_LIMITS.sourceBytes});
      if (!Buffer.isBuffer(raw)) fail();
      if (raw.length !== descriptor.byteLength || digest(raw) !== descriptor.sha256) fail();
      return raw;
    } catch { fail(); }
  }
  function assertOwned(input: unknown, expected?: unknown): ImageEditSource {return owned(input, expected).descriptor;}
  function assertCurrent(input: unknown, verified: VerifiedEditSource): true {
    const current = owned(input, verified.descriptor), bytes = bytesFor(current.asset, current.descriptor);
    if (!Buffer.isBuffer(verified.bytes) || verified.bytes.length !== bytes.length || digest(verified.bytes) !== current.descriptor.sha256 || !bytes.equals(verified.bytes)) fail();
    return true;
  }
  async function verify(input: unknown, expected?: unknown): Promise<VerifiedEditSource> {
    if (store.db.isTransaction) throw new TypeError('PNG source verification must run outside SQLite transactions');
    let admission = verifications.get(store.db);
    if (!admission) {admission = {count: 0, projects: new Map()}; verifications.set(store.db, admission);}
    const projectId = object(input)?.projectId, count = admission.projects.get(projectId) ?? 0;
    if (admission.count >= IMAGE_EDIT_VERIFICATION_LIMITS.perDatabase || count >= IMAGE_EDIT_VERIFICATION_LIMITS.perProject) throw new AppError('IMAGE_QUEUE_FULL', 'Too many PNG sources are being verified. Retain this request and try again explicitly.', 409);
    admission.count++; admission.projects.set(projectId, count + 1);
    try {
      const current = owned(input, expected), bytes = bytesFor(current.asset, current.descriptor);
      try {await validatePng(bytes, {width: current.descriptor.width, height: current.descriptor.height, opaque: true, signal});} catch {fail();}
      const verified: VerifiedEditSource = {descriptor: structuredClone(current.descriptor), bytes};
      assertCurrent(input, verified); return verified;
    } finally {admission.count--; const remaining = (admission.projects.get(projectId) ?? 1) - 1; if (remaining) admission.projects.set(projectId, remaining); else admission.projects.delete(projectId);}
  }
  return Object.freeze({verify, assertOwned, assertCurrent});
}
