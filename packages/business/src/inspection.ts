import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {AppError, parse, inspectionArgumentSchemas, inspectionSchemas,timelineOutputPreset,getTimelineSubtitleIssue,getSubjectGenerationSnapshotIssue,SCENE_KEYFRAME_PROVENANCE} from '@mioon/contracts';
import {INSPECTION_ROW_LIMITS as rowLimits, INSPECTION_VERSION_ASSET_EXPRESSION} from './inspection-query.ts';
import {canonicalImageInput, IMAGE_EDIT_LIMITS} from '../../contracts/src/images.ts';
import {describeImageEditSource} from './images/edit-source.ts';
import {validateImageTaskReview} from './images/reviews.ts';
import {createImageOwnershipReader} from './image-ownership.ts';
import {createFrameOwnershipReader,FRAME_OWNERSHIP_LIMITS} from './frame-ownership.ts';
import {createSubjectOwnershipReader} from './subject-ownership.ts';
import {createSceneKeyframeOwnershipReader} from './scene-keyframe-ownership.ts';
import {isClipTransform,type ClipTransform} from '../../contracts/src/timeline-clip-transform.ts';
import {isClipTransition,type ClipTransition} from '../../contracts/src/timeline-clip-transition.ts';
import type {DatabaseSync} from 'node:sqlite';

type InspectionRecord = Record<string, unknown>;
interface ImageTaskLike {input: {purpose?: string;inputImage?: {assetId?: unknown}};snapshot: {sourceImage?: unknown}}
interface FrameTaskLike {input: {sourceAssetId?: unknown};row: {assetId?: unknown|null}}
interface InspectionReaderOptions {
 encodeCursor?: (projectId: string,operation: string,limit: number,after: string)=>string;
 decodeCursor?: (cursor: unknown,projectId: string,operation: string,limit: number)=>string;
}
export interface OwnedMediaGraphReader {
 subjectAsset(id: string): unknown;subjectOwner(id: string): unknown;subjectVersion(id: string,subjectId?: string): unknown;
 subjectReference(id: string): unknown;validateSubjectReference(value: unknown): unknown;
 asset(assetId: unknown): InspectionRecord;
 clipSource(clip: InspectionRecord): InspectionRecord;
 version(versionId: unknown,expectedShotId?: string|unknown,expectedAssetId?: unknown): InspectionRecord;
 imageVersion(versionId: unknown,assetId?: unknown): unknown;
 imageSource(assetId: unknown): unknown;
 imageTask(taskId: unknown): unknown;
 legacySource(assetId: unknown): unknown;
 frameTask(taskId: unknown): unknown;
 frameSource(assetId: unknown): unknown;
 sceneKeyframeSource(assetId: unknown): unknown;
 timeline(): InspectionRecord|null;
 validateTimeline(timeline: InspectionRecord): Record<string, unknown>|null;
}
export interface InspectionReader {
 project(): Record<string, unknown>;
 assets(args: unknown): {items: unknown[];nextCursor: string|null};
 shots(args: unknown): {items: unknown[];nextCursor: string|null};
 timeline(): Record<string, unknown>|null;
 ownedAsset(assetId: unknown): InspectionRecord;
 clipSource(clip: InspectionRecord): InspectionRecord;
 version(versionId: unknown,expectedShotId?: string,expectedAssetId?: unknown): InspectionRecord;
 imageVersion(versionId: unknown,assetId?: unknown): unknown;
 imageSource(assetId: unknown): unknown;
 imageTask(taskId: unknown): unknown;
 legacySource(assetId: unknown): unknown;
 frameTask(taskId: unknown): unknown;
 frameSource(assetId: unknown): unknown;
 sceneKeyframeSource(assetId: unknown): unknown;
 ownedTimeline(): InspectionRecord|null;
 validateTimeline(timeline: InspectionRecord): Record<string, unknown>|null;
 subjectAsset(id: string): unknown;subjectOwner(id: string): unknown;subjectVersion(id: string,subjectId?: string): unknown;
 subjectReference(id: string): unknown;validateSubjectReference(value: unknown): unknown;
}

// This boundary is deliberately independent of legacy get/list/ensure helpers.
// In particular, reading an absent timeline must never initialize one.
export const INSPECTION_OPERATIONS = Object.freeze(['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect']);
export const INSPECTION_LIMITS = Object.freeze({maxCalls: 16, maxResultBytes: 128 * 1024, maxTotalBytes: 512 * 1024,
  maxReadBytes: 4 * 1024 * 1024, maxReadRecords: 1024, promptBytes: 1000, tracks: 12, clips: 100});
const countTables = Object.freeze(['assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines']);
const operationSet = new Set(INSPECTION_OPERATIONS);
const entityId = inspectionSchemas['project.inspect'].shape.projectId;
const unavailable: ()=>never = () => { throw new AppError('INSPECTION_UNAVAILABLE', 'Inspection data is unavailable', 404); };
const invalid: ()=>never = () => { throw new AppError('VALIDATION_ERROR', 'Invalid inspection arguments', 400); };
const badCursor: ()=>never = () => { throw new AppError('INVALID_CURSOR', 'Invalid or expired inspection cursor', 400); };
const denied: ()=>never = () => { throw new AppError('INSPECTION_SCOPE_DENIED', 'Inspection scope is unavailable', 403); };
const exhausted: ()=>never = () => { throw new AppError('INSPECTION_BUDGET_EXCEEDED', 'Inspection budget exceeded', 429); };
const id = (value: unknown): string => { if (typeof value !== 'string' || value.length !== 36 || !entityId.safeParse(value).success) unavailable(); return value; };
const object = (value: unknown): value is InspectionRecord => { if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable(); return true; };
const string = (value: unknown, max: number, min = 0): string => { if (typeof value !== 'string' || value.length < min || value.length > max) unavailable(); return value; };
const number = (value: unknown, min = 0, max: number = Number.MAX_SAFE_INTEGER, integer = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) unavailable();
  return Object.is(value, -0) ? 0 : value;
};
const boolean = (value: unknown): boolean => { if (typeof value !== 'boolean') unavailable(); return value; };
const enumValue = (value: unknown, choices: readonly unknown[]): string => { if (!choices.includes(value)) unavailable(); return value as string; };
const ids = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 8) unavailable(); return value.map(id); };
const timestamp = (value: unknown): string => string(value, 40);
const optional = (source: InspectionRecord, fields: Record<string,(value: unknown)=>unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(source, key)).map(([key, check]) => [key, check(source[key])]));

// Inspect descriptors before schema parsing: getters, proxies, inherited fields,
// and toJSON hooks are never evaluated as model arguments or context options.
function plainInput(value: unknown, arrays = false, schemaTypes = false): InspectionRecord {
  if (!value || typeof value !== 'object' || types.isProxy(value) || (!arrays && Array.isArray(value))) invalid();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && (value.length > 4 || keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (!/^[0-3]$/.test(String(key)) || Number(key) >= value.length)))) invalid();
  const result: Record<string, unknown>|unknown[] = Array.isArray(value) ? [] : {};
  for (const key of keys) {
    if (arrays && Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || key === '__proto__') invalid();
    if (descriptor.value !== null && typeof descriptor.value === 'object') {
      // RPC schemas only accept scalar fields. Preserve an invalid JSON value's
      // type for shared error parity without reading any nested properties.
      if (schemaTypes) {
        if (types.isProxy(descriptor.value)) invalid();
        (result as Record<string, unknown>)[key] = Array.isArray(descriptor.value) ? [] : {};
        continue;
      }
      if (!arrays || key !== 'capabilities' || !Array.isArray(descriptor.value)) invalid();
      (result as Record<string, unknown>)[key] = plainInput(descriptor.value, true);
    } else {
      if (!['string', 'number', 'boolean', 'undefined'].includes(typeof descriptor.value) && descriptor.value !== null) invalid();
      (result as Record<string, unknown>)[key] = descriptor.value;
    }
  }
  return result as InspectionRecord;
}
function excerpt(value: unknown): {prompt: string;promptTruncated: boolean} {
  const text = string(value, 5000), bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= INSPECTION_LIMITS.promptBytes) return {prompt: text, promptTruncated: false};
  let end = INSPECTION_LIMITS.promptBytes;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return {prompt: bytes.subarray(0, end).toString('utf8'), promptTruncated: true};
}

function inspectionReader(db: DatabaseSync,projectId: string,{encodeCursor,decodeCursor}: InspectionReaderOptions={}): InspectionReader {
    const cache = new Map<string, InspectionRecord>(), validatedVersions = new Set<string>(), validatedAssets = new Set<string>(), assetVersions = new Map<string, InspectionRecord>(), imageSources = new Map<string, unknown>(), frameSources = new Map<string, unknown>(), sceneSources = new Map<string, unknown>(), frameTasks = new Set<string>(), pendingFrameTasks = new Set<string>();
    const pendingAssets=new Set<string>(),imageTasks=new Set<string>(),pendingImageTasks=new Set<string>();
    let readBytes = 0, readRecords = 0, frameDepth = 0;
    const consume=(text: unknown): void=>{if(++readRecords>INSPECTION_LIMITS.maxReadRecords||(readBytes+=Buffer.byteLength(text as string))>INSPECTION_LIMITS.maxReadBytes)exhausted();};
    const imageReader=createImageOwnershipReader(db,projectId,{fail:unavailable,consume,validateSource:validateImageTask});
    const frameReader=createFrameOwnershipReader(db,projectId,{fail:unavailable,consume});
    const sceneReader=createSceneKeyframeOwnershipReader(db,projectId,{fail:unavailable,consume});
    const subjectReader=createSubjectOwnershipReader(db,projectId,{fail:unavailable,notFound:unavailable,consume,resolveAsset:(assetId: string)=>{
      const asset=validateAsset(get('assets',id(assetId)));
      return {asset,legacySource:assetVersions.get(assetId),imageSource:imageSources.get(assetId),frameSource:frameSources.get(assetId),sceneKeyframeSource:sceneSources.get(assetId)} as never;
    }});
    // CASE guards are evaluated by SQLite before data crosses into JavaScript.
    // Oversized/malformed rows are errors, never silently skipped from a page.
    const identity=(column: string): string=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
    const columns = (table: string): string => `${identity('id')}${table === 'projects' ? '' : ','+identity('projectId')}${table === 'versions' ? ','+identity('jobId') : ''},
      CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${(rowLimits as Record<string,number>)[table]} THEN CASE WHEN json_valid(data) THEN data ELSE NULL END ELSE NULL END AS data`;
    function materialize(table: string, row: unknown): InspectionRecord {
      const record=row as Record<string, unknown>|null|undefined;
      if (!record || typeof record.data !== 'string') unavailable();
      if (++readRecords > INSPECTION_LIMITS.maxReadRecords || (readBytes += Buffer.byteLength(record.data)) > INSPECTION_LIMITS.maxReadBytes) exhausted();
      let value: unknown;
      try { value = JSON.parse(record.data); } catch { unavailable(); }
      if(!object(value))unavailable();
      if (id(record.id) !== id(value.id) || (table !== 'projects' && (record.projectId !== projectId || value.projectId !== projectId))) unavailable();
      if (table === 'projects' && value.id !== projectId) unavailable();
      if (table === 'versions' && id(record.jobId) !== id(value.jobId)) unavailable();
      cache.set(`${table}:${value.id}`, value);
      return value;
    }
    function get(table: string, recordId: unknown): InspectionRecord {
      id(recordId);
      const key = `${table}:${recordId}`;
      if (cache.has(key)) return cache.get(key)!;
      const row = db.prepare(`SELECT ${columns(table)} FROM ${table} WHERE id=?${table === 'projects' ? '' : ' AND projectId=?'} LIMIT 1`)
        .get(...(table === 'projects' ? [recordId as string] : [recordId as string, projectId]));
      return materialize(table, row);
    }
    // Ownership only: tails never enter the Agent inspection DTO. Check the
    // optional relation even on historical snapshots without legacy IDs.
    function lastFrameAsset(value: InspectionRecord): void {
      if(Object.hasOwn(value,'lastFrameAssetId')&&value.lastFrameAssetId!==null){
        const tail=validateAsset(get('assets',id(value.lastFrameAssetId)));
        if(!['image/png','image/jpeg','image/webp'].includes(tail.mimeType as string))unavailable();
      }
    }
    function referenceAssets(value: InspectionRecord): string[] {
      const references = ids(value.referenceAssetIds);
      references.forEach(reference => validateAsset(get('assets', reference)));
      lastFrameAsset(value);
      return references;
    }
    function snapshotLinks(snapshot: unknown, shotId: string): void {
      if (snapshot === undefined) return;
      if(!object(snapshot))unavailable();
      if(getSubjectGenerationSnapshotIssue(snapshot,{projectId,requireProfilePin:true}))unavailable();
      if(Object.hasOwn(snapshot,'subjectReference')){
        subjectReader.validateReference(snapshot.subjectReference);
      }
      if (Object.hasOwn(snapshot, 'shotId') && snapshot.shotId !== shotId) unavailable();
      if (Object.hasOwn(snapshot, 'projectId') && snapshot.projectId !== projectId) unavailable();
      if (Object.hasOwn(snapshot, 'referenceAssetIds')) referenceAssets(snapshot);
      else lastFrameAsset(snapshot);
      if (Object.hasOwn(snapshot, 'referenceAssets')) {
        if (!Array.isArray(snapshot.referenceAssets) || snapshot.referenceAssets.length > 8) unavailable();
        for (const source of snapshot.referenceAssets) {
          if(!object(source))unavailable(); validateAsset(get('assets', id(source.id)));
          if (Object.hasOwn(source, 'projectId') && source.projectId !== projectId) unavailable();
        }
      }
      if (Object.hasOwn(snapshot, 'referenceConnections')) {
        if (!Array.isArray(snapshot.referenceConnections) || snapshot.referenceConnections.length > 8) unavailable();
        for (const connection of snapshot.referenceConnections) {
          if(!object(connection))unavailable();
          for (const key of ['assetId', 'sourceAssetId']) if (Object.hasOwn(connection, key)) validateAsset(get('assets', id(connection[key])));
          if (Object.hasOwn(connection, 'sourceNodeId')) {
            const node = get('nodes', id(connection.sourceNodeId));
            if (Object.hasOwn(node, 'assetId')) {
              validateAsset(get('assets', id(node.assetId)));
              if (Object.hasOwn(connection, 'sourceAssetId') && connection.sourceAssetId !== node.assetId) unavailable();
            }
          }
          if (Object.hasOwn(connection, 'edgeId')) {
            // Edges may legitimately be removed after a snapshot was frozen.
            const edgeId = id(connection.edgeId), existing = db.prepare('SELECT id FROM edges WHERE id=? LIMIT 1').get(edgeId);
            if (existing) {
              const edge = get('edges', edgeId);
              if (Object.hasOwn(edge, 'target') && edge.target !== shotId) unavailable();
              if (Object.hasOwn(connection, 'sourceNodeId') && edge.source !== connection.sourceNodeId) unavailable();
              const sourceNode = get('nodes', id(edge.source));
              if (Object.hasOwn(sourceNode, 'assetId')) validateAsset(get('assets', id(sourceNode.assetId)));
              if (Object.hasOwn(edge, 'sourceAssetId')) {
                validateAsset(get('assets', id(edge.sourceAssetId)));
                if (edge.sourceAssetId !== sourceNode.assetId || (Object.hasOwn(connection, 'sourceAssetId') && edge.sourceAssetId !== connection.sourceAssetId)) unavailable();
              }
            }
          }
          if (Object.hasOwn(connection, 'projectId') && connection.projectId !== projectId) unavailable();
          if (Object.hasOwn(connection, 'targetShotId') && connection.targetShotId !== shotId) unavailable();
        }
      }
    }
    function validateVersion(versionId: unknown, expectedShotId?: string|unknown, expectedAssetId?: unknown): InspectionRecord {
      const version = get('versions', versionId);
      if ((expectedShotId && version.shotId !== expectedShotId) || (expectedAssetId && version.assetId !== expectedAssetId)) unavailable();
      if (validatedVersions.has(versionId as string)) return version;
      const shot = get('shots', id(version.shotId)), asset = get('assets', id(version.assetId)), job = get('jobs', id(version.jobId));
      if (job.shotId !== shot.id || job.versionId !== version.id) unavailable();
      if (Object.hasOwn(version, 'sha256') && (typeof version.sha256 !== 'string' || version.sha256 !== asset.sha256)) unavailable();
      if (Object.hasOwn(job, 'assetId') && job.assetId !== asset.id) unavailable();
      // Mark only after direct identity checks; this breaks legitimate graph
      // cycles while every encountered relation still receives validation.
      validatedVersions.add(versionId as string);
      try{
        validateAsset(asset); referenceAssets(shot);
        snapshotLinks(version.snapshot, shot.id as string); snapshotLinks(job.snapshot, shot.id as string);
        return version;
      }catch(error){validatedVersions.delete(versionId as string);throw error;}
    }
    function validateAsset(asset: InspectionRecord,{sourceEdge=false}: {sourceEdge?: boolean}={}): InspectionRecord {
      if(sourceEdge&&pendingAssets.has(asset.id as string))unavailable();
      if (validatedAssets.has(asset.id as string)||pendingAssets.has(asset.id as string)) return asset;
      pendingAssets.add(asset.id as string);
      try{
      // Never trust provenance to hide a reverse relation. Imported assets may
      // have no version; generated assets require exactly one. Foreign and
      // duplicate owners are rejected, including mismatched SQL/JSON scope.
      const rows = db.prepare(`SELECT ${identity('id')} FROM versions WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=? ORDER BY id LIMIT 2`).all(asset.id as string);
      const images=imageReader.owners(asset.id as string) as {id?: unknown}[],frames=frameReader.owners(asset.id as string) as {id?: unknown}[],scenes=sceneReader.owners(asset.id as string);
      const total=rows.length+images.length+frames.length+scenes.length;
      // A damaged oversized legacy owner must never become an unowned import
      // or hide beside a typed owner, regardless of its provenance label.
      if(db.prepare(`SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>${(rowLimits as Record<string,number>).versions} AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=? LIMIT 1`).get(asset.id as string))unavailable();
      if (total > 1 || (total === 0 && ['generated', 'synthetic-mock', 'extracted-frame', SCENE_KEYFRAME_PROVENANCE].includes(asset.provenance as string))) unavailable();
      if (rows.length) assetVersions.set(asset.id as string, validateVersion(rows[0].id, undefined, asset.id));
      if (images.length) imageSources.set(asset.id as string,imageReader.source(id(images[0].id),asset as never) as unknown);
      if (frames.length) {
        const source=frameReader.source(id(frames[0].id),asset as never) as {frameTaskId?: unknown};
        validateFrameTask(source.frameTaskId);frameSources.set(asset.id as string,source);
      }
      if(asset.provenance==='extracted-frame'&&!frames.length)unavailable();
      // A storyboard keyframe belongs to its finished task's receipt and to the
      // unchanged reference video that task decoded.
      if (scenes.length) {
        const source=sceneReader.source(id(scenes[0]!.id),asset as never),video=get('assets',id(source.sourceAssetId));
        if(!['video/mp4','video/webm'].includes(video.mimeType as string)||video.sha256!==source.sourceHash)unavailable();
        validateAsset(video);sceneSources.set(asset.id as string,source);
      }
      if(asset.provenance===SCENE_KEYFRAME_PROVENANCE&&!scenes.length)unavailable();
      validatedAssets.add(asset.id as string);return asset;
      }catch(error){validatedAssets.delete(asset.id as string);assetVersions.delete(asset.id as string);imageSources.delete(asset.id as string);frameSources.delete(asset.id as string);sceneSources.delete(asset.id as string);throw error;}finally{pendingAssets.delete(asset.id as string);}
    }
    function validateImageTask(taskId: unknown): unknown {
      const value=imageReader.task(id(taskId),{shallow:true}) as unknown as {input: {purpose?: string;inputImage?: {assetId?: unknown}};snapshot: {sourceImage?: unknown}};
      if(value.input.purpose!=='edit'||imageTasks.has(taskId as string))return value;
      if(pendingImageTasks.has(taskId as string))unavailable();
      if(pendingImageTasks.size>=IMAGE_EDIT_LIMITS.sourceChainDepth)exhausted();
      pendingImageTasks.add(taskId as string);
      try{
        const source=validateAsset(get('assets',id(value.input.inputImage?.assetId)),{sourceEdge:true});
        if(assetVersions.has(source.id as string))unavailable();
        const descriptor=describeImageEditSource(source as never,imageSources.get(source.id as string) as never,frameSources.get(source.id as string) as never,sceneSources.get(source.id as string));
        if(canonicalImageInput(descriptor)!==canonicalImageInput(value.snapshot.sourceImage))unavailable();
        const review=validateImageTaskReview(db,projectId,taskId as string,value.input as never,{consume});
        if(review&&canonicalImageInput((review as {sourceImage?: unknown}).sourceImage)!==canonicalImageInput(descriptor))unavailable();
        imageTasks.add(taskId as string);return value;
      }finally{pendingImageTasks.delete(taskId as string);}
    }
    function validateFrameTask(taskId: unknown): unknown {
      const value=frameReader.task(id(taskId)) as unknown as {input: {sourceAssetId?: unknown};row: {assetId?: unknown|null}};
      if(frameTasks.has(taskId as string)||pendingFrameTasks.has(taskId as string))return value;
      if(++frameDepth>FRAME_OWNERSHIP_LIMITS.maxAncestors){frameDepth--;exhausted();}
      pendingFrameTasks.add(taskId as string);
      try{
        const source=get('assets',id(value.input.sourceAssetId));
        if(!['video/mp4','video/webm'].includes(source.mimeType as string)||source.provenance==='extracted-frame')unavailable();
        validateAsset(source);
        if(value.row.assetId!==null){const asset=get('assets',id(value.row.assetId));frameReader.source(id(taskId),asset as never);validateAsset(asset);}
        frameTasks.add(taskId as string);return value;
      }finally{pendingFrameTasks.delete(taskId as string);frameDepth--;}
    }
    function assetDto(asset: InspectionRecord): Record<string, unknown> {
      validateAsset(asset);
      return {id: asset.id, name: string(asset.name, 200), mimeType: enumValue(asset.mimeType, ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
        ...optional(asset, {width: value => number(value, 0, 100000, true), height: value => number(value, 0, 100000, true), duration: value => number(value, 0, 864000),
          hasAudio: boolean, hasVideo: boolean, provenance: value => enumValue(value, ['user-import', 'generated', 'synthetic-mock', 'export', 'extracted-frame', SCENE_KEYFRAME_PROVENANCE]), createdAt: timestamp})};
    }
    function shotDto(shot: InspectionRecord): Record<string, unknown> {
      const references = referenceAssets(shot);
      references.forEach(reference => validateAsset(get('assets', reference)));
      const selected = shot.selectedVersionId === null ? null : validateVersion(id(shot.selectedVersionId), shot.id);
      return {id: shot.id, title: string(shot.title, 150, 1), ...excerpt(shot.prompt), referenceAssetIds: references,
        aspectRatio: enumValue(shot.aspectRatio, ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']), duration: number(shot.duration, 1, 20, true),
        orderIndex: number(shot.orderIndex, 0, Number.MAX_SAFE_INTEGER, true), revision: number(shot.revision, 1, Number.MAX_SAFE_INTEGER, true),
        selectedVersionId: selected?.id ?? null, selectedVersion: selected ? {id: selected.id, number: number(selected.number, 1, Number.MAX_SAFE_INTEGER, true), assetId: id(selected.assetId),
          ...optional(selected, {providerId: value => enumValue(value, ['mock', 'runway', 'ark', 'veo', 'minimax', 'vidu']), model: value => string(value, 100), isMock: boolean, createdAt: timestamp})} : null};
    }
    function page(table: string, operation: string, {limit, cursor}: {limit: number;cursor: unknown}): {items: unknown[];nextCursor: string|null} {
      const after = decodeCursor!(cursor, projectId, operation, limit);
      const rows = db.prepare(`SELECT ${columns(table)} FROM ${table} WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(projectId, after, limit + 1);
      const items = rows.slice(0, limit).map(row => (table === 'assets' ? assetDto : shotDto)(materialize(table, row)));
      return {items, nextCursor: rows.length > limit ? encodeCursor!(projectId, operation, limit, (items.at(-1) as InspectionRecord).id as string) : null};
    }
    function clipSource(clip: InspectionRecord): InspectionRecord{
        const asset = validateAsset(get('assets', id(clip.assetId)));
        // Older/future saved clip metadata may carry these additional relation
        // IDs. Validate them if present, but do not expose them in this DTO.
        if (Object.hasOwn(clip, 'versionId')) validateVersion(id(clip.versionId), clip.shotId, asset.id);
        if (Object.hasOwn(clip, 'shotId')) {
          const shot = get('shots', id(clip.shotId));
          if (assetVersions.get(asset.id as string)?.shotId !== shot.id) unavailable();
        }
        if (Object.hasOwn(clip, 'jobId')) {
          const job = get('jobs', id(clip.jobId)), version = validateVersion(id(job.versionId), job.shotId, asset.id);
          if (version.jobId !== job.id || (Object.hasOwn(clip, 'shotId') && clip.shotId !== job.shotId) || (Object.hasOwn(clip, 'versionId') && clip.versionId !== version.id)) unavailable();
        }
      return asset;
    }
    function ownedTimeline(): InspectionRecord|null {
      const row = db.prepare(`SELECT ${columns('timelines')} FROM timelines WHERE projectId=? LIMIT 1`).get(projectId);
      return row ? materialize('timelines', row) : null;
    }
    function timelineDto(timeline: InspectionRecord|null|undefined = ownedTimeline()): Record<string, unknown>|null {
      if (!timeline) return null;
      if (!Array.isArray(timeline.tracks) || timeline.tracks.length > INSPECTION_LIMITS.tracks || !Array.isArray(timeline.clips) || timeline.clips.length > INSPECTION_LIMITS.clips) unavailable();
      if(!timelineOutputPreset(timeline)) unavailable();
      if(Object.hasOwn(timeline,'subtitles')&&getTimelineSubtitleIssue(timeline.subtitles,timeline.durationFrames))unavailable();
      const trackIds = new Set(), clipIds = new Set();
      const tracks = timeline.tracks.map(track => {
        object(track); const trackId = id(track.id); if (trackIds.has(trackId)) unavailable(); trackIds.add(trackId);
        return {id: trackId, name: string(track.name, 150, 1), kind: enumValue(track.kind, ['video', 'audio']), orderIndex: number(track.orderIndex, 0, 11, true), hidden: boolean(track.hidden), muted: boolean(track.muted)};
      });
      const clips = timeline.clips.map(clip => {
        object(clip); const clipId = id(clip.id); if (clipIds.has(clipId) || !trackIds.has(clip.trackId)) unavailable(); clipIds.add(clipId);
        const asset = clipSource(clip);
        object(clip.rect);
        const timelineWidth=number(timeline.width,0,100000),timelineHeight=number(timeline.height,0,100000);
        const rect = {x: number(clip.rect.x, 0, timelineWidth-2, true), y: number(clip.rect.y, 0, timelineHeight-2, true), width: number(clip.rect.width, 2, timelineWidth, true), height: number(clip.rect.height, 2, timelineHeight, true)};
        if (Object.values(rect).some(value => value % 2 !== 0) || rect.x + rect.width > timelineWidth || rect.y + rect.height > timelineHeight) unavailable();
        const startFrame = number(clip.startFrame, 0, 18000, true), durationFrames = number(clip.durationFrames, 1, 18000, true);
        if (startFrame + durationFrames > 18000) unavailable();
        // Mio reads a clip's transform (position and scale keyframes, rotation, crop) but cannot change it.
        const transform = Object.hasOwn(clip, 'transform') ? clip.transform as ClipTransform | null : undefined;
        if (transform !== undefined && (transform === null || !isClipTransform(transform, durationFrames))) unavailable();
        // Mio reads the transition at the cut before a clip (kind and frames) but cannot change it.
        const transition = Object.hasOwn(clip, 'transitionIn') ? clip.transitionIn as ClipTransition | null : undefined;
        if (transition !== undefined && (transition === null || !isClipTransition(transition))) unavailable();
        return {id: clipId, trackId: id(clip.trackId), assetId: asset.id, name: string(clip.name, 200, 1), startFrame, durationFrames,
          sourceInFrame: number(clip.sourceInFrame, 0, Number.MAX_SAFE_INTEGER - 18000, true), rect, gain: number(clip.gain, 0, 2),
          ...(transform ? {transform: {keyframes: transform.keyframes.map(({frame, x, y, scale}) => ({frame, x, y, scale})), rotation: transform.rotation, crop: {...transform.crop}}} : {}),
          ...(transition ? {transitionIn: {kind: transition.kind, durationFrames: transition.durationFrames}} : {})};
      });
      return {id: timeline.id, revision: number(timeline.revision, 1, Number.MAX_SAFE_INTEGER, true), fps: enumValue(timeline.fps, [30]), width: timeline.width, height: timeline.height,
        durationFrames: number(timeline.durationFrames, 0, 18000, true), tracks, clips};
    }
    const project = get('projects', projectId);
    return {project: () => ({id: project.id, name: string(project.name, 150, 1), description: string(project.description, 2000), revision: number(project.revision, 1, Number.MAX_SAFE_INTEGER, true),
      counts: Object.fromEntries(countTables.map((table: string) => [table, number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE projectId=?`).get(projectId) as {count: number}).count, 0, Number.MAX_SAFE_INTEGER, true)]))}),
      subjectAsset:subjectReader.asset,subjectOwner:subjectReader.owner,subjectVersion:subjectReader.version,subjectReference:subjectReader.reference,validateSubjectReference:subjectReader.validateReference,
      assets: (args: unknown) => page('assets', 'asset.inspect', args as {limit: number;cursor: unknown}), shots: (args: unknown) => page('shots', 'shot.inspect', args as {limit: number;cursor: unknown}), timeline: timelineDto, ownedAsset: (assetId: unknown)=>validateAsset(get('assets',id(assetId))),clipSource,
      ownedTimeline:()=>{const timeline=ownedTimeline();if(timeline)timelineDto(timeline);return timeline;},validateTimeline:timelineDto,version:validateVersion,
      imageVersion:(versionId: unknown,assetId?: unknown)=>{const value=imageReader.version(id(versionId)) as {assetId?: unknown};const asset=validateAsset(get('assets',id(assetId??value.assetId)));if(value.assetId!==asset.id)unavailable();return imageReader.version(versionId as string,asset as never);},
      imageTask:validateImageTask,legacySource:(assetId: unknown)=>{const asset=validateAsset(get('assets',id(assetId)));return assetVersions.get(asset.id as string)??null;},
      imageSource:(assetId: unknown)=>{const asset=validateAsset(get('assets',id(assetId)));return imageSources.get(asset.id as string)??null;},frameTask:validateFrameTask,
      frameSource:(assetId: unknown)=>{const asset=validateAsset(get('assets',id(assetId)));return frameSources.get(asset.id as string)??null;},
      sceneKeyframeSource:(assetId: unknown)=>{const asset=validateAsset(get('assets',id(assetId)));return sceneSources.get(asset.id as string)??null;}} as unknown as InspectionReader;
  }


// Backend-only validated graph reuse. This is not an RPC, tool capability or
// unscoped raw reader; all paths retain the same bounded project-owner gates.
export function createOwnedMediaGraphReader(db: DatabaseSync,projectId: string): OwnedMediaGraphReader{
 const read=inspectionReader(db,projectId);
 return {subjectAsset:read.subjectAsset,subjectOwner:read.subjectOwner,subjectVersion:read.subjectVersion,subjectReference:read.subjectReference,validateSubjectReference:read.validateSubjectReference,asset:read.ownedAsset,clipSource:read.clipSource,version:read.version,imageVersion:read.imageVersion,imageSource:read.imageSource,imageTask:read.imageTask,legacySource:read.legacySource,frameTask:read.frameTask,frameSource:read.frameSource,sceneKeyframeSource:read.sceneKeyframeSource,timeline:read.ownedTimeline,validateTimeline:read.validateTimeline};
}

type InspectionScope = {projectId: string;capabilities: Set<unknown>;maxCalls: number;maxResultBytes: number;maxTotalBytes: number;calls: number;bytes: number};
export function createInspectionServices(store: {db: DatabaseSync}) {
  const {db} = store, contexts = new WeakMap<object, InspectionScope>(), cursorSecret = randomBytes(32);
  const sign = (text: string): string => createHmac('sha256', cursorSecret).update(text).digest('base64url');
  const encodeCursor = (projectId: string, operation: string, limit: number, after: string): string => {
    const body = Buffer.from(JSON.stringify([1, projectId, operation, limit, after])).toString('base64url');
    return `${body}.${sign(body)}`;
  };
  function decodeCursor(cursor: unknown, projectId: string, operation: string, limit: number): string {
    if (cursor === undefined) return '';
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) badCursor();
    const [body, signature] = cursor.split('.'), expected = sign(body);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) badCursor();
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { badCursor(); }
    if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 1 || decoded[1] !== projectId || decoded[2] !== operation || decoded[3] !== limit || !entityId.safeParse(decoded[4]).success) badCursor();
    return decoded[4];
  }

  const reader=(projectId: string)=>inspectionReader(db,projectId,{encodeCursor,decodeCursor});

  // Only trusted backend code receives this factory. It selects scope after
  // authenticating its caller; possessing a project ID is not authentication.
  function createContext(options: unknown): object {
    const input = plainInput(options, true), allowed = ['projectId', 'capabilities', 'maxCalls', 'maxResultBytes', 'maxTotalBytes'];
    if (Object.keys(input).some(key => !allowed.includes(key)) || !entityId.safeParse(input.projectId).success) invalid();
    const capabilities = input.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > 4 || Object.keys(capabilities).length !== capabilities.length || capabilities.some(op => !operationSet.has(op)) || new Set(capabilities).size !== capabilities.length) invalid();
    const budget: Record<string, number> = {};
    for (const key of ['maxCalls', 'maxResultBytes', 'maxTotalBytes']) {
      const limits=INSPECTION_LIMITS as Record<string,number>;
      const value = (input[key] ?? limits[key]) as number;
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) invalid();
      budget[key] = value;
    }
    const context = Object.freeze({projectId: input.projectId, capabilities: Object.freeze([...capabilities])});
    contexts.set(context, {projectId: input.projectId as string, capabilities: new Set(capabilities), ...budget, calls: 0, bytes: 0} as unknown as InspectionScope);
    return context;
  }
  function dispatch(context: object, operation: string, args: Record<string,unknown> = {}): unknown {
    const scope = contexts.get(context);
    if (!scope) denied();
    if (++scope.calls > scope.maxCalls) exhausted();
    if (!operationSet.has(operation) || !scope.capabilities.has(operation)) denied();
    const input = plainInput(args), parsed = (inspectionArgumentSchemas as Record<string,{safeParse(value: unknown):{success: boolean;data?: unknown}}>)[operation].safeParse(input);
    if (!parsed.success) invalid();
    const read = reader(scope.projectId);
    const value = operation === 'project.inspect' ? read.project() : operation === 'asset.inspect' ? read.assets(parsed.data) : operation === 'shot.inspect' ? read.shots(parsed.data) : read.timeline();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > scope.maxResultBytes || scope.bytes + bytes > scope.maxTotalBytes) exhausted();
    scope.bytes += bytes;
    return value;
  }
  const handlers: Readonly<Record<string,(input: unknown)=>unknown>> = Object.freeze(Object.fromEntries(INSPECTION_OPERATIONS.map((operation): [string,(input: unknown)=>unknown] => [operation, (input: unknown) => {
    if (types.isProxy(input)) invalid();
    const safe = !input || typeof input !== 'object' ? input : Array.isArray(input) ? [] : plainInput(input, false, true);
    const {projectId, ...args} = (parse as (op: string,input: unknown)=>Record<string,unknown>)(operation, safe);
    return dispatch(createContext({projectId, capabilities: [operation]}), operation, args);
  }])));
  return Object.freeze({handlers, createContext, dispatch});
}
