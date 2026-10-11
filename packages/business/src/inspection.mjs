import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {AppError, parse, inspectionArgumentSchemas, inspectionSchemas,timelineOutputPreset,getTimelineSubtitleIssue} from '@mioon/contracts';
import {INSPECTION_ROW_LIMITS as rowLimits, INSPECTION_VERSION_ASSET_EXPRESSION} from './inspection-query.mjs';
import {createImageOwnershipReader} from './image-ownership.mjs';
import {createFrameOwnershipReader,FRAME_OWNERSHIP_LIMITS} from './frame-ownership.mjs';

// This boundary is deliberately independent of legacy get/list/ensure helpers.
// In particular, reading an absent timeline must never initialize one.
export const INSPECTION_OPERATIONS = Object.freeze(['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect']);
export const INSPECTION_LIMITS = Object.freeze({maxCalls: 16, maxResultBytes: 128 * 1024, maxTotalBytes: 512 * 1024,
  maxReadBytes: 4 * 1024 * 1024, maxReadRecords: 1024, promptBytes: 1000, tracks: 12, clips: 100});
const countTables = Object.freeze(['assets', 'shots', 'nodes', 'edges', 'jobs', 'versions', 'exports', 'timelines']);
const operationSet = new Set(INSPECTION_OPERATIONS);
const entityId = inspectionSchemas['project.inspect'].shape.projectId;
const unavailable = () => { throw new AppError('INSPECTION_UNAVAILABLE', 'Inspection data is unavailable', 404); };
const invalid = () => { throw new AppError('VALIDATION_ERROR', 'Invalid inspection arguments', 400); };
const badCursor = () => { throw new AppError('INVALID_CURSOR', 'Invalid or expired inspection cursor', 400); };
const denied = () => { throw new AppError('INSPECTION_SCOPE_DENIED', 'Inspection scope is unavailable', 403); };
const exhausted = () => { throw new AppError('INSPECTION_BUDGET_EXCEEDED', 'Inspection budget exceeded', 429); };
const id = value => { if (typeof value !== 'string' || value.length !== 36 || !entityId.safeParse(value).success) unavailable(); return value; };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable(); return value; };
const string = (value, max, min = 0) => { if (typeof value !== 'string' || value.length < min || value.length > max) unavailable(); return value; };
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) unavailable();
  return Object.is(value, -0) ? 0 : value;
};
const boolean = value => { if (typeof value !== 'boolean') unavailable(); return value; };
const enumValue = (value, choices) => { if (!choices.includes(value)) unavailable(); return value; };
const ids = value => { if (!Array.isArray(value) || value.length > 8) unavailable(); return value.map(id); };
const timestamp = value => string(value, 40);
const optional = (source, fields) => Object.fromEntries(Object.entries(fields).filter(([key]) => Object.hasOwn(source, key)).map(([key, check]) => [key, check(source[key])]));

// Inspect descriptors before schema parsing: getters, proxies, inherited fields,
// and toJSON hooks are never evaluated as model arguments or context options.
function plainInput(value, arrays = false, schemaTypes = false) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || (!arrays && Array.isArray(value))) invalid();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && (value.length > 4 || keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (!/^[0-3]$/.test(String(key)) || Number(key) >= value.length)))) invalid();
  const result = Array.isArray(value) ? [] : {};
  for (const key of keys) {
    if (arrays && Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || key === '__proto__') invalid();
    if (descriptor.value !== null && typeof descriptor.value === 'object') {
      // RPC schemas only accept scalar fields. Preserve an invalid JSON value's
      // type for shared error parity without reading any nested properties.
      if (schemaTypes) {
        if (types.isProxy(descriptor.value)) invalid();
        result[key] = Array.isArray(descriptor.value) ? [] : {};
        continue;
      }
      if (!arrays || key !== 'capabilities' || !Array.isArray(descriptor.value)) invalid();
      result[key] = plainInput(descriptor.value, true);
    } else {
      if (!['string', 'number', 'boolean', 'undefined'].includes(typeof descriptor.value) && descriptor.value !== null) invalid();
      result[key] = descriptor.value;
    }
  }
  return result;
}
function excerpt(value) {
  const text = string(value, 5000), bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= INSPECTION_LIMITS.promptBytes) return {prompt: text, promptTruncated: false};
  let end = INSPECTION_LIMITS.promptBytes;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return {prompt: bytes.subarray(0, end).toString('utf8'), promptTruncated: true};
}

function inspectionReader(db,projectId,{encodeCursor,decodeCursor}={}) {
    const cache = new Map(), validatedVersions = new Set(), validatedAssets = new Set(), assetVersions = new Map(), imageSources = new Map(), frameSources = new Map(), frameTasks = new Set(), pendingFrameTasks = new Set();
    let readBytes = 0, readRecords = 0, frameDepth = 0;
    const consume=text=>{if(++readRecords>INSPECTION_LIMITS.maxReadRecords||(readBytes+=Buffer.byteLength(text))>INSPECTION_LIMITS.maxReadBytes)exhausted();};
    const imageReader=createImageOwnershipReader(db,projectId,{fail:unavailable,consume});
    const frameReader=createFrameOwnershipReader(db,projectId,{fail:unavailable,consume});
    // CASE guards are evaluated by SQLite before data crosses into JavaScript.
    // Oversized/malformed rows are errors, never silently skipped from a page.
    const identity=column=>`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 THEN ${column} END AS ${column}`;
    const columns = table => `${identity('id')}${table === 'projects' ? '' : ','+identity('projectId')}${table === 'versions' ? ','+identity('jobId') : ''},
      CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${rowLimits[table]} THEN CASE WHEN json_valid(data) THEN data ELSE NULL END ELSE NULL END AS data`;
    function materialize(table, row) {
      if (!row || typeof row.data !== 'string') unavailable();
      if (++readRecords > INSPECTION_LIMITS.maxReadRecords || (readBytes += Buffer.byteLength(row.data)) > INSPECTION_LIMITS.maxReadBytes) exhausted();
      let value;
      try { value = JSON.parse(row.data); } catch { unavailable(); }
      object(value);
      if (id(row.id) !== id(value.id) || (table !== 'projects' && (row.projectId !== projectId || value.projectId !== projectId))) unavailable();
      if (table === 'projects' && value.id !== projectId) unavailable();
      if (table === 'versions' && id(row.jobId) !== id(value.jobId)) unavailable();
      cache.set(`${table}:${value.id}`, value);
      return value;
    }
    function get(table, recordId) {
      id(recordId);
      const key = `${table}:${recordId}`;
      if (cache.has(key)) return cache.get(key);
      const row = db.prepare(`SELECT ${columns(table)} FROM ${table} WHERE id=?${table === 'projects' ? '' : ' AND projectId=?'} LIMIT 1`)
        .get(...(table === 'projects' ? [recordId] : [recordId, projectId]));
      return materialize(table, row);
    }
    function referenceAssets(value) {
      const references = ids(value.referenceAssetIds);
      references.forEach(reference => validateAsset(get('assets', reference)));
      return references;
    }
    function snapshotLinks(snapshot, shotId) {
      if (snapshot === undefined) return;
      object(snapshot);
      if (Object.hasOwn(snapshot, 'shotId') && snapshot.shotId !== shotId) unavailable();
      if (Object.hasOwn(snapshot, 'projectId') && snapshot.projectId !== projectId) unavailable();
      if (Object.hasOwn(snapshot, 'referenceAssetIds')) referenceAssets(snapshot);
      if (Object.hasOwn(snapshot, 'referenceAssets')) {
        if (!Array.isArray(snapshot.referenceAssets) || snapshot.referenceAssets.length > 8) unavailable();
        for (const source of snapshot.referenceAssets) {
          object(source); validateAsset(get('assets', id(source.id)));
          if (Object.hasOwn(source, 'projectId') && source.projectId !== projectId) unavailable();
        }
      }
      if (Object.hasOwn(snapshot, 'referenceConnections')) {
        if (!Array.isArray(snapshot.referenceConnections) || snapshot.referenceConnections.length > 8) unavailable();
        for (const connection of snapshot.referenceConnections) {
          object(connection);
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
    function validateVersion(versionId, expectedShotId, expectedAssetId) {
      const version = get('versions', versionId);
      if ((expectedShotId && version.shotId !== expectedShotId) || (expectedAssetId && version.assetId !== expectedAssetId)) unavailable();
      if (validatedVersions.has(versionId)) return version;
      const shot = get('shots', id(version.shotId)), asset = get('assets', id(version.assetId)), job = get('jobs', id(version.jobId));
      if (job.shotId !== shot.id || job.versionId !== version.id) unavailable();
      if (Object.hasOwn(version, 'sha256') && (typeof version.sha256 !== 'string' || version.sha256 !== asset.sha256)) unavailable();
      if (Object.hasOwn(job, 'assetId') && job.assetId !== asset.id) unavailable();
      // Mark only after direct identity checks; this breaks legitimate graph
      // cycles while every encountered relation still receives validation.
      validatedVersions.add(versionId);
      try{
        validateAsset(asset); referenceAssets(shot);
        snapshotLinks(version.snapshot, shot.id); snapshotLinks(job.snapshot, shot.id);
        return version;
      }catch(error){validatedVersions.delete(versionId);throw error;}
    }
    function validateAsset(asset) {
      if (validatedAssets.has(asset.id)) return asset;
      validatedAssets.add(asset.id);
      try{
      // Never trust provenance to hide a reverse relation. Imported assets may
      // have no version; generated assets require exactly one. Foreign and
      // duplicate owners are rejected, including mismatched SQL/JSON scope.
      const rows = db.prepare(`SELECT ${identity('id')} FROM versions WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=? ORDER BY id LIMIT 2`).all(asset.id);
      const images=imageReader.owners(asset.id),frames=frameReader.owners(asset.id),total=rows.length+images.length+frames.length;
      // A damaged oversized legacy owner must never become an unowned import
      // or hide beside a typed owner, regardless of its provenance label.
      if(db.prepare(`SELECT 1 FROM versions WHERE length(CAST(data AS BLOB))>${rowLimits.versions} AND CASE WHEN json_valid(data) THEN json_extract(data,'$.assetId') END=? LIMIT 1`).get(asset.id))unavailable();
      if (total > 1 || (total === 0 && ['generated', 'synthetic-mock', 'extracted-frame'].includes(asset.provenance))) unavailable();
      if (rows.length) assetVersions.set(asset.id, validateVersion(rows[0].id, undefined, asset.id));
      if (images.length) imageSources.set(asset.id,imageReader.source(images[0].id,asset));
      if (frames.length) {
        const source=frameReader.source(id(frames[0].id),asset);
        validateFrameTask(source.frameTaskId);frameSources.set(asset.id,source);
      }
      if(asset.provenance==='extracted-frame'&&!frames.length)unavailable();
      return asset;
      }catch(error){validatedAssets.delete(asset.id);assetVersions.delete(asset.id);imageSources.delete(asset.id);frameSources.delete(asset.id);throw error;}
    }
    function validateFrameTask(taskId) {
      const value=frameReader.task(id(taskId));
      if(frameTasks.has(taskId)||pendingFrameTasks.has(taskId))return value;
      if(++frameDepth>FRAME_OWNERSHIP_LIMITS.maxAncestors){frameDepth--;exhausted();}
      pendingFrameTasks.add(taskId);
      try{
        const source=get('assets',id(value.input.sourceAssetId));
        if(!['video/mp4','video/webm'].includes(source.mimeType)||source.provenance==='extracted-frame')unavailable();
        validateAsset(source);
        if(value.row.assetId!==null){const asset=get('assets',id(value.row.assetId));frameReader.source(taskId,asset);validateAsset(asset);}
        frameTasks.add(taskId);return value;
      }finally{pendingFrameTasks.delete(taskId);frameDepth--;}
    }
    function assetDto(asset) {
      validateAsset(asset);
      return {id: asset.id, name: string(asset.name, 200), mimeType: enumValue(asset.mimeType, ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
        ...optional(asset, {width: value => number(value, 0, 100000, true), height: value => number(value, 0, 100000, true), duration: value => number(value, 0, 864000),
          hasAudio: boolean, hasVideo: boolean, provenance: value => enumValue(value, ['user-import', 'generated', 'synthetic-mock', 'export', 'extracted-frame']), createdAt: timestamp})};
    }
    function shotDto(shot) {
      const references = referenceAssets(shot);
      references.forEach(reference => validateAsset(get('assets', reference)));
      const selected = shot.selectedVersionId === null ? null : validateVersion(id(shot.selectedVersionId), shot.id);
      return {id: shot.id, title: string(shot.title, 150, 1), ...excerpt(shot.prompt), referenceAssetIds: references,
        aspectRatio: enumValue(shot.aspectRatio, ['9:16', '16:9', '1:1', '3:4', '4:3', '21:9']), duration: number(shot.duration, 1, 20, true),
        orderIndex: number(shot.orderIndex, 0, Number.MAX_SAFE_INTEGER, true), revision: number(shot.revision, 1, Number.MAX_SAFE_INTEGER, true),
        selectedVersionId: selected?.id ?? null, selectedVersion: selected ? {id: selected.id, number: number(selected.number, 1, Number.MAX_SAFE_INTEGER, true), assetId: id(selected.assetId),
          ...optional(selected, {providerId: value => enumValue(value, ['mock', 'runway', 'ark', 'veo', 'minimax', 'vidu']), model: value => string(value, 100), isMock: boolean, createdAt: timestamp})} : null};
    }
    function page(table, operation, {limit, cursor}) {
      const after = decodeCursor(cursor, projectId, operation, limit);
      const rows = db.prepare(`SELECT ${columns(table)} FROM ${table} WHERE projectId=? AND id>? ORDER BY id LIMIT ?`).all(projectId, after, limit + 1);
      const items = rows.slice(0, limit).map(row => (table === 'assets' ? assetDto : shotDto)(materialize(table, row)));
      return {items, nextCursor: rows.length > limit ? encodeCursor(projectId, operation, limit, items.at(-1).id) : null};
    }
    function clipSource(clip){
        const asset = validateAsset(get('assets', id(clip.assetId)));
        // Older/future saved clip metadata may carry these additional relation
        // IDs. Validate them if present, but do not expose them in this DTO.
        if (Object.hasOwn(clip, 'versionId')) validateVersion(id(clip.versionId), clip.shotId, asset.id);
        if (Object.hasOwn(clip, 'shotId')) {
          const shot = get('shots', id(clip.shotId));
          if (assetVersions.get(asset.id)?.shotId !== shot.id) unavailable();
        }
        if (Object.hasOwn(clip, 'jobId')) {
          const job = get('jobs', id(clip.jobId)), version = validateVersion(id(job.versionId), job.shotId, asset.id);
          if (version.jobId !== job.id || (Object.hasOwn(clip, 'shotId') && clip.shotId !== job.shotId) || (Object.hasOwn(clip, 'versionId') && clip.versionId !== version.id)) unavailable();
        }
      return asset;
    }
    function ownedTimeline() {
      const row = db.prepare(`SELECT ${columns('timelines')} FROM timelines WHERE projectId=? LIMIT 1`).get(projectId);
      return row ? materialize('timelines', row) : null;
    }
    function timelineDto(timeline = ownedTimeline()) {
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
        const rect = {x: number(clip.rect.x, 0, timeline.width-2, true), y: number(clip.rect.y, 0, timeline.height-2, true), width: number(clip.rect.width, 2, timeline.width, true), height: number(clip.rect.height, 2, timeline.height, true)};
        if (Object.values(rect).some(value => value % 2 !== 0) || rect.x + rect.width > timeline.width || rect.y + rect.height > timeline.height) unavailable();
        const startFrame = number(clip.startFrame, 0, 18000, true), durationFrames = number(clip.durationFrames, 1, 18000, true);
        if (startFrame + durationFrames > 18000) unavailable();
        return {id: clipId, trackId: id(clip.trackId), assetId: asset.id, name: string(clip.name, 200, 1), startFrame, durationFrames,
          sourceInFrame: number(clip.sourceInFrame, 0, Number.MAX_SAFE_INTEGER - 18000, true), rect, gain: number(clip.gain, 0, 2)};
      });
      return {id: timeline.id, revision: number(timeline.revision, 1, Number.MAX_SAFE_INTEGER, true), fps: enumValue(timeline.fps, [30]), width: timeline.width, height: timeline.height,
        durationFrames: number(timeline.durationFrames, 0, 18000, true), tracks, clips};
    }
    const project = get('projects', projectId);
    return {project: () => ({id: project.id, name: string(project.name, 150, 1), description: string(project.description, 2000), revision: number(project.revision, 1, Number.MAX_SAFE_INTEGER, true),
      counts: Object.fromEntries(countTables.map(table => [table, number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE projectId=?`).get(projectId).count, 0, Number.MAX_SAFE_INTEGER, true)]))}),
      assets: args => page('assets', 'asset.inspect', args), shots: args => page('shots', 'shot.inspect', args), timeline: timelineDto, ownedAsset: assetId=>validateAsset(get('assets',id(assetId))),clipSource,
      ownedTimeline:()=>{const timeline=ownedTimeline();if(timeline)timelineDto(timeline);return timeline;},validateTimeline:timelineDto,version:validateVersion,
      imageVersion:(versionId,assetId)=>{const value=imageReader.version(id(versionId));const asset=validateAsset(get('assets',id(assetId??value.assetId)));if(value.assetId!==asset.id)unavailable();return imageReader.version(versionId,asset);},
      imageSource:assetId=>{const asset=validateAsset(get('assets',id(assetId)));return imageSources.get(asset.id)??null;},frameTask:validateFrameTask,
      frameSource:assetId=>{const asset=validateAsset(get('assets',id(assetId)));return frameSources.get(asset.id)??null;}};
  }


// Backend-only validated graph reuse. This is not an RPC, tool capability or
// unscoped raw reader; all paths retain the same bounded project-owner gates.
export function createOwnedMediaGraphReader(db,projectId){
 const read=inspectionReader(db,projectId);
 return {asset:read.ownedAsset,clipSource:read.clipSource,version:read.version,imageVersion:read.imageVersion,imageSource:read.imageSource,frameTask:read.frameTask,frameSource:read.frameSource,timeline:read.ownedTimeline,validateTimeline:read.validateTimeline};
}

export function createInspectionServices(store) {
  const {db} = store, contexts = new WeakMap(), cursorSecret = randomBytes(32);
  const sign = text => createHmac('sha256', cursorSecret).update(text).digest('base64url');
  const encodeCursor = (projectId, operation, limit, after) => {
    const body = Buffer.from(JSON.stringify([1, projectId, operation, limit, after])).toString('base64url');
    return `${body}.${sign(body)}`;
  };
  function decodeCursor(cursor, projectId, operation, limit) {
    if (cursor === undefined) return '';
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) badCursor();
    const [body, signature] = cursor.split('.'), expected = sign(body);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) badCursor();
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { badCursor(); }
    if (!Array.isArray(decoded) || decoded.length !== 5 || decoded[0] !== 1 || decoded[1] !== projectId || decoded[2] !== operation || decoded[3] !== limit || !entityId.safeParse(decoded[4]).success) badCursor();
    return decoded[4];
  }

  const reader=projectId=>inspectionReader(db,projectId,{encodeCursor,decodeCursor});

  // Only trusted backend code receives this factory. It selects scope after
  // authenticating its caller; possessing a project ID is not authentication.
  function createContext(options) {
    const input = plainInput(options, true), allowed = ['projectId', 'capabilities', 'maxCalls', 'maxResultBytes', 'maxTotalBytes'];
    if (Object.keys(input).some(key => !allowed.includes(key)) || !entityId.safeParse(input.projectId).success) invalid();
    const capabilities = input.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > 4 || Object.keys(capabilities).length !== capabilities.length || capabilities.some(op => !operationSet.has(op)) || new Set(capabilities).size !== capabilities.length) invalid();
    const budget = {};
    for (const key of ['maxCalls', 'maxResultBytes', 'maxTotalBytes']) {
      const value = input[key] ?? INSPECTION_LIMITS[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > INSPECTION_LIMITS[key]) invalid();
      budget[key] = value;
    }
    const context = Object.freeze({projectId: input.projectId, capabilities: Object.freeze([...capabilities])});
    contexts.set(context, {projectId: input.projectId, capabilities: new Set(capabilities), ...budget, calls: 0, bytes: 0});
    return context;
  }
  function dispatch(context, operation, args = {}) {
    const scope = contexts.get(context);
    if (!scope) denied();
    if (++scope.calls > scope.maxCalls) exhausted();
    if (!operationSet.has(operation) || !scope.capabilities.has(operation)) denied();
    const input = plainInput(args), parsed = inspectionArgumentSchemas[operation].safeParse(input);
    if (!parsed.success) invalid();
    const read = reader(scope.projectId);
    const value = operation === 'project.inspect' ? read.project() : operation === 'asset.inspect' ? read.assets(parsed.data) : operation === 'shot.inspect' ? read.shots(parsed.data) : read.timeline();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > scope.maxResultBytes || scope.bytes + bytes > scope.maxTotalBytes) exhausted();
    scope.bytes += bytes;
    return value;
  }
  const handlers = Object.freeze(Object.fromEntries(INSPECTION_OPERATIONS.map(operation => [operation, input => {
    if (types.isProxy(input)) invalid();
    const safe = !input || typeof input !== 'object' ? input : Array.isArray(input) ? [] : plainInput(input, false, true);
    const {projectId, ...args} = parse(operation, safe);
    return dispatch(createContext({projectId, capabilities: [operation]}), operation, args);
  }])));
  return Object.freeze({handlers, createContext, dispatch});
}
