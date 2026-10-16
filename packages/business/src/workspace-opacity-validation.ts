/** Exact42/43 raw evidence admission. Only already validated opacity leaves are
 * removed in private read-only results passed to unchanged older feature
 * scanners. Catalogs, markers, stored rows and capture hashes are never projected. */
import type {DatabaseSync, SQLInputValue, SQLOutputValue} from 'node:sqlite';
import {captureOpacityTimelineRecord, captureOpacityTimelineIntent} from '../../contracts/src/timeline-opacity-persistence.ts';
import {OPACITY_ENVELOPE_PROFILE} from '../../contracts/src/timeline-opacity-envelope.ts';
import {validateWorkspaceColourRows} from './workspace-colour-validation.ts';
import {validateWorkspaceAudioRoleRows} from './workspace-audio-role-validation.ts';
import {validateWorkspaceVolumeEnvelopeRows} from './workspace-volume-envelope-validation.ts';
import {validateLutResourceRows} from './lut-resource-validation.ts';
import {validateAssetAnnotationRows} from './asset-annotation-validation.ts';

type Value = Record<string, unknown>;
type Row = Record<string, SQLOutputValue>;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const families = [
  ['timelines', ['data']], ['timeline_history', ['beforeSnapshot', 'afterSnapshot']],
  ['timeline_requests', ['response']], ['edit_tasks', ['input']], ['exports', ['data']],
  ['workspace_restore_timeline_history', ['beforeSnapshot', 'afterSnapshot']], ['agent_edit_proposals', ['definition']],
] as const;
const forbiddenKeys = new Set(['opacityEnvelopeProfile', 'opacityEnvelopeProcessingProfile', 'opacityEnvelopeSha256']);
function invalid(): never {throw Object.assign(new Error('Workspace opacity evidence is invalid.'), {code: 'WORKSPACE_OPACITY_INVALID'});}
function containsOpacity(value: unknown): boolean {
  const pending = [{value, depth: 0}]; let nodes = 0, found = false;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 200000 || entry.depth > 128) invalid();
    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (object(entry.value)) {
      if ([...forbiddenKeys].some(key => own(entry.value as object, key))) invalid();
      if (own(entry.value, 'opacityEnvelope') || entry.value.profileId === OPACITY_ENVELOPE_PROFILE) found = true;
    }
    const children = Object.values(entry.value);
    if (nodes + pending.length + children.length > 200000) invalid();
    for (const child of children) pending.push({value: child, depth: entry.depth + 1});
  }
  return found;
}
function projectRecord(record: Value): Value {
  if (!Array.isArray(record.clips)) invalid();
  return {...record, clips: record.clips.map((clip: unknown) => {
    if (!object(clip)) invalid();
    return Object.fromEntries(Object.entries(clip).filter(([key]) => key !== 'opacityEnvelope'));
  })};
}

export function validateOpacityWorkspaceRows(db: DatabaseSync, {schemaVersion}: {readonly schemaVersion: 42 | 43}): void {
  if (schemaVersion !== 42 && schemaVersion !== 43) invalid();
  const projections = new Map<string, string>();
  const names = new Set<unknown>();
  const relevant = new Set<string>(['projects', 'assets', ...families.map(([table]) => table)]);
  let catalogEntries = 0;
  for (const row of db.prepare("SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql END AS sql FROM main.sqlite_schema LIMIT 1025").iterate()) {
    if (++catalogEntries > 1024 || typeof row.name !== 'string') invalid();
    if (!relevant.has(row.name)) continue;
    if (names.has(row.name) || row.type !== 'table' || typeof row.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(row.sql)) invalid();
    names.add(row.name);
  }
  const timelines = new Map<string, Value>();
  function owner(projectId: unknown): asserts projectId is string {
    if (!uuid(projectId) || !db.prepare('SELECT 1 FROM main.projects WHERE id=? LIMIT 1').get(projectId)) invalid();
  }
  function sources(record: Value, projectId: string): void {
    if (!Array.isArray(record.clips)) invalid();
    for (const clip of record.clips) {
      if (!object(clip) || !own(clip, 'opacityEnvelope')) continue;
      if (!uuid(clip.assetId)) invalid();
      const row = db.prepare("SELECT projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 THEN data END AS data,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 131072 AND json_valid(data) THEN EXISTS(SELECT 1 FROM json_tree(data) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END AS duplicates FROM main.assets WHERE id=? LIMIT 1").get(clip.assetId);
      if (!row || row.projectId !== projectId || typeof row.data !== 'string' || row.duplicates !== 0) invalid();
      let asset: unknown; try {asset = JSON.parse(row.data);} catch {invalid();}
      if (!object(asset) || asset.id !== clip.assetId || asset.projectId !== projectId ||
          !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(String(asset.mimeType))) invalid();
    }
  }
  function captureRecord(value: unknown, projectId: unknown): Value {
    owner(projectId);
    const captured = captureOpacityTimelineRecord(value, {projectId}).record;
    if (!object(captured)) invalid();
    sources(captured, projectId);
    return captured;
  }
  function timeline(projectId: string): Value {
    const known = timelines.get(projectId); if (known) return known;
    const row = db.prepare("SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 262144 THEN data END AS data FROM main.timelines WHERE projectId=? LIMIT 1").get(projectId);
    if (!row || row.projectId !== projectId || typeof row.data !== 'string') invalid();
    let parsed: unknown; try {parsed = JSON.parse(row.data);} catch {invalid();}
    const result = captureRecord(parsed, projectId);
    if (result.id !== row.id) invalid();
    timelines.set(projectId, result); return result;
  }
  let cells = 0, bytes = 0;
  for (const [table, fields] of families) {
    if (!names.has(table)) continue;
    const columns = new Set(db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row => row.name));
    // No new not-applied vocabulary is introduced by this persistence slice.
    // Unknown/early opacity failures remain unknown outcomes, never durable
    // evidence that an action was definitely not applied.
    if (table === 'edit_tasks' && columns.has('errorCode') && db.prepare("SELECT 1 FROM main.edit_tasks WHERE CAST(errorCode AS TEXT) GLOB '*OPACITY*' LIMIT 1").get()) invalid();
    const sqlOwner = columns.has('projectId') ? 'projectId' : 'NULL';
    const operation = columns.has('operation') ? 'operation' : 'NULL';
    const identity = table === 'timeline_requests' || table === 'edit_tasks' ? 'requestId' : 'id';
    for (const field of fields) {
      const column = quote(field), bounded = `typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 4194304`;
      const query = `SELECT ${sqlOwner} AS owner,${operation} AS operation,${identity} AS identity,CASE WHEN ${bounded} THEN ${column} END AS value,CASE WHEN ${bounded} THEN json_valid(${column}) ELSE 0 END AS valid,CASE WHEN ${bounded} THEN CASE WHEN json_valid(${column}) THEN EXISTS(SELECT 1 FROM json_tree(${column}) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1) ELSE 1 END ELSE 1 END AS duplicates FROM main.${quote(table)} LIMIT 20001`;
      for (const row of db.prepare(query).iterate()) {
        if (++cells > 80000 || typeof row.value !== 'string' || row.valid !== 1 || row.duplicates !== 0 || (bytes += Buffer.byteLength(row.value)) > 128 * 1024 * 1024) invalid();
        let parsed: unknown; try {parsed = JSON.parse(row.value);} catch {invalid();}
        const hasOpacity = containsOpacity(parsed);
        if (!hasOpacity && table !== 'timelines') continue;
        if (!object(parsed)) invalid();
        let projection: Value;
        if (table === 'timelines') {
          const captured = captureRecord(parsed, row.owner);
          if (captured.id !== row.identity) invalid();
          timelines.set(String(row.owner), captured); projection = projectRecord(captured);
        } else if (table === 'timeline_history' || table === 'workspace_restore_timeline_history') {
          owner(row.owner);
          if (!['tracks', 'clips', 'durationFrames'].every(key => own(parsed, key)) || Object.keys(parsed).some(key => !['tracks', 'clips', 'durationFrames', 'subtitles'].includes(key))) invalid();
          const base = timeline(row.owner);
          const complete: Value = {...base, tracks: parsed.tracks, clips: parsed.clips, durationFrames: parsed.durationFrames};
          delete complete.subtitles;
          if (own(parsed, 'subtitles')) complete.subtitles = parsed.subtitles;
          const captured = captureRecord(complete, row.owner), projected = projectRecord(captured);
          projection = {tracks: projected.tracks, clips: projected.clips, durationFrames: projected.durationFrames,
            ...(own(parsed, 'subtitles') ? {subtitles: projected.subtitles} : {})};
        } else if (table === 'edit_tasks') {
          owner(row.owner);
          if (parsed.projectId !== row.owner || parsed.requestId !== row.identity || !['timeline.clip.add', 'timeline.clip.update'].includes(String(row.operation))) invalid();
          const op = row.operation as 'timeline.clip.add' | 'timeline.clip.update';
          const captured = captureOpacityTimelineIntent(op, parsed, {trackKind: 'video', durationFrames: 18000}).input;
          if (!object(captured)) invalid();
          const fields = op === 'timeline.clip.add' ? captured : captured.patch;
          if (!object(fields)) invalid();
          const projectedFields = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'opacityEnvelope'));
          // Validation-only counterpart for an opacity-only historical intent.
          if (op === 'timeline.clip.update' && !Object.keys(projectedFields).length) projectedFields.gain = 0;
          projection = op === 'timeline.clip.add' ? projectedFields : {...captured, patch: projectedFields};
        } else if (table === 'timeline_requests') {
          // No opacity rendering or loudness application is exposed by this
          // dormant persistence slice. Only complete timeline ACKs are allowed.
          if (own(parsed, 'snapshot') || own(parsed, 'timeline') || own(parsed, 'assets')) invalid();
          const captured = captureRecord(parsed, parsed.projectId);
          projection = projectRecord(captured);
        } else {
          // Old Agent and render entrypoints may not borrow a new effect merely
          // because a timeline projection can be parsed by an old validator.
          invalid();
        }
        if (containsOpacity(projection)) invalid();
        if (hasOpacity) projections.set(row.value, JSON.stringify(projection));
      }
    }
  }
  // Only JSON result strings already proved above are projected. Native SQL
  // identity/ownership/catalog/marker reads remain exact, and no write method is
  // exposed. Old classifiers and constructors never receive this adapter.
  const projectRow = (row: Row | undefined): Row | undefined => {
    if (!row) return row;
    const result = {...row};
    for (const [key, value] of Object.entries(result)) if (typeof value === 'string' && projections.has(value)) result[key] = projections.get(value)!;
    return result;
  };
  const view: Pick<DatabaseSync, 'prepare'> = {prepare(sql: string) {
    if (!/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) invalid();
    const statement = db.prepare(sql);
    return new Proxy(statement, {get(target, key) {
      if (key === 'get') return (...args: SQLInputValue[]) => projectRow(target.get(...args));
      if (key === 'all') return (...args: SQLInputValue[]) => target.all(...args).map(row => projectRow(row)!);
      if (key === 'iterate') return function* (...args: SQLInputValue[]) {for (const row of target.iterate(...args)) yield projectRow(row)!;};
      if (key === 'run') return () => invalid();
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    }});
  }};
  validateWorkspaceVolumeEnvelopeRows(view, {allowVolumeEnvelopes: true});
  validateWorkspaceAudioRoleRows(view, {allowAudioRoles: true, frozenEvidenceProfile: 'workspace40-restored41'});
  validateWorkspaceColourRows(view, {allowColour: true, allowMixedImages: true, allowJpegImages: true, frozenEvidenceProfile: 'workspace40-restored41'});
  validateLutResourceRows(db);
  validateAssetAnnotationRows(db);
}
