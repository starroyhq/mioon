import {MIO_USAGE_FIELDS, mioRunUsageSchema} from '../../../contracts/src/mio-run-usage.ts';
import type {MioRunUsage} from '../../../contracts/src/mio-run-usage.ts';
import {mioIdentitySchemas} from '../../../contracts/src/mio-records.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import type { Store as WorkspaceStore } from '../store-contract.ts';
import {taskModelUsage} from './task-usage-v2.ts';

export interface MioModelUsageObservation {
  readonly requestId: string;
  readonly dispatched: boolean;
  readonly outcome: keyof MioRunUsage['modelOutcomes'];
  /** Normalized terminal measurements, never provider raw usage. */
  readonly usage?: unknown;
}
function fail(code: string): never { throw Object.assign(new Error(code), {code}); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Request identity, rather than completion/event count, owns one contribution.
 * Repeated observations replace the same request's snapshot, never add it. */
export function aggregateMioRunUsage(runId: string, revision: number, observations: readonly MioModelUsageObservation[]): MioRunUsage {
  const requests = [...new Map(observations.map(value => [value.requestId, value])).values()].filter(value => value.dispatched);
  const knownTotals: MioRunUsage['knownTotals'] = {inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null};
  const coverage: MioRunUsage['coverage'] = {fields: {
    inputTokens: {reportedSteps: 0, missingSteps: 0, complete: true, overflow: false},
    outputTokens: {reportedSteps: 0, missingSteps: 0, complete: true, overflow: false},
    cacheReadTokens: {reportedSteps: 0, missingSteps: 0, complete: true, overflow: false},
    cacheWriteTokens: {reportedSteps: 0, missingSteps: 0, complete: true, overflow: false},
  }};
  const modelOutcomes: MioRunUsage['modelOutcomes'] = {completed: 0, failed: 0, unknown: 0, inflight: 0};
  for (const request of requests) {
    modelOutcomes[request.outcome]++;
    const usage = taskModelUsage(request.usage);
    for (const field of MIO_USAGE_FIELDS) {
      const value = usage?.[field], fieldCoverage = coverage.fields[field];
      if (value === undefined) { fieldCoverage.missingSteps++; fieldCoverage.complete = false; continue; }
      fieldCoverage.reportedSteps++;
      if (fieldCoverage.overflow) continue;
      const total = (knownTotals[field] ?? 0) + value;
      if (Number.isSafeInteger(total)) knownTotals[field] = total;
      else { knownTotals[field] = null; fieldCoverage.overflow = true; fieldCoverage.complete = false; }
    }
  }
  const input = knownTotals.inputTokens, read = knownTotals.cacheReadTokens;
  const cacheReadRate = coverage.fields.inputTokens.complete && coverage.fields.cacheReadTokens.complete &&
    input !== null && input > 0 && read !== null && read <= input ? read / input : null;
  return mioRunUsageSchema.parse({version: 1, runId, revision, dispatchedModelSteps: requests.length, modelOutcomes, knownTotals, coverage, cacheReadRate});
}

/** Canonical request/entry read. This intentionally ignores the replaceable
 * usageSummary projection and never enters a write transaction or hydrates a
 * request body, tool catalog, provider output, or current model configuration. */
export function readMioRunUsage(store: ProjectStore, runId: string): MioRunUsage {
  if (!isProjectStore(store)) fail('AGENT_TASK_STORAGE_UNAVAILABLE');
  if (!mioIdentitySchemas.id.safeParse(runId).success) fail('AGENT_TASK_INVALID');
  const owner = store.db.prepare('SELECT revision FROM mio_runs WHERE id=? AND projectId=?').get(runId, store.projectId);
  if (!owner) fail('AGENT_TASK_NOT_FOUND');
  if (!mioIdentitySchemas.count.safeParse(owner.revision).success || owner.revision === 0) fail('AGENT_TASK_STORAGE_CORRUPT');
  const rows = store.db.prepare(`SELECT q.id,q.state,q.dispatchStartedAt,s.status,s.data,
    CASE WHEN q.state='completed' AND q.id=s.currentRequestId AND e.kind='model_output'
      THEN json_extract(coalesce(e.payloadJson,b.content),'$.usage') ELSE NULL END AS usage
    FROM mio_requests q JOIN mio_steps s ON s.id=q.stepId
    LEFT JOIN mio_entries e ON e.id=s.resultEntryId AND e.runId=s.runId AND e.projectId=s.projectId
    LEFT JOIN mio_blobs b ON b.sha256=e.payloadBlobHash
    WHERE s.runId=? AND s.projectId=? AND s.kind='model' ORDER BY s.position,q.assemblyNumber`).all(runId, store.projectId);
  return aggregateMioRunUsage(runId, Number(owner.revision), rows.map(row => {
    let metadata: unknown;
    try { metadata = JSON.parse(String(row.data)); } catch { fail('AGENT_TASK_STORAGE_CORRUPT'); }
    // beforeSubmit can prove no send after the immutable dispatch marker was
    // saved. Once a later attempt is dispatch_started the old flag cannot
    // exclude it, even when retained by older journal metadata.
    const prevented = (row.status === 'intent' || row.status === 'awaiting_approval') &&
      object(metadata) && object(metadata.data) && metadata.data.dispatchPrevented === true;
    let usage: unknown;
    if (typeof row.usage === 'string') { try { usage = JSON.parse(row.usage); } catch { /* Invalid passive metadata is unknown. */ } }
    const outcome = row.state === 'completed' || row.state === 'failed' || row.state === 'unknown' ? row.state : 'inflight';
    return {requestId: String(row.id), dispatched: row.dispatchStartedAt !== null && !prevented, outcome, usage};
  }));
}

/** Transitional workspace profile: event sequence supplies the durable send
 * boundary that predates mio_requests. Only scalar identity/state/usage paths
 * are selected, so private request/provider payloads are never hydrated. */
export function readAgentTaskRunUsage(store: WorkspaceStore, runId: string): MioRunUsage {
  if (!mioIdentitySchemas.id.safeParse(runId).success) fail('AGENT_TASK_INVALID');
  const owner = store.db.prepare('SELECT projectId,revision FROM agent_task_runs_v2 WHERE id=?').get(runId);
  if (!owner) fail('AGENT_TASK_NOT_FOUND');
  if (!mioIdentitySchemas.count.safeParse(owner.revision).success || owner.revision === 0) fail('AGENT_TASK_STORAGE_CORRUPT');
  const rows = store.db.prepare(`SELECT s.id,s.status,json_extract(s.data,'$.result.usage') AS usage,
    (SELECT max(e.sequence) FROM agent_task_events_v2 e WHERE e.runId=s.runId AND e.projectId=s.projectId AND e.type='step'
      AND json_extract(e.data,'$.data.id')=s.id AND json_extract(e.data,'$.data.status')='dispatch_started') AS dispatched,
    (SELECT max(e.sequence) FROM agent_task_events_v2 e WHERE e.runId=s.runId AND e.projectId=s.projectId AND e.type='dispatch_prevented'
      AND json_extract(e.data,'$.data.stepId')=s.id) AS prevented
    FROM agent_task_steps_v2 s WHERE s.runId=? AND s.projectId=? AND json_extract(s.data,'$.kind')='model' ORDER BY s.position`).all(runId, String(owner.projectId));
  return aggregateMioRunUsage(runId, Number(owner.revision), rows.map(row => {
    let usage: unknown;
    if (typeof row.usage === 'string') { try { usage = JSON.parse(row.usage); } catch { /* Invalid passive metadata is unknown. */ } }
    const dispatched = typeof row.dispatched === 'number' && (row.prevented === null || Number(row.dispatched) > Number(row.prevented));
    const outcome = row.status === 'completed' || row.status === 'failed' || row.status === 'unknown' ? row.status : 'inflight';
    return {requestId: String(row.id), dispatched, outcome, usage};
  }));
}

/** A bounded replaceable projection, updated by the lifecycle's transaction.
 * No revision/event is added: only the canonical state change owns those. */
export function updateMioRunUsageSummary(store: ProjectStore, runId: string): void {
  if (!store.db.isTransaction) fail('AGENT_TASK_TRANSACTION_REQUIRED');
  const {runId: _runId, revision: _revision, ...summary} = readMioRunUsage(store, runId);
  store.db.prepare('UPDATE mio_runs SET usageSummary=? WHERE id=? AND projectId=?').run(JSON.stringify(summary), runId, store.projectId);
}
