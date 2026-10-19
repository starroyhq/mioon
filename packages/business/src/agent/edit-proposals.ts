import {getWorkspaceRestoreContext} from '../workspace-restore-schema.ts';
import {workspaceRestoreError} from '../workspace-restore-policy.ts';
import {createHash, randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError, isAgentTimelineMoveTarget, isAgentTimelineMoveArguments, agentTimelineMovePublicTarget, agentTimelineMoveDiff, hasRequestNotAppliedProof, AGENT_TIMELINE_GAIN_CONTEXT, isAgentTimelineGainTarget, agentTimelineGainPublicTarget, agentTimelineGainDiff, isAgentTimelineGainProposal, agentTimelineGainReviewTarget} from '@mioon/contracts';
import type {AgentTimelineMoveTarget} from '@mioon/contracts';
import {timelineGainEditToolPolicy} from './timeline-gain-tool-policy.ts';
import {createAgentTimelineGainProposals} from './timeline-gain-proposals.ts';
import {timelineEditToolPolicy, parseTimelineEditToolArguments} from './timeline-edit-tool-policy.ts';
import {pinAgentTimelineMoveTarget, assertAgentTimelineMoveOwnership, readAgentTimelineMoveReceipt, readAgentTimelineSnapshot, pinAgentTimelineGainTarget, assertAgentTimelineGainOwnership, assertAgentTimelineGainTarget, readAgentTimelineGainReceipt} from './timeline-edit-domain.ts';
import type {AgentTimelineMoveInput} from './timeline-edit-domain.ts';
import {canonical} from '../services.ts';
import {validateImageConsumption} from '../image-consumption.ts';
import {editToolPolicy, parseEditToolArguments, validEditText} from './edit-tool-policy.ts';
import type {ToolCall} from './tool-wire.ts';
import type {ChatRun} from './chat-journal.ts';

export const AGENT_EDIT_LIMITS = Object.freeze({rows: 2048, bytes: 64 * 1024 * 1024,
  definitionBytes: 128 * 1024, rowBytes: 192 * 1024, pageSize: 20, maxPageSize: 50,
  titleChars: 150, titleBytes: 600, promptChars: 5000, promptBytes: 20000});
const statuses: readonly string[] = ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'];
const errors = {
  AGENT_EDIT_VALIDATION: [400, '镜头修改提案格式无效。'],
  AGENT_EDIT_NOT_FOUND: [404, '项目或镜头修改提案不存在。'],
  AGENT_EDIT_CONFLICT: [409, '镜头修改提案内容或状态已改变，请重新查看。'],
  AGENT_EDIT_RUN_INCOMPLETE: [409, '只有已成功完成的对话提案可以获准修改。'],
  AGENT_EDIT_STORAGE_LIMIT: [507, '镜头修改提案存储已达上限；已有记录已保留。'],
  AGENT_EDIT_STORAGE_UNAVAILABLE: [503, '无法安全读取或保存镜头修改提案。'],
} as const;
type EditErrorCode = keyof typeof errors;
function error(code: EditErrorCode): AppError { return new AppError(code, errors[code][1], errors[code][0]); }
function invalid(): never { throw error('AGENT_EDIT_VALIDATION'); }
function corrupt(): never { throw error('AGENT_EDIT_STORAGE_UNAVAILABLE'); }
function missing(): never { throw error('AGENT_EDIT_NOT_FOUND'); }
function conflict(): never { throw error('AGENT_EDIT_CONFLICT'); }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => plain(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && Buffer.from(value, 'utf8').toString('utf8') === value;
const callId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && Buffer.from(value, 'utf8').toString('utf8') === value && !/[\x00-\x20\x7f]/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const now = (): string => new Date().toISOString();
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function parse(value: unknown, max = 1024 * 1024): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) corrupt();
  try { return JSON.parse(value); } catch { corrupt(); }
}
function field(value: unknown, key: 'title' | 'prompt'): value is string { return validEditText(value, key); }
export interface EditProposalRow {
  position: number; id: string; projectId: string; runId: string; shotId: string | null; targetKind: string | null; clipId: string | null; timelineId: string | null;
  digest: string; status: string; approval: string | null; outcome: string | null; createdAt: string; updatedAt: string; bytes: number; definition: string | null;
  [key: string]: unknown;
}
export interface EditProposalTarget {projectId: string; shotId: string; expectedRevision: number; title: string; prompt: string}
interface ShotChanges {title: string | null; prompt: string | null}
interface ShotDefinition {
  version: 1; id: string; projectId: string; runId: string; operation: 'shot.update'; target: EditProposalTarget;
  changes: ShotChanges; patch: Record<string, string>;
  diff: {before: {title: string; prompt: string}; after: {title: string; prompt: string}};
  provenance: {runId: string; toolCallId: string; toolName: string};
  input: {shotId: string; expectedRevision: number; patch: Record<string, string>; requestId: string};
  createdAt: string;
  [key: string]: unknown;
}
interface MoveDefinition {
  version: 2; id: string; projectId: string; runId: string; operation: 'timeline.clip.update'; target: AgentTimelineMoveTarget;
  changes: Record<string, unknown>; patch: Record<string, unknown>; diff: unknown;
  provenance: {runId: string; toolCallId: string; toolName: string};
  input: AgentTimelineMoveInput;
  createdAt: string;
  [key: string]: unknown;
}
interface GainDefinition {version: 3; operation: string; id: string; runId: string; target: unknown; changes: Record<string, unknown>; patch: Record<string, unknown>; diff: unknown; provenance: Record<string, unknown>; input: Record<string, unknown>; createdAt: string; [key: string]: unknown}
type ProposalDefinition = ShotDefinition | MoveDefinition | GainDefinition;
interface ApprovalRecord {approvedAt: string; proposalId: string; projectId: string; digest: string; operation: string; input: Record<string, unknown>; [key: string]: unknown}
export interface EditProposalValue {row: EditProposalRow; run: ChatRun; definition: ProposalDefinition; approval: ApprovalRecord | null; outcome: Record<string, unknown> | null}
export interface EditProposalToolStep {id: string; runId: string; projectId: string; status: string; kind?: string; position?: number; intent?: {toolCall?: ToolCall; provenance?: Record<string, unknown>}; observation?: {result?: Record<string, unknown>; resultJson?: string}; [key: string]: unknown}
export interface EditProposalServices {
  updateShotInProject(projectId: string, input: unknown): unknown;
  setTimelineClipGainInProject?(projectId: string, input: unknown, target: unknown): unknown;
  moveTimelineClipInProject?(projectId: string, input: unknown, target: unknown): unknown;
}
export interface AgentEditServiceOptions {
  store: {db: DatabaseSync; tx<T>(operation: () => T): T};
  services: EditProposalServices;
  fault?: (phase: string) => void;
  limits?: Record<string, number>;
}
function targetValid(value: unknown): value is EditProposalTarget {
  return exact(value, ['projectId', 'shotId', 'expectedRevision', 'title', 'prompt']) && id(value.projectId) && uuid(value.shotId) &&
    integer(value.expectedRevision) && field(value.title, 'title') && field(value.prompt, 'prompt');
}
function changesValid(value: unknown): value is ShotChanges {
  return exact(value, ['title', 'prompt']) && (['title', 'prompt'] as const).every(key => value[key] === null || field(value[key], key)) &&
    (value.title !== null || value.prompt !== null);
}
function publicTarget(value: EditProposalTarget): {projectId: string; shotId: string; expectedRevision: number} {
  return {projectId: value.projectId, shotId: value.shotId, expectedRevision: value.expectedRevision};
}

/** Durable, narrow, human-reviewed edits. createInside is exclusively a synchronous
 * participant in captureTool's transaction. Domain writes use the existing scoped
 * shot.update dispatcher outside any transaction. Trusted fault/limit injection
 * is for synthetic tests. */
export function createAgentEditService({store, services, fault = () => {}, limits = {}}: AgentEditServiceOptions) {
  if (getWorkspaceRestoreContext(store)) throw workspaceRestoreError();
  if (!store?.db || typeof store.tx !== 'function' || typeof services?.updateShotInProject !== 'function' || typeof fault !== 'function') corrupt();
  const {db} = store, bounds = {...AGENT_EDIT_LIMITS, ...limits};
  for (const key of ['rows', 'bytes', 'definitionBytes', 'rowBytes', 'pageSize', 'maxPageSize'] as const) {
    if (!integer(bounds[key]) || bounds[key] > AGENT_EDIT_LIMITS[key]) invalid();
  }
  const select = `SELECT position,id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,status,approval,outcome,createdAt,updatedAt,bytes,
    CASE WHEN length(CAST(definition AS BLOB))<=${AGENT_EDIT_LIMITS.definitionBytes} THEN definition ELSE NULL END AS definition FROM agent_edit_proposals`;
  type TableName = 'projects' | 'assets' | 'versions' | 'jobs' | 'shots';
  function owned(table: TableName, recordId: string, projectId?: string): Record<string, unknown> {
    const project = table === 'projects';
    const row = db.prepare(`SELECT id,${project ? '' : 'projectId,'}${table === 'versions' ? 'jobId,' : ''}
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM ${table} WHERE id=?`).get(recordId) as unknown as {id?: unknown; projectId?: unknown; jobId?: unknown; data?: unknown} | undefined;
    if (!row || !project && row.projectId !== projectId) missing();
    const value = parse(row.data);
    if (!plain(value) || value.id !== row.id || !project && value.projectId !== projectId || table === 'versions' && value.jobId !== row.jobId) corrupt();
    return value;
  }
  function shotRelations(value: unknown, projectId: string): void {
    if (!plain(value) || value.projectId !== projectId || !uuid(value.id) || !integer(value.revision) ||
      !field(value.title, 'title') || !field(value.prompt, 'prompt') || !Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 8) corrupt();
    for (const assetId of value.referenceAssetIds as unknown[]) { if (!uuid(assetId)) corrupt(); owned('assets', assetId, projectId); }
    // Saved/replayed tail relations stay private to ownership checking; the
    // Agent proposal allowlist remains title/prompt only.
    if (Object.hasOwn(value, 'lastFrameAssetId') && value.lastFrameAssetId !== null) {
      if (!uuid(value.lastFrameAssetId)) corrupt();
      const tail = owned('assets', value.lastFrameAssetId, projectId);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(tail.mimeType as string)) corrupt();
      try { validateImageConsumption(db, tail as unknown as Parameters<typeof validateImageConsumption>[1], projectId); } catch { corrupt(); }
    }
    if (value.selectedVersionId != null) {
      if (!uuid(value.selectedVersionId)) corrupt();
      const version = owned('versions', value.selectedVersionId, projectId);
      if (version.shotId !== value.id || !uuid(version.assetId) || !uuid(version.jobId)) corrupt();
      owned('assets', version.assetId, projectId);
      const job = owned('jobs', version.jobId, projectId);
      if (job.shotId !== value.id || job.versionId != null && job.versionId !== version.id) corrupt();
    }
  }
  function targetOwned(projectId: string, shotId: string): Record<string, unknown> {
    owned('projects', projectId);
    const shot = owned('shots', shotId, projectId); shotRelations(shot, projectId); return shot;
  }
  function runOwned(projectId: string, runId: string): ChatRun {
    const row = db.prepare(`SELECT id,projectId,requestId,threadId,status,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM agent_chat_runs WHERE id=?`).get(runId) as unknown as {id?: unknown; projectId?: unknown; requestId?: unknown; threadId?: unknown; status?: unknown; data?: unknown} | undefined;
    if (!row || row.projectId !== projectId) missing();
    const run = parse(row.data);
    if (!plain(run) || ['id', 'projectId', 'requestId', 'threadId', 'status'].some(key => run[key] !== row[key as 'id' | 'projectId' | 'requestId' | 'threadId' | 'status']) ||
      !['running', 'completed', 'failed', 'stopped', 'interrupted'].includes(run.status as string) || !['selected_shot_edit', 'selected_timeline_clip_move', AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string) ||
      !(run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? isAgentTimelineGainTarget(run.editTarget, {projectId}) : run.contextMode === 'selected_timeline_clip_move' ? isAgentTimelineMoveTarget(run.editTarget, {projectId}) : targetValid(run.editTarget)) || (run.editTarget as {projectId?: unknown}).projectId !== projectId) corrupt();
    const request = db.prepare(`SELECT runId,projectId,threadId,
      CASE WHEN length(CAST(acceptance AS BLOB))<=1048576 THEN acceptance ELSE NULL END AS acceptance FROM agent_chat_requests WHERE requestId=?`).get(run.requestId as string) as unknown as {runId?: unknown; projectId?: unknown; threadId?: unknown; acceptance?: unknown} | undefined;
    const thread = db.prepare('SELECT projectId FROM agent_chat_threads WHERE id=?').get(run.threadId as string) as unknown as {projectId?: unknown} | undefined;
    if (!request || request.runId !== runId || request.projectId !== projectId || request.threadId !== run.threadId || thread?.projectId !== projectId) corrupt();
    const accepted = parse(request.acceptance) as Record<string, unknown>;
    const acceptedExecution = accepted.execution as {version?: unknown; target?: unknown; policy?: unknown} | undefined;
    if (accepted.version !== 1 || acceptedExecution?.version !== 1 || !same(acceptedExecution.target, run.editTarget) ||
      !same(acceptedExecution.policy, run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? timelineGainEditToolPolicy(projectId) : run.contextMode === 'selected_timeline_clip_move' ? timelineEditToolPolicy(projectId) : editToolPolicy(projectId))) corrupt();
    if (run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT) gainProposals.validateRun(run as never, accepted as never);
    return run as unknown as ChatRun;
  }
  function toolFor(run: ChatRun): EditProposalToolStep {
    const row = db.prepare(`SELECT id,runId,projectId,status,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM agent_chat_steps WHERE runId=? AND kind='tool' AND position=2`).get(run.id) as unknown as {id?: unknown; runId?: unknown; projectId?: unknown; status?: unknown; data?: unknown} | undefined;
    if (!row || row.projectId !== run.projectId) corrupt();
    const step = parse(row.data);
    if (!plain(step) || ['id', 'runId', 'projectId', 'status'].some(key => step[key] !== row[key as 'id' | 'runId' | 'projectId' | 'status']) || step.kind !== 'tool' || step.position !== 2) corrupt();
    return step as EditProposalToolStep;
  }
  function read(row: EditProposalRow | undefined, projectId: string): EditProposalValue {
    if (!row || row.projectId !== projectId) missing();
    if (row.targetKind === 'timeline_clip') return readTimeline(row, projectId);
    if (row.targetKind !== 'shot' || row.clipId !== null || row.timelineId !== null) corrupt();
    targetOwned(projectId, row.shotId as string);
    const run = runOwned(projectId, row.runId), definition = parse(row.definition, AGENT_EDIT_LIMITS.definitionBytes) as ShotDefinition;
    if (!exact(definition, ['version', 'id', 'projectId', 'runId', 'operation', 'target', 'changes', 'patch', 'diff', 'provenance', 'input', 'createdAt']) ||
      definition.version !== 1 || !uuid(definition.id) || !uuid(definition.runId) || definition.operation !== 'shot.update' ||
      ['id', 'projectId', 'runId', 'createdAt'].some(key => definition[key] !== row[key]) || !timestamp(row.createdAt) || !timestamp(row.updatedAt) ||
      !targetValid(definition.target) || definition.target.projectId !== projectId || definition.target.shotId !== row.shotId ||
      !same(definition.target, run.editTarget) || !changesValid(definition.changes) || !statuses.includes(row.status) ||
      !integer(row.position) || !integer(row.bytes) || row.bytes > AGENT_EDIT_LIMITS.rowBytes || hash(definition) !== row.digest) corrupt();
    const patch = Object.fromEntries(Object.entries(definition.changes).filter(([, value]) => value !== null)) as Record<string, string>;
    const before = {title: definition.target.title, prompt: definition.target.prompt}, after = {...before, ...patch};
    if (same(before, after) || !same(definition.patch, patch) || !same(definition.diff, {before, after}) ||
      !exact(definition.input, ['shotId', 'expectedRevision', 'patch', 'requestId']) || !uuid(definition.input.requestId) ||
      !same(definition.input, {shotId: row.shotId, expectedRevision: definition.target.expectedRevision, patch, requestId: definition.input.requestId}) ||
      !exact(definition.provenance, ['runId', 'toolCallId', 'toolName']) || definition.provenance.runId !== run.id ||
      !callId(definition.provenance.toolCallId) || definition.provenance.toolName !== 'mioon_propose_shot_update') corrupt();
    const approval = row.approval === null ? null : parse(row.approval, 32768) as ApprovalRecord, outcome = row.outcome === null ? null : parse(row.outcome, 1024) as Record<string, unknown>;
    if ((['pending', 'rejected', 'cancelled'].includes(row.status)) !== (approval === null) ||
      (['applied', 'failed'].includes(row.status)) !== (outcome !== null)) corrupt();
    if (approval && (!exact(approval, ['approvedAt', 'proposalId', 'projectId', 'digest', 'operation', 'input']) ||
      !timestamp(approval.approvedAt) || approval.proposalId !== row.id || approval.projectId !== projectId || approval.digest !== row.digest ||
      approval.operation !== definition.operation || !same(approval.input, definition.input))) corrupt();
    if (outcome && (row.status === 'applied' ? !exact(outcome, ['status', 'shotId', 'revision']) || outcome.status !== 'applied' ||
      outcome.shotId !== row.shotId || outcome.revision !== definition.target.expectedRevision + 1 :
      !exact(outcome, ['status', 'code']) || outcome.status !== 'not_applied' || !['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED'].includes(outcome.code as string))) corrupt();
    return {row, run, definition, approval, outcome};
  }
  function readTimeline(row: EditProposalRow, projectId: string): EditProposalValue {
    const run = runOwned(projectId, row.runId), definition = parse(row.definition, AGENT_EDIT_LIMITS.definitionBytes);
    if (plain(definition) && definition.version === 3) return gainProposals.read(row as never, projectId, run as never, definition) as unknown as EditProposalValue;
    if (!exact(definition, ['version', 'id', 'projectId', 'runId', 'operation', 'target', 'changes', 'patch', 'diff', 'provenance', 'input', 'createdAt']) ||
      definition.version !== 2 || definition.operation !== 'timeline.clip.update' || run.contextMode !== 'selected_timeline_clip_move' ||
      !uuid(definition.id) || !uuid(definition.runId) || ['id', 'projectId', 'runId', 'createdAt'].some(key => definition[key] !== row[key]) ||
      !timestamp(row.createdAt) || !timestamp(row.updatedAt) || !isAgentTimelineMoveTarget(definition.target, {projectId}) ||
      row.shotId !== null || row.timelineId !== (definition.target as AgentTimelineMoveTarget).timelineId || row.clipId !== (definition.target as AgentTimelineMoveTarget).clip.id ||
      !same(definition.target, run.editTarget) || !isAgentTimelineMoveArguments(definition.changes) || !same(definition.patch, definition.changes) ||
      !statuses.includes(row.status) || !integer(row.position) || !integer(row.bytes) || row.bytes > AGENT_EDIT_LIMITS.rowBytes || hash(definition) !== row.digest) corrupt();
    const target = definition.target as AgentTimelineMoveTarget, input = definition.input as AgentTimelineMoveInput;
    const diff = agentTimelineMoveDiff(target, definition.changes);
    if (!diff || !same(definition.diff, diff) || !uuid(input?.requestId) ||
      !same(definition.input, {projectId, clipId: row.clipId, expectedRevision: target.expectedRevision, patch: definition.patch, requestId: input.requestId}) ||
      !exact(definition.provenance, ['runId', 'toolCallId', 'toolName']) || definition.provenance.runId !== run.id ||
      !callId(definition.provenance.toolCallId) || definition.provenance.toolName !== 'mioon_propose_timeline_clip_move') corrupt();
    assertAgentTimelineMoveOwnership(db, definition.target);
    const approval = row.approval === null ? null : parse(row.approval, 32768) as ApprovalRecord, outcome = row.outcome === null ? null : parse(row.outcome, 1024) as Record<string, unknown>;
    if ((['pending', 'rejected', 'cancelled'].includes(row.status)) !== (approval === null) || (['applied', 'failed'].includes(row.status)) !== (outcome !== null)) corrupt();
    if (approval && (!exact(approval, ['approvedAt', 'proposalId', 'projectId', 'digest', 'operation', 'input']) || !timestamp(approval.approvedAt) ||
      approval.proposalId !== row.id || approval.projectId !== projectId || approval.digest !== row.digest || approval.operation !== definition.operation || !same(approval.input, definition.input))) corrupt();
    if (outcome && (row.status === 'applied' ? !same(outcome, {status: 'applied', timelineId: row.timelineId, clipId: row.clipId, revision: target.expectedRevision + 1}) :
      !exact(outcome, ['status', 'code']) || outcome.status !== 'not_applied' || !hasRequestNotAppliedProof({code: outcome.code, definitive: true,
        details: {mutationOutcome: 'not_applied', requestId: input.requestId}}, definition.input, {operation: definition.operation}))) corrupt();
    return {row, run, definition: definition as unknown as MoveDefinition, approval, outcome};
  }
  function createTimelineInside({projectId, runId, target, changes, toolCall}: {projectId: string; runId: string; target: AgentTimelineMoveTarget; changes: Record<string, unknown>; toolCall: ToolCall}): unknown {
    if (!uuid(runId) || !isAgentTimelineMoveArguments(changes)) invalid();
    assertAgentTimelineMoveOwnership(db, target);
    const run = runOwned(projectId, runId), tool = toolFor(run);
    if (run.contextMode !== 'selected_timeline_clip_move' || run.status !== 'running' || !same(run.editTarget, target) || tool.status !== 'dispatch_started' ||
      !same(tool.intent?.toolCall, toolCall) || !callId(toolCall?.id) || toolCall?.name !== 'mioon_propose_timeline_clip_move' || !same(toolCall.arguments, changes) ||
      !same(parse(toolCall.argumentsJson, 32768), changes) || !same(tool.intent?.provenance,
        {category: 'project_selected_timeline_timing', projectId, operation: 'timeline.clip.update'})) conflict();
    try { parseTimelineEditToolArguments(toolCall.name, toolCall.argumentsJson); } catch { invalid(); }
    const diff = agentTimelineMoveDiff(target, changes); if (!diff) invalid();
    const existing = db.prepare(`${select} WHERE runId=?`).get(runId) as unknown as EditProposalRow | undefined;
    if (existing) {
      const value = read(existing, projectId);
      const provenance = value.definition.provenance as {toolCallId?: unknown; toolName?: unknown};
      if (!same((value.definition as MoveDefinition).changes, changes) || provenance.toolCallId !== toolCall.id || provenance.toolName !== toolCall.name) conflict();
      return dto(value);
    }
    const createdAt = now(), proposalId = randomUUID(), patch = structuredClone(changes);
    const definition: MoveDefinition = {version: 2, id: proposalId, projectId, runId, operation: 'timeline.clip.update', target: structuredClone(target),
      changes: structuredClone(changes), patch, diff: diff as unknown, provenance: {runId, toolCallId: toolCall.id, toolName: toolCall.name},
      input: {projectId, clipId: target.clip.id, expectedRevision: target.expectedRevision, patch, requestId: randomUUID()}, createdAt};
    const encoded = JSON.stringify(definition), count = Buffer.byteLength(encoded) + 32768 + 2048;
    const quota = db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM agent_edit_proposals').get() as unknown as {rows: number; bytes: number};
    if (Buffer.byteLength(encoded) > bounds.definitionBytes || count > bounds.rowBytes || quota.rows >= bounds.rows || quota.bytes + count > bounds.bytes) throw error('AGENT_EDIT_STORAGE_LIMIT');
    db.prepare(`INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,definition,status,createdAt,updatedAt,bytes)
      VALUES(?,?,?,NULL,'timeline_clip',?,?,?,?,'pending',?,?,?)`).run(proposalId, projectId, runId, target.clip.id, target.timelineId, hash(definition), encoded, createdAt, createdAt, count);
    return dto(byId(projectId, proposalId));
  }
  const byId = (projectId: string, proposalId: string): EditProposalValue => read(db.prepare(`${select} WHERE id=?`).get(proposalId) as unknown as EditProposalRow | undefined, projectId);
  function dto(value: EditProposalValue): unknown {
    const {row, run, definition, approval, outcome} = value;
    if (row.status === 'applied' && !same(receipt(value), outcome)) corrupt();
    const result = structuredClone({id: row.id, projectId: row.projectId, runId: row.runId, runStatus: run.status, digest: row.digest, status: row.status,
      operation: definition.operation, target: definition.version === 3 ? agentTimelineGainPublicTarget(definition.target) : definition.version === 2 ? agentTimelineMovePublicTarget(definition.target) : publicTarget(definition.target as EditProposalTarget), patch: definition.patch, diff: definition.diff,
      provenance: definition.provenance, createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(approval ? {approval: {approvedAt: approval.approvedAt, requestId: (approval.input as {requestId?: unknown}).requestId}} : {}), ...(outcome ? {outcome} : {})});
    return definition.version === 3 ? gainProposals.publicResult(result) : result;
  }
  function action(input: unknown): EditProposalValue {
    if (!exact(input, ['projectId', 'proposalId', 'digest']) || !id(input.projectId) || !uuid(input.proposalId) ||
      typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest)) invalid();
    const value = byId(input.projectId, input.proposalId); if (value.row.digest !== input.digest) conflict(); return value;
  }
  function update(value: EditProposalValue, status: string, {approval = value.approval, outcome = value.outcome}: {approval?: ApprovalRecord | null; outcome?: Record<string, unknown> | null} = {}): EditProposalValue {
    // Keep retained JSON bytes when only progress changes. Re-serializing an
    // unchanged legacy approval would violate its immutable raw-byte trigger.
    const approvalText = approval === value.approval ? value.row.approval : approval ? JSON.stringify(approval) : null;
    const outcomeText = outcome === value.outcome ? value.row.outcome : outcome ? JSON.stringify(outcome) : null;
    db.prepare('UPDATE agent_edit_proposals SET status=?,approval=?,outcome=?,updatedAt=? WHERE id=?')
      .run(status, approvalText, outcomeText, now(), value.row.id);
    return byId(value.row.projectId, value.row.id);
  }
  function receipt(value: EditProposalValue): unknown {
    if (value.definition.version === 3) {
      return readAgentTimelineSnapshot(db, () => readAgentTimelineGainReceipt(db, value.definition.input as unknown as Parameters<typeof readAgentTimelineGainReceipt>[1], value.definition.target as Parameters<typeof readAgentTimelineGainReceipt>[2]));
    }
    if (value.definition.version === 2) {
      const definition = value.definition as MoveDefinition;
      const reconcile = () => readAgentTimelineMoveReceipt(db, definition.input, definition.target);
      return readAgentTimelineSnapshot(db, reconcile);
    }
    // Read the shared atomic journal directly. Recovery must not invoke a mutation
    // just to ask whether it happened, nor trust an obsolete receipt's ownership.
    const definition = value.definition as ShotDefinition;
    targetOwned(value.row.projectId, value.row.shotId as string);
    const saved = db.prepare(`SELECT operation,projectId,canonicalInput,
      CASE WHEN length(CAST(response AS BLOB))<=1048576 THEN response ELSE NULL END AS response FROM mutation_requests WHERE requestId=?`).get(definition.input.requestId) as unknown as {operation?: unknown; projectId?: unknown; canonicalInput?: unknown; response?: unknown} | undefined;
    if (!saved) return null;
    const {requestId: _requestId, ...fields} = definition.input;
    if (saved.operation !== 'shot.update' || saved.projectId !== value.row.projectId || saved.canonicalInput !== canonical(fields)) corrupt();
    const response = parse(saved.response) as Record<string, unknown>; shotRelations(response, value.row.projectId);
    if (response.id !== value.row.shotId || response.revision !== definition.target.expectedRevision + 1 ||
      response.title !== definition.diff.after.title || response.prompt !== definition.diff.after.prompt) corrupt();
    return {status: 'applied', shotId: response.id, revision: response.revision};
  }
  function completedProposal(value: EditProposalValue): void {
    if (value.run.status !== 'completed') throw error('AGENT_EDIT_RUN_INCOMPLETE');
    const tool = toolFor(value.run), result = tool.observation?.result;
    const finalRow = db.prepare(`SELECT id,runId,projectId,status,CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data
      FROM agent_chat_steps WHERE runId=? AND kind='model' AND position=3`).get(value.run.id) as unknown as {id?: unknown; runId?: unknown; projectId?: unknown; status?: unknown; data?: unknown} | undefined;
    if (!finalRow || finalRow.projectId !== value.row.projectId) corrupt();
    const final = parse(finalRow.data) as Record<string, unknown>;
    const finalOutput = final.output as {type?: unknown; finishReason?: unknown; toolCall?: unknown} | undefined;
    const finalId = final.id, finalRowId = finalRow.id;
    if (value.run.modelRequestState !== 'completed' || !Array.isArray(value.run.activity) || !plain(final) || ['id', 'runId', 'projectId', 'status'].some(key => final[key] !== finalRow[key as 'id' | 'runId' | 'projectId' | 'status']) ||
      final.kind !== 'model' || final.position !== 3 || final.ordinal !== 2 || final.status !== 'completed' || finalOutput?.type !== 'done' || finalOutput.finishReason !== 'stop' ||
      Object.hasOwn(finalOutput, 'toolCall') || !value.run.activity.some(item => item.id === finalId && item.kind === 'model' && item.ordinal === 2 && item.status === 'completed') ||
      tool.status !== 'completed' || result?.kind !== (value.definition.version === 3 ? 'untrusted_timeline_clip_gain_proposal' : value.definition.version === 2 ? 'untrusted_timeline_clip_move_proposal' : 'untrusted_shot_update_proposal') || result.proposalId !== value.row.id ||
      result.digest !== value.row.digest || result.operation !== value.definition.operation || result.applied !== false || result.status !== 'pending_review' ||
      !same(parse(tool.observation?.resultJson, 8192), result) || (tool.intent?.toolCall as ToolCall | undefined)?.id !== (value.definition.provenance as {toolCallId?: unknown}).toolCallId ||
      (tool.intent?.toolCall as ToolCall | undefined)?.name !== (value.definition.provenance as {toolName?: unknown}).toolName || !same(tool.intent?.toolCall?.arguments, value.definition.changes) ||
      !value.run.activity.some(item => item.id === tool.id && item.kind === 'tool' && item.status === 'completed' && item.resultJson === tool.observation?.resultJson)) corrupt();
  }
  async function dispatch(input: unknown): Promise<unknown> {
    fault('beforeDispatch');
    const started = store.tx(() => {
      const value = action(input);
      if (!['approved', 'unknown'].includes(value.row.status)) return {dispatch: false, value};
      completedProposal(value);
      const outcome = receipt(value);
      if (outcome) return {dispatch: false, value: update(value, 'applied', {outcome: outcome as Record<string, unknown> | null})};
      return {dispatch: true, value: update(value, 'dispatching')};
    });
    if (!started.dispatch) return dto(started.value);
    fault('afterDispatchStarted');
    const persisted = started.value.approval as ApprovalRecord;
    const projectId = (input as {projectId: string}).projectId;
    let dispatchError: unknown, response: unknown;
    try {
      // No await, callback or outer transaction between ownership validation and
      // the existing synchronous mutation. Project ownership is checked again
      // inside that handler's own transaction, including receipt replay.
      if (started.value.definition.version === 3) {
        if (typeof services.setTimelineClipGainInProject !== 'function') corrupt();
        response = services.setTimelineClipGainInProject(projectId, structuredClone(persisted.input), structuredClone(started.value.definition.target));
      } else if (started.value.definition.version === 2) {
        if (typeof services.moveTimelineClipInProject !== 'function') corrupt();
        response = services.moveTimelineClipInProject(projectId, structuredClone(persisted.input), structuredClone((started.value.definition as MoveDefinition).target));
      } else {
        targetOwned(projectId, started.value.row.shotId as string);
        response = services.updateShotInProject(projectId, structuredClone(persisted.input));
      }
    } catch (caught) { dispatchError = caught; }
    try { fault('afterDispatch'); } catch (caught) { (response as {catch?: (handler: () => void) => void} | undefined)?.catch?.(() => {}); throw caught; }
    try { if (response !== undefined) await response; } catch (caught) { dispatchError = caught; }
    const result = store.tx(() => {
      const value = action(input);
      if (['applied', 'failed'].includes(value.row.status)) return value;
      const outcome = receipt(value);
      if (outcome) return update(value, 'applied', {outcome: outcome as Record<string, unknown> | null});
      const details = dispatchError instanceof AppError ? dispatchError.details as {mutationOutcome?: unknown; requestId?: unknown} | undefined : undefined;
      if ([2, 3].includes(value.definition.version) && dispatchError instanceof AppError && hasRequestNotAppliedProof(dispatchError, persisted.input, {operation: 'timeline.clip.update'}))
        return update(value, 'failed', {outcome: {status: 'not_applied', code: dispatchError.code}});
      if (value.definition.version === 1 && dispatchError instanceof AppError && details?.mutationOutcome === 'not_applied' &&
        details.requestId === (persisted.input as {requestId?: unknown}).requestId &&
        ['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED'].includes(dispatchError.code))
        return update(value, 'failed', {outcome: {status: 'not_applied', code: dispatchError.code}});
      return update(value, 'unknown');
    });
    fault('afterOutcome'); fault('beforeAcknowledgement');
    return dto(result);
  }
  type GainProposalsOptions = Parameters<typeof createAgentTimelineGainProposals>[0];
  const gainProposals = createAgentTimelineGainProposals({
    db, bounds, same, hash, parse,
    runOwned: ((projectId: string, runId: string) => runOwned(projectId, runId)) as unknown as GainProposalsOptions['runOwned'],
    toolFor: ((run: ChatRun) => toolFor(run)) as unknown as GainProposalsOptions['toolFor'],
    isTarget: isAgentTimelineGainTarget, isProposal: isAgentTimelineGainProposal as unknown as GainProposalsOptions['isProposal'],
    reviewTarget: agentTimelineGainReviewTarget as unknown as GainProposalsOptions['reviewTarget'],
    diff: ((target: unknown, changes: unknown) => agentTimelineGainDiff(target, changes)) as unknown as GainProposalsOptions['diff'],
    ownership: ((db: DatabaseSync, target: unknown) => assertAgentTimelineGainOwnership(db, target)) as unknown as GainProposalsOptions['ownership'],
    hasNotAppliedProof: hasRequestNotAppliedProof as unknown as GainProposalsOptions['hasNotAppliedProof'],
    readById: ((projectId: string, proposalId: string) => byId(projectId, proposalId)) as unknown as GainProposalsOptions['readById'],
    dto: ((value: EditProposalValue) => dto(value)) as unknown as GainProposalsOptions['dto'],
    invalid, corrupt, conflict, storageLimit: (() => { throw error('AGENT_EDIT_STORAGE_LIMIT'); }) as unknown as GainProposalsOptions['storageLimit'],
  } as GainProposalsOptions);
  return Object.freeze({
    pinTimelineGainTarget(projectId: string, input: unknown) { return readAgentTimelineSnapshot(db, () => structuredClone(pinAgentTimelineGainTarget(db, projectId, input))); },
    assertTimelineGainTarget(target: unknown) { readAgentTimelineSnapshot(db, () => assertAgentTimelineGainTarget(db, target)); },
    pinTimelineTarget(projectId: string, input: unknown) {
      const pin = () => structuredClone(pinAgentTimelineMoveTarget(db, projectId, input));
      return readAgentTimelineSnapshot(db, pin);
    },
    pinTarget(projectId: string, input: unknown) {
      if (!id(projectId) || !exact(input, ['shotId', 'expectedRevision']) || !uuid(input.shotId) || !integer(input.expectedRevision)) invalid();
      const shot = targetOwned(projectId, input.shotId); if (shot.revision !== input.expectedRevision) conflict();
      return Object.freeze({projectId, shotId: shot.id, expectedRevision: shot.revision, title: shot.title, prompt: shot.prompt});
    },
    createInside({projectId, runId, target, changes, toolCall}: {projectId: string; runId: string; target: unknown; changes: Record<string, unknown>; toolCall: ToolCall}) {
      if (!db.isTransaction) throw new TypeError('Agent edit proposals require the chat capture transaction');
      if (isAgentTimelineGainTarget(target, {projectId})) return gainProposals.createInside({projectId, runId, target, changes, toolCall} as never);
      if (isAgentTimelineMoveTarget(target, {projectId})) return createTimelineInside({projectId, runId, target: target as AgentTimelineMoveTarget, changes, toolCall});
      if (!id(projectId) || !uuid(runId) || !targetValid(target) || target.projectId !== projectId || !changesValid(changes)) invalid();
      const shotTarget = target as EditProposalTarget;
      targetOwned(projectId, shotTarget.shotId);
      const run = runOwned(projectId, runId), tool = toolFor(run);
      if (run.status !== 'running' || !same(run.editTarget, target) || tool.status !== 'dispatch_started' ||
        !same(tool.intent?.toolCall, toolCall) || !callId(toolCall?.id) || toolCall?.name !== 'mioon_propose_shot_update' || !same(toolCall.arguments, changes) ||
        !same(parse(toolCall.argumentsJson, 32768), changes) || !same(tool.intent?.provenance,
          {category: 'project_selected_shot_text', projectId, operation: 'shot.update'})) conflict();
      try { parseEditToolArguments(toolCall.name, toolCall.argumentsJson); } catch { invalid(); }
      const patch = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null)) as Record<string, string>;
      const before = {title: shotTarget.title, prompt: shotTarget.prompt}, after = {...before, ...patch};
      if (same(before, after)) invalid();
      const existing = db.prepare(`${select} WHERE runId=?`).get(runId) as unknown as EditProposalRow | undefined;
      if (existing) {
        const value = read(existing, projectId), provenance = value.definition.provenance as {toolCallId?: unknown; toolName?: unknown};
        if (!same((value.definition as ShotDefinition).changes, changes) || provenance.toolCallId !== toolCall.id || provenance.toolName !== toolCall.name) conflict();
        return dto(value);
      }
      const createdAt = now(), proposalId = randomUUID();
      const definition: ShotDefinition = {version: 1, id: proposalId, projectId, runId, operation: 'shot.update', target: structuredClone(shotTarget),
        changes: structuredClone(changes) as ShotChanges, patch, diff: {before, after}, provenance: {runId, toolCallId: toolCall.id, toolName: toolCall.name},
        input: {shotId: shotTarget.shotId, expectedRevision: shotTarget.expectedRevision, patch, requestId: randomUUID()}, createdAt};
      const encoded = JSON.stringify(definition), count = Buffer.byteLength(encoded) + 32768 + 2048;
      const quota = db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM agent_edit_proposals').get() as unknown as {rows: number; bytes: number};
      if (Buffer.byteLength(encoded) > bounds.definitionBytes || count > bounds.rowBytes || quota.rows >= bounds.rows || quota.bytes + count > bounds.bytes)
        throw error('AGENT_EDIT_STORAGE_LIMIT');
      db.prepare(`INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,digest,definition,status,createdAt,updatedAt,bytes)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(proposalId, projectId, runId, shotTarget.shotId, hash(definition), encoded, createdAt, createdAt, count);
      return dto(byId(projectId, proposalId));
    },
    get(input: unknown) {
      if (!exact(input, ['projectId', 'proposalId']) || !id(input.projectId) || !uuid(input.proposalId)) invalid();
      return dto(byId(input.projectId, input.proposalId));
    },
    list(input: unknown) {
      if (!exact(input, ['projectId'], ['limit', 'cursor', 'view']) || !id(input.projectId)) invalid();
      owned('projects', input.projectId);
      const limit = (input.limit ?? bounds.pageSize) as number, view = (input.view ?? 'unresolved') as string;
      if (!integer(limit) || limit > bounds.maxPageSize || !['unresolved', 'all'].includes(view)) invalid();
      let position = Number.MAX_SAFE_INTEGER;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) invalid();
        let cursor: unknown; try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { invalid(); }
        if (!exact(cursor, ['projectId', 'view', 'position']) || cursor.projectId !== input.projectId || cursor.view !== view || !integer(cursor.position)) invalid();
        position = cursor.position;
      }
      const filter = view === 'unresolved' ? " AND status IN ('pending','approved','dispatching','unknown')" : '';
      const rows = db.prepare(`${select} WHERE projectId=? AND position<?${filter} ORDER BY position DESC LIMIT ?`).all(input.projectId, position, limit + 1) as unknown as EditProposalRow[];
      const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({projectId: input.projectId, view, position: rows[limit - 1].position})).toString('base64url') : null;
      return {proposals: rows.slice(0, limit).map(row => dto(read(row, input.projectId as string))), nextCursor};
    },
    async approve(input: unknown) {
      fault('beforeApproval');
      const saved = store.tx(() => {
        const value = action(input);
        if (value.run.status !== 'completed') throw error('AGENT_EDIT_RUN_INCOMPLETE');
        if (value.row.status !== 'pending') return {dispatch: false, value};
        completedProposal(value);
        const approval: ApprovalRecord = {approvedAt: now(), proposalId: value.row.id, projectId: value.row.projectId, digest: value.row.digest,
          operation: value.definition.operation, input: structuredClone(value.definition.input) as Record<string, unknown>};
        return {dispatch: true, value: update(value, 'approved', {approval})};
      });
      if (!saved.dispatch) return dto(saved.value);
      fault('afterApproval');
      return dispatch(input);
    },
    reject(input: unknown) {
      return store.tx(() => { const value = action(input); return dto(value.row.status === 'pending' ? update(value, 'rejected') : value); });
    },
    async recover(input: unknown) {
      const value = action(input);
      if (!value.approval) conflict();
      if (!['approved', 'unknown'].includes(value.row.status)) return dto(value);
      return dispatch(input);
    },
    cancelRun(runId: string) {
      if (!uuid(runId)) invalid();
      const cancel = (): boolean => {
        const row = db.prepare(`${select} WHERE runId=?`).get(runId) as unknown as EditProposalRow | undefined;
        if (!row || row.status !== 'pending') return false;
        // Stop is allowed to invalidate a proposal even if its target was deleted.
        db.prepare("UPDATE agent_edit_proposals SET status='cancelled',updatedAt=? WHERE id=? AND status='pending'").run(now(), row.id);
        return true;
      };
      return db.isTransaction ? cancel() : store.tx(cancel);
    },
    reconcile() {
      // Called only by startup, after unfinished chat runs have been interrupted.
      // Every unresolved row is retained. No gateway or service dispatch occurs.
      return store.tx(() => {
        const rows = db.prepare(`${select} WHERE status IN ('pending','approved','dispatching','unknown') ORDER BY position LIMIT ?`).all(bounds.rows + 1) as unknown as EditProposalRow[];
        if (rows.length > bounds.rows) throw error('AGENT_EDIT_STORAGE_LIMIT');
        let reconciled = 0;
        for (const row of rows) {
          if (row.status === 'pending') {
            const run = db.prepare('SELECT projectId,status FROM agent_chat_runs WHERE id=?').get(row.runId) as unknown as {projectId?: unknown; status?: unknown} | undefined;
            if (run?.projectId === row.projectId && ['failed', 'stopped', 'interrupted'].includes(run.status as string)) {
              db.prepare("UPDATE agent_edit_proposals SET status='cancelled',updatedAt=? WHERE id=? AND status='pending'").run(now(), row.id); reconciled++;
            }
            continue;
          }
          try {
            const value = read(row, row.projectId), outcome = receipt(value);
            if (outcome) { update(value, 'applied', {outcome: outcome as Record<string, unknown> | null}); reconciled++; }
            else if (row.status !== 'unknown') { update(value, 'unknown'); reconciled++; }
          } catch (_caught) {
            // Invalid/deleted ownership cannot expose a receipt or authorize work.
            // Still conservatively retain uncertain dispatch as unknown.
            if (row.status !== 'unknown') { db.prepare("UPDATE agent_edit_proposals SET status='unknown',updatedAt=? WHERE id=?").run(now(), row.id); reconciled++; }
          }
        }
        return {reconciled};
      });
    },
  });
}
export type AgentEditService = ReturnType<typeof createAgentEditService>;
