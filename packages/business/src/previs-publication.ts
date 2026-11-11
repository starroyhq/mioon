import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {assetMediaRecordSchema, toAssetMediaDto} from '../../contracts/src/asset-media.ts';
import {canonicalPrevisValue} from '../../contracts/src/previs.ts';
import {previsPublicationIdentity, previsPublicationInputSchema, previsPublicationLookupSchema, previsPublicationManifestSchema} from '../../contracts/src/previs-publication.ts';
import type {PrevisPublicationInput, PrevisPublicationLookupInput, PrevisPublicationResponse, PrevisPublicationManifest} from '../../contracts/src/previs-publication.ts';
import {projectOutputPublicationProofSchema} from '../../contracts/src/project-output-publication.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../contracts/src/private-storage.ts';
import {createPrevisReaders} from './previs.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {decodeMediaUpload} from './media-upload.ts';
import {validatePng} from './images/png.ts';
import {publishProjectOutput, markProjectOutputRegistered, assertPublishedProjectOutput, registerVerifiedProjectOutputs} from './project-output-publication.ts';
import {previsOutputInputHash, readPrevisOutputSource} from './previs-output-ownership.ts';
export {readPrevisOutputSource} from './previs-output-ownership.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const active = new WeakMap<ProjectStore, Map<string, Promise<PrevisPublicationResponse>>>();
const conflict = (): never => {throw new AppError('IDEMPOTENCY_CONFLICT', '同一预演请求 ID 已用于不同内容', 409);};
const invalid = (): never => {throw new AppError('PREVIS_EXPORT_INVALID', '预演导出来源或发布记录无法核验', 409);};
const inputHash = previsOutputInputHash;

/** A fixed local PNG producer. Ordinary asset.import cannot enter this path or
 * choose its provenance. Only complete PNG bytes receive a durable manifest;
 * the shared publisher owns final naming, exclusive I/O and crash recovery. */
export function createPrevisPublicationServices(store: ProjectStore, {now = () => new Date().toISOString(), signal, beforeEffect}:
  {now?: () => string; signal?: AbortSignal; beforeEffect?: () => void} = {}) {
  const readers = createPrevisReaders(store.db), directory = path.join(store.tempDir, 'previs-publications');
  const running = active.get(store) ?? new Map<string, Promise<PrevisPublicationResponse>>();
  active.set(store, running);
  const fence = (identity: PrevisPublicationLookupInput): void => {
    signal?.throwIfAborted(); beforeEffect?.();
    if (!isProjectStore(store) || store.projectId !== identity.projectId) throw new AppError('NOT_FOUND', '找不到项目', 404);
    readers.project(identity.projectId);
  };
  const sourceFence = (identity: PrevisPublicationLookupInput): void => {
    fence(identity);
    const node = readers.node(identity.projectId, identity.nodeId);
    if (node.sceneRevision !== identity.sceneRevision) throw new AppError('REVISION_CONFLICT', '预演场景已有新版本，请保存当前场景后重新导出', 409);
    if (!node.scene.keyframes.some(item => item.id === identity.keyframeId)) throw new AppError('PREVIS_THUMBNAIL_SLOT', '当前场景没有这个关键帧', 409);
  };
  function lookup(raw: unknown): PrevisPublicationResponse | null {
    const identity = previsPublicationLookupSchema.parse(raw);
    fence(identity);
    // The portable immutable asset carries the publication proof. Looking up a
    // request never depends on a local temp receipt surviving a project move.
    const bounded = "typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 32768";
    const rows = store.db.prepare(`SELECT id,CASE WHEN ${bounded} THEN data END AS data FROM assets
      WHERE projectId=? AND CASE WHEN ${bounded} THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.publication.owner.kind') END END='previs'
      AND CASE WHEN ${bounded} THEN CASE WHEN json_valid(data) THEN json_extract(data,'$.publication.owner.requestId') END END=? LIMIT 2`).all(identity.projectId, identity.requestId);
    if (rows.length === 0) return null;
    if (rows.length !== 1 || typeof rows[0]!.data !== 'string') invalid();
    let asset: Record<string, unknown>;
    try {asset = JSON.parse(String(rows[0]!.data)) as Record<string, unknown>;} catch {invalid();}
    const parsed = assetMediaRecordSchema.safeParse(asset!);
    const publication = projectOutputPublicationProofSchema.safeParse(asset!.publication);
    if (!parsed.success || !publication.success) return invalid();
    const source = readPrevisOutputSource(asset!, identity.projectId);
    if (!source) invalid();
    const proof = publication.data;
    if (proof.owner.id !== identity.nodeId || proof.owner.inputHash !== inputHash(identity)) conflict();
    if (proof.owner.kind !== 'previs' || proof.owner.requestId !== identity.requestId || proof.projectId !== identity.projectId ||
      proof.assetId !== rows[0]!.id || asset!.id !== proof.assetId || proof.targetKind !== 'generated' || proof.sha256 !== identity.sha256 ||
      proof.sizeBytes !== asset!.sizeBytes || proof.mimeType !== 'image/png' || asset!.provenance !== 'generated' ||
      asset!.width !== identity.width || asset!.height !== identity.height || asset!.name !== identity.name ||
      parsed.data.sha256 !== proof.sha256) invalid();
    fence(identity);
    return {...identity, asset: toAssetMediaDto(asset!)};
  }
  async function publish(raw: unknown): Promise<PrevisPublicationResponse> {
    const input: PrevisPublicationInput = previsPublicationInputSchema.parse(raw), identity = previsPublicationIdentity(input);
    fence(identity);
    const key = hash(identity.requestId), pending = running.get(key);
    if (pending) {await pending.catch(() => {}); return publish(input);}
    const execute = async (): Promise<PrevisPublicationResponse> => {
      // Validate even a replay's supplied bytes: a forged hash cannot borrow a
      // genuine request's acknowledgement.
      const bytes = decodeMediaUpload(input.dataBase64, 'image/png');
      const metadata = await validatePng(bytes, {width: input.width, height: input.height, signal, opaque: false});
      fence(identity);
      if (metadata.sha256 !== input.sha256) invalid();
      const prior = lookup(identity);
      if (prior) return prior;
      sourceFence(identity);
      ensurePrivateDirectory(directory, {create: true});
      const manifestFile = path.join(directory, `${key}.json`), stageFile = path.join(directory, `${key}.png`);
      const saved = readPrivateFile(manifestFile, {root: store.tempDir, allowMissing: true, maxBytes: 32768, encoding: 'utf8'});
      let manifest: PrevisPublicationManifest;
      if (saved !== null) {
        let value: unknown;
        try {value = JSON.parse(String(saved));} catch {invalid();}
        const parsed = previsPublicationManifestSchema.safeParse(value);
        if (!parsed.success) return invalid();
        manifest = parsed.data;
        if (manifest.inputHash !== inputHash(identity) || canonicalPrevisValue(manifest.identity) !== canonicalPrevisValue(identity)) conflict();
      } else {
        sourceFence(identity);
        writePrivateFileAtomic(stageFile, bytes, {root: store.tempDir, maxBytes: 30 * 1024 * 1024});
        sourceFence(identity);
        manifest = {version: 1, identity, assetId: randomUUID(), publicationId: randomUUID(), inputHash: inputHash(identity), createdAt: now()};
        writePrivateFileAtomic(manifestFile, JSON.stringify(manifest), {root: store.tempDir, maxBytes: 32768});
      }
      const owner = {kind: 'previs' as const, id: identity.nodeId, requestId: identity.requestId, inputHash: manifest.inputHash};
      const published = await publishProjectOutput(store, {owner, assetId: manifest.assetId, publicationId: manifest.publicationId,
        targetKind: 'generated', stageFile, mimeType: 'image/png', sha256: metadata.sha256, sizeBytes: metadata.byteLength, displayName: input.name},
      {signal, beforeEffect: () => sourceFence(identity)});
      sourceFence(identity);
      const asset = assetMediaRecordSchema.parse({id: manifest.assetId, projectId: identity.projectId, name: identity.name, mimeType: 'image/png',
        width: identity.width, height: identity.height, duration: 0, hasAudio: false, hasVideo: true, provenance: 'generated', createdAt: manifest.createdAt,
        reference: published.reference, referenceRevision: published.referenceRevision, sha256: published.sha256, sizeBytes: published.sizeBytes, publication: published.publication, previsOutput: identity});
      await registerVerifiedProjectOutputs(store, {signal, beforeEffect: () => sourceFence(identity)}, () => {
        store.tx(() => {
          sourceFence(identity);
          assertPublishedProjectOutput(store, published.publication, {signal, beforeEffect: () => sourceFence(identity)});
          const existing = lookup(identity);
          if (existing) {if (existing.asset.id !== asset.id) conflict(); return;}
          if (store.get('assets', asset.id)) conflict();
          store.put('assets', asset);
        });
        return markProjectOutputRegistered(store, published.publication, {signal, beforeEffect: () => fence(identity)}).catch(cause => {
          // Registration committed. Keep an ambiguous receipt recoverable by exact lookup.
          const ambiguous = new AppError('PREVIS_STATE_CONFLICT', '预演图像已登记，本地发布回执仍待核对', 503,
            {requestId: identity.requestId, submissionMayHaveSucceeded: true});
          Object.defineProperty(ambiguous, 'cause', {value: cause});
          throw ambiguous;
        });
      });
      return {...identity, asset: toAssetMediaDto(asset)};
    };
    const operation = execute(); running.set(key, operation);
    try {return await operation;} finally {if (running.get(key) === operation) running.delete(key);}
  }
  return {handlers: {
    'previs.output.publish': (input: unknown) => publish(input),
    'previs.output.lookup': (input: unknown) => lookup(input),
  }};
}
