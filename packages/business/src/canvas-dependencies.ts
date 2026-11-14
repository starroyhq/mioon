import {createHash} from 'node:crypto';
import {agentTaskTargetSchema} from '../../contracts/src/agent-tasks-v2.ts';
import type {CanvasArchiveShotImpact, CanvasTarget} from '../../contracts/src/canvas-editing.ts';
import {mioClaimSchema} from '../../contracts/src/mio-records.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {isTimelineRecord, TIMELINE_RESPONSE_BYTES} from '../../contracts/src/timeline-replacement.ts';
import {createMioRecords} from './agent/mio-records.ts';
import {agentTaskExplicitTargets} from './agent/task-tools-v2.ts';
import {INSPECTION_VERSION_ASSET_EXPRESSION} from './inspection-query.ts';
import type {ProjectStore} from './project-file/store.ts';
import {pendingPrevisPublications} from './previs-publication.ts';
import {assertProjectStore} from './store-runtime.ts';

interface CanvasBlocker {readonly kind: string; readonly id: string; readonly reason: string}
type ShotImpact = Omit<CanvasArchiveShotImpact, 'number'>;
interface CanvasDependencies {
  readonly shotImpacts: ReadonlyMap<string, Readonly<ShotImpact>>;
  readonly versions: number;
  readonly clips: number;
  readonly blocked: readonly CanvasBlocker[];
  readonly digest: string;
}
interface VersionEvidence {readonly id: string; readonly jobId: string; readonly shotId: string; readonly assetId: string; readonly sha256: string}
type Identity = {readonly kind: string; readonly id: string};

const MAX_PROOFS = 8192;
const MAX_BLOCKERS = 128;
const MAX_VERSION_DATA = 65536;
const MAX_PROCESS_DATA = 2 * 1024 * 1024;
const MAX_PROCESS_PROOF_BYTES = 32 * 1024 * 1024;
const BOUND_EXPORT_STATUSES = ['queued', 'running', 'failed', 'succeeded', 'cancelled'];
const KNOWN_JOB_STATUSES = ['queued', 'submitting', 'running', 'downloading', 'submission_unknown', 'failed', 'succeeded', 'cancelled'];
const SAFE_HASH = /^[a-f0-9]{64}$/u;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identityKey = ({kind, id}: Identity): string => `${kind}:${id}`;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const bounded = (column: string, bytes: number): string =>
  `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;

function decode(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : null;}
  catch {return null;}
}

function ownedRow(value: unknown, id: unknown, projectId: string): Record<string, unknown> | null {
  const record = decode(value);
  return record && isProjectId(id) && record.id === id && record.projectId === projectId ? record : null;
}

function readVersions(store: ProjectStore, shots: ReadonlySet<string>, unverified: (id: unknown) => void,
  limited: (source: string) => void): VersionEvidence[] {
  if (!shots.size) return [];
  // Project version rows survive ordinary copy and may lack their old job.
  // JSON is read only for the owned identity and provenance fields needed here.
  const values = store.db.prepare(`WITH scoped AS (
    SELECT id,jobId,${bounded('data', MAX_VERSION_DATA)} AS data FROM project.versions WHERE projectId=?
  ), decoded AS (
    SELECT id,jobId,CASE WHEN json_valid(data) THEN data END AS data FROM scoped
  )
  SELECT id,jobId,json_extract(data,'$.id') AS jsonId,json_extract(data,'$.projectId') AS jsonProjectId,
    json_extract(data,'$.jobId') AS jsonJobId,json_extract(data,'$.shotId') AS shotId,json_extract(data,'$.assetId') AS assetId,
    json_extract(data,'$.sha256') AS sha256
  FROM decoded WHERE json_type(data,'$.shotId') IS NOT 'text' OR json_extract(data,'$.shotId') IN (SELECT value FROM json_each(?))
    ORDER BY id LIMIT ${MAX_PROOFS + 1}`).all(store.projectId, JSON.stringify([...shots]));
  if (values.length > MAX_PROOFS) limited('versions');
  const versions: VersionEvidence[] = [];
  for (const row of values.slice(0, MAX_PROOFS)) {
    if (!isProjectId(row.id) || row.id !== row.jsonId || row.jsonProjectId !== store.projectId ||
        !isProjectId(row.jobId) || row.jobId !== row.jsonJobId || !isProjectId(row.shotId) || !isProjectId(row.assetId) ||
        typeof row.sha256 !== 'string' || !SAFE_HASH.test(row.sha256)) {unverified(row.id); continue;}
    versions.push({id: row.id, jobId: row.jobId, shotId: row.shotId, assetId: row.assetId, sha256: row.sha256});
  }
  return versions;
}

function generationStatus(job: Record<string, unknown>): string | null {
  if (job.status === 'failed' || job.status === 'succeeded') return null;
  if (job.status === 'cancelled') {
    return job.cancelScope === 'local_only' && (job.providerJobId || Number(job.submissionCount) > 0) ? 'GENERATION_OUTCOME_UNKNOWN' : null;
  }
  return job.status === 'submission_unknown' ? 'GENERATION_OUTCOME_UNKNOWN' : 'GENERATION_ACTIVE';
}

/** Snapshot only what can affect the admitted selection. The caller supplies
 * the full write closure and repeats this check in the write transaction. */
export function inspectCanvasDependencies(store: ProjectStore, targets: readonly CanvasTarget[],
  impactTargets: readonly CanvasTarget[] = targets, {reportShotImpacts = false} = {}): CanvasDependencies {
  assertProjectStore(store);
  const {db, projectId} = store;
  const keys = new Set(targets.map(identityKey));
  const shots = new Set(targets.filter(target => target.kind === 'shot').map(target => target.id));
  const nodes = new Set(targets.filter(target => target.kind === 'node').map(target => target.id));
  const impactShots = new Set(impactTargets.filter(target => target.kind === 'shot').map(target => target.id));
  const has = (kind: string, id: unknown): boolean => typeof id === 'string' && keys.has(identityKey({kind, id}));
  const hash = createHash('sha256');
  const evidence = (value: unknown): void => {hash.update(JSON.stringify(value) + '\n');};
  evidence([1, projectId, [...keys].sort(compare), [...impactShots].sort(compare)]);
  const blockers: CanvasBlocker[] = [];
  let overflow = false;
  function block(kind: string, id: unknown, reason: string, proof?: unknown): void {
    const item = {kind, id: isProjectId(id) ? id : kind, reason};
    evidence([item, proof]);
    if (blockers.length < MAX_BLOCKERS) blockers.push(item);
    else overflow = true;
  }
  const unverified = (kind: string, id: unknown) => block(kind, id, 'CANVAS_DEPENDENCY_UNVERIFIED');
  const limited = (kind: string) => block(kind, kind, 'CANVAS_DEPENDENCY_LIMIT');
  const versions = readVersions(store, shots, id => unverified('version', id), limited);
  const versionIds = new Set(versions.map(row => row.id)), assetIds = new Set(versions.map(row => row.assetId));
  const jobIds = new Set(versions.map(row => row.jobId));
  const impactVersions = versions.filter(row => impactShots.has(row.shotId));
  const impactVersionIds = new Set(impactVersions.map(row => row.id)), impactAssetIds = new Set(impactVersions.map(row => row.assetId));
  const impactJobIds = new Set(impactVersions.map(row => row.jobId));
  const shotImpacts = new Map<string, ShotImpact>();
  const jobShots = new Map<string, Set<string>>(), assetShots = new Map<string, Set<string>>();
  const impactVersionsByJob = new Map<string, VersionEvidence>();
  function countFor(shotId: string): ShotImpact {
    const existing = shotImpacts.get(shotId);
    if (existing) return existing;
    const impact = {versions: 0, clips: 0, usedVersions: 0};
    shotImpacts.set(shotId, impact);
    return impact;
  }
  function addOwner(index: Map<string, Set<string>>, id: string, shotId: string): void {
    const owners = index.get(id) ?? new Set<string>();
    owners.add(shotId);
    index.set(id, owners);
  }
  if (reportShotImpacts) for (const version of impactVersions) {
    const {shotId, jobId, assetId} = version;
    countFor(shotId).versions++;
    addOwner(jobShots, jobId, shotId);
    addOwner(assetShots, assetId, shotId);
    impactVersionsByJob.set(jobId, version);
  }
  for (const version of versions) evidence(['version', version]);

  const versionOwners = new Map(versions.map(version => [version.id, version]));
  const usedVersionIds = new Set<string>();
  const assetVersionOwners = reportShotImpacts && impactAssetIds.size ? db.prepare(`SELECT id FROM project.versions
    WHERE ${INSPECTION_VERSION_ASSET_EXPRESSION}=? ORDER BY id LIMIT 2`) : undefined;
  function versionForAsset(assetId: string): VersionEvidence | undefined {
    // Resolve implicit sources only when the same asset has one owner across
    // the project, even when the other owning shot is outside the selection.
    if (!assetVersionOwners || !impactAssetIds.has(assetId)) return;
    const owners = assetVersionOwners.all(assetId);
    if (owners.length === 1 && typeof owners[0]?.id === 'string') return versionOwners.get(owners[0].id);
  }
  const timelineRow = shots.size ? db.prepare(`SELECT id,${bounded('data', TIMELINE_RESPONSE_BYTES)} AS data FROM project.timelines WHERE projectId=?`).get(projectId) : undefined;
  const timeline = timelineRow ? ownedRow(timelineRow.data, timelineRow.id, projectId) : null;
  const clipIds = new Set<string>();
  let impactClips = 0;
  if (timelineRow) {
    if (!isTimelineRecord(timeline, {projectId})) unverified('timeline', timelineRow.id);
    else {
      const hidden = new Map(timeline.tracks.map(track => [track.id, track.hidden]));
      for (const clip of [...timeline.clips].sort((a, b) => compare(a.id, b.id))) {
        if (!(has('shot', clip.shotId) || clip.versionId && versionIds.has(clip.versionId) ||
              clip.jobId && jobIds.has(clip.jobId) || assetIds.has(clip.assetId))) continue;
        clipIds.add(clip.id);
        const explicit = clip.versionId ? versionOwners.get(clip.versionId) : undefined;
        const linkedShot = clip.shotId && impactShots.has(clip.shotId) ? clip.shotId : undefined;
        if (linkedShot || clip.versionId && impactVersionIds.has(clip.versionId) ||
            clip.jobId && impactJobIds.has(clip.jobId) || impactAssetIds.has(clip.assetId)) {
          impactClips++;
          if (reportShotImpacts) {
            // A clip may mention the same shot through several identifiers.
            // Match existing aggregate evidence and count once per shot.
            const consumers = new Set(assetShots.get(clip.assetId));
            if (clip.jobId) for (const id of jobShots.get(clip.jobId) ?? []) consumers.add(id);
            if (linkedShot) consumers.add(linkedShot);
            if (explicit && impactShots.has(explicit.shotId)) consumers.add(explicit.shotId);
            for (const id of consumers) countFor(id).clips++;

            // A known clip can matter to confirmation even when it is not
            // attributable to a particular generated version.
            const version = clip.versionId ? explicit : clip.jobId ? impactVersionsByJob.get(clip.jobId) : versionForAsset(clip.assetId);
            if (version && impactShots.has(version.shotId) && version.assetId === clip.assetId &&
                (!clip.shotId || clip.shotId === version.shotId) && (!clip.jobId || clip.jobId === version.jobId) &&
                !usedVersionIds.has(version.id)) {
              usedVersionIds.add(version.id);
              countFor(version.shotId).usedVersions++;
            }
          }
        }
        evidence(['clip', timeline.id, clip.id, clip.assetId, clip.shotId, clip.versionId, clip.jobId, clip.trackId, hidden.get(clip.trackId)]);
        if (explicit && (explicit.assetId !== clip.assetId || clip.shotId && explicit.shotId !== clip.shotId ||
            clip.jobId && explicit.jobId !== clip.jobId)) unverified('clip', clip.id);
      }
    }
  }

  let bytes = 0;
  function activeRows(table: 'jobs' | 'exports'): Array<{id: unknown; data: Record<string, unknown>}> {
    // Filter only known terminal states in SQL. Unknown or corrupt data must
    // fail closed rather than making an in-flight write appear absent.
    const predicate = table === 'jobs' ? ` OR (json_extract(data,'$.status')='cancelled' AND json_extract(data,'$.cancelScope')='local_only'
      AND (json_extract(data,'$.providerJobId') IS NOT NULL OR coalesce(json_extract(data,'$.submissionCount'),0)>0))` : '';
    const rows = db.prepare(`WITH scoped AS (SELECT id,${bounded('data', MAX_PROCESS_DATA)} AS data FROM main.${table} WHERE projectId=?),
      decoded AS (SELECT id,CASE WHEN json_valid(data) THEN data END AS data FROM scoped)
      SELECT id,data FROM decoded WHERE coalesce(json_extract(data,'$.status'),'invalid') NOT IN ('failed','succeeded','cancelled')${predicate}
      ORDER BY id LIMIT ${MAX_PROOFS + 1}`).iterate(projectId);
    const result: Array<{id: unknown; data: Record<string, unknown>}> = [];
    let count = 0;
    for (const row of rows) {
      if (++count > MAX_PROOFS || (bytes += typeof row.data === 'string' ? Buffer.byteLength(row.data) : 0) > MAX_PROCESS_PROOF_BYTES) {
        limited(table); break;
      }
      const record = ownedRow(row.data, row.id, projectId);
      if (!record) unverified(table, row.id);
      else result.push({id: row.id, data: record});
    }
    return result;
  }

  if (keys.size) for (const {id, data} of activeRows('jobs')) {
    const snapshot = data.snapshot;
    if (typeof data.status !== 'string' || !KNOWN_JOB_STATUSES.includes(data.status) || !isProjectId(data.shotId) ||
        !object(snapshot) || snapshot.shotId !== data.shotId || snapshot.referenceConnections !== undefined &&
        (!Array.isArray(snapshot.referenceConnections) || snapshot.referenceConnections.some(connection => !object(connection) ||
          !isProjectId(connection.sourceNodeId) || !isProjectId(connection.edgeId)))) {unverified('job', id); continue;}
    if (!shots.has(data.shotId) && !(Array.isArray(snapshot.referenceConnections) && snapshot.referenceConnections.some(connection =>
      has('node', connection.sourceNodeId) || has('edge', connection.edgeId)))) continue;
    const status = generationStatus(data);
    if (status !== null) block('job', id, status, [data.shotId, data.revision, data.status, data.phase, data.cancelScope]);
  }
  if (shots.size) for (const {id, data} of activeRows('exports')) {
    if (typeof data.status !== 'string' || !BOUND_EXPORT_STATUSES.includes(data.status)) {unverified('export', id); continue;}
    // Storyboard exports retain explicit provenance. Timeline exports use a
    // frozen timeline; its only possible impact here is a retained source.
    const snapshot = data.snapshot;
    const sources: unknown[] = Array.isArray(snapshot) ? snapshot : object(snapshot) && Array.isArray(snapshot.clips) ? snapshot.clips : [];
    if (sources.some(source => object(source) && (has('shot', source.shotId) || typeof source.assetId === 'string' && assetIds.has(source.assetId) ||
      typeof source.versionId === 'string' && versionIds.has(source.versionId)))) block('export', id, 'EXPORT_ACTIVE', [data.revision, data.status]);
    else if (Array.isArray(snapshot) && snapshot.some(source => !object(source) || !isProjectId(source.shotId) || !isProjectId(source.assetId))) unverified('export', id);
  }

  // Owner heartbeats do not invalidate confirmation; acquiring, changing or
  // releasing any matching owner does. Clip drafts are also retained and can
  // block even if a different document's edit owner has gone away.
  const related = new Set(keys);
  for (const id of clipIds) related.add(identityKey({kind: 'timeline_clip', id}));
  function touches(target: Identity): boolean {
    return related.has(identityKey(target)) || target.kind === 'version' && versionIds.has(target.id) ||
      target.kind === 'job' && jobIds.has(target.id);
  }
  const editTasks = db.prepare(`SELECT id,operation,input,status,revision,digest FROM main.edit_tasks
    WHERE projectId=? AND status IN ('prepared','dispatching','unknown') ORDER BY id`).all(projectId);
  for (const edit of editTasks) {
    const input = decode(edit.input);
    if (!input || input.projectId !== projectId || typeof edit.operation !== 'string') {unverified('edit-task', edit.id); continue;}
    const exactTarget = agentTaskExplicitTargets(edit.operation, input, projectId).some(touches);
    // These timeline commands can affect a retained clip or synthesize a
    // new one without naming a clip, shot or version in their input.
    const timelineScope = edit.operation === 'timeline.seed' ? shots.size > 0 : clipIds.size > 0 &&
      ['timeline.track.update', 'timeline.undo', 'timeline.redo', 'timeline.format.set', 'timeline.loudness.apply'].includes(edit.operation);
    if (exactTarget || timelineScope) block('edit-task', edit.id, edit.status === 'unknown' ? 'EDIT_OUTCOME_UNKNOWN' : 'EDIT_TASK_ACTIVE',
      [edit.operation, edit.revision, edit.status, edit.digest]);
  }
  const claims = db.prepare(`SELECT * FROM main.mio_edit_claims WHERE projectId=?
    AND kind||':'||targetId IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ${MAX_PROOFS + 1}`).all(projectId, JSON.stringify([...related]));
  if (claims.length > MAX_PROOFS) limited('claim');
  for (const row of claims.slice(0, MAX_PROOFS)) {
    const claim = mioClaimSchema.safeParse(row);
    if (!claim.success) {unverified('claim', row.id); continue;}
    const {id, ownerId, kind, targetId, revision, state} = claim.data;
    block('claim', id, state === 'active' ? 'EDIT_CLAIM_ACTIVE' : 'EDIT_CLAIM_UNCERTAIN', [ownerId, kind, targetId, revision, state]);
  }
  for (const row of db.prepare(`SELECT shotId,draftRevision,intentRevision,intentStatus FROM main.local_shot_text_drafts
    WHERE projectId=? AND shotId IN (SELECT value FROM json_each(?))
      AND (json_type(data,'$.draft')='object' OR intentStatus='pending') ORDER BY shotId`).all(projectId, JSON.stringify([...shots]))) {
    block('draft', row.shotId, row.intentStatus === 'pending' ? 'SHOT_TEXT_OUTCOME_UNKNOWN' : 'SHOT_TEXT_DRAFT', [row.draftRevision, row.intentRevision]);
  }
  for (const row of db.prepare(`SELECT clipId,revision FROM main.local_clip_drafts WHERE projectId=?
    AND clipId IN (SELECT value FROM json_each(?)) AND json_type(data,'$.draft')='object' ORDER BY clipId`).all(projectId, JSON.stringify([...clipIds]))) {
    block('draft', row.clipId, 'CLIP_DRAFT', row.revision);
  }

  const records = createMioRecords(store);
  const steps = db.prepare(`SELECT s.id,s.runId,s.status,s.sourceEntryId,s.sourceCallIndex,
      ${bounded('s.data', MAX_PROCESS_DATA)} AS data,coalesce(e.payloadJson,b.content) IS NOT NULL AS sourcePresent,
      length(CAST(coalesce(e.payloadJson,b.content) AS BLOB)) AS sourceBytes
    FROM main.mio_steps s LEFT JOIN main.mio_entries e ON e.id=s.sourceEntryId AND e.projectId=s.projectId AND e.runId=s.runId
    LEFT JOIN main.mio_blobs b ON b.sha256=e.payloadBlobHash
    WHERE s.projectId=? AND s.kind='tool' AND s.status IN ('dispatch_started','unknown')
    AND s.tier IS NOT 'read_only' ORDER BY s.id LIMIT ${MAX_PROOFS + 1}`).iterate(projectId);
  let stepCount = 0;
  for (const step of steps) {
    if (++stepCount > MAX_PROOFS || (bytes += typeof step.data === 'string' ? Buffer.byteLength(step.data) : 0) > MAX_PROCESS_PROOF_BYTES) {
      limited('mio-step'); break;
    }
    const meta = decode(step.data);
    if (!meta) {unverified('mio-step', step.id); continue;}
    const data = object(meta.data) ? meta.data : {};
    const controls = object(meta.controls) ? meta.controls : {};
    const references: Identity[] = [];
    let malformed = false;
    for (const values of [controls.targets, data.referencedTargets, data.dispatchApprovalTargets]) {
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > MAX_PROOFS) {malformed = true; break;}
      for (const value of values) {
        const target = agentTaskTargetSchema.safeParse(value);
        if (!target.success) {malformed = true; break;}
        references.push(target.data);
      }
    }
    if (malformed) {unverified('mio-step', step.id); continue;}
    if (data.referencedTargets === undefined && typeof step.sourceEntryId === 'string' && typeof step.sourceCallIndex === 'number') {
      if (step.sourcePresent !== 1 || typeof step.sourceBytes !== 'number') {unverified('mio-step', step.id); continue;}
      if ((bytes += step.sourceBytes) > MAX_PROCESS_PROOF_BYTES) {limited('mio-step'); break;}
      try {
        const call = records.sourceCall(step.sourceEntryId, step.sourceCallIndex);
        references.push(...agentTaskExplicitTargets(call.name, call.arguments, projectId));
      } catch {unverified('mio-step', step.id); continue;}
    } else if (data.referencedTargets === undefined && !references.length) {unverified('mio-step', step.id); continue;}
    if (references.some(touches)) {
      block('mio-step', step.id, step.status === 'unknown' ? 'MIO_STEP_OUTCOME_UNKNOWN' : 'MIO_STEP_RUNNING', [step.runId, sha256(String(step.data))]);
    }
  }
  try {
    const previs = pendingPrevisPublications(store, nodes).sort((a, b) => compare(a.requestId, b.requestId));
    for (const item of previs) block('previs', item.nodeId, item.state === 'running' ? 'PREVIS_RUNNING' : 'PREVIS_OUTCOME_UNKNOWN', item);
  } catch {unverified('previs', projectId);}
  if (overflow) blockers.push({kind: 'dependency', id: projectId, reason: 'CANVAS_DEPENDENCY_LIMIT'});
  return {versions: impactVersions.length, clips: impactClips, shotImpacts, blocked: blockers, digest: hash.digest('hex')};
}
