import {getWorkspaceRestoreContext} from '../workspace-restore-schema.ts';
import {workspaceRestoreError} from '../workspace-restore-policy.ts';
import {createHash, randomUUID} from 'node:crypto';
import {AppError, isAgentTimelineMoveTarget, isAgentTimelineMoveArguments, agentTimelineMovePublicTarget, agentTimelineMoveDiff, hasRequestNotAppliedProof, AGENT_TIMELINE_GAIN_CONTEXT, isAgentTimelineGainTarget, agentTimelineGainPublicTarget, agentTimelineGainDiff, isAgentTimelineGainProposal, agentTimelineGainReviewTarget} from '@mioon/contracts';
import {timelineGainEditToolPolicy} from './timeline-gain-tool-policy.ts';
import {createAgentTimelineGainProposals} from './timeline-gain-proposals.ts';
import {timelineEditToolPolicy, parseTimelineEditToolArguments} from './timeline-edit-tool-policy.ts';
import {pinAgentTimelineMoveTarget, assertAgentTimelineMoveOwnership, readAgentTimelineMoveReceipt, readAgentTimelineSnapshot, pinAgentTimelineGainTarget, assertAgentTimelineGainOwnership, assertAgentTimelineGainTarget, readAgentTimelineGainReceipt} from './timeline-edit-domain.ts';
import {canonical} from '../services.ts';
import {validateImageConsumption} from '../image-consumption.ts';
import {editToolPolicy, parseEditToolArguments, validEditText} from './edit-tool-policy.ts';

export const AGENT_EDIT_LIMITS = Object.freeze({rows: 2048, bytes: 64 * 1024 * 1024,
  definitionBytes: 128 * 1024, rowBytes: 192 * 1024, pageSize: 20, maxPageSize: 50,
  titleChars: 150, titleBytes: 600, promptChars: 5000, promptBytes: 20000});
const statuses = ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'];
const errors = {
  AGENT_EDIT_VALIDATION: [400, '镜头修改提案格式无效。'],
  AGENT_EDIT_NOT_FOUND: [404, '项目或镜头修改提案不存在。'],
  AGENT_EDIT_CONFLICT: [409, '镜头修改提案内容或状态已改变，请重新查看。'],
  AGENT_EDIT_RUN_INCOMPLETE: [409, '只有已成功完成的对话提案可以获准修改。'],
  AGENT_EDIT_STORAGE_LIMIT: [507, '镜头修改提案存储已达上限；已有记录已保留。'],
  AGENT_EDIT_STORAGE_UNAVAILABLE: [503, '无法安全读取或保存镜头修改提案。'],
};
const error = code => new AppError(code, errors[code][1], errors[code][0]);
const invalid = () => { throw error('AGENT_EDIT_VALIDATION'); };
const corrupt = () => { throw error('AGENT_EDIT_STORAGE_UNAVAILABLE'); };
const missing = () => { throw error('AGENT_EDIT_NOT_FOUND'); };
const conflict = () => { throw error('AGENT_EDIT_CONFLICT'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.isWellFormed();
const callId = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && value.isWellFormed() && !/[\x00-\x20\x7f]/u.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
function parse(value, max = 1024 * 1024) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) corrupt();
  try { return JSON.parse(value); } catch { corrupt(); }
}
function field(value, key) {
  return validEditText(value, key);
}
function targetValid(value) {
  return exact(value, ['projectId', 'shotId', 'expectedRevision', 'title', 'prompt']) && id(value.projectId) && uuid(value.shotId) &&
    integer(value.expectedRevision) && field(value.title, 'title') && field(value.prompt, 'prompt');
}
function changesValid(value) {
  return exact(value, ['title', 'prompt']) && ['title', 'prompt'].every(key => value[key] === null || field(value[key], key)) &&
    (value.title !== null || value.prompt !== null);
}
const publicTarget = value => ({projectId: value.projectId, shotId: value.shotId, expectedRevision: value.expectedRevision});

/** Durable, narrow, human-reviewed edits. createInside is exclusively a synchronous
 * participant in captureTool's transaction. Domain writes use the existing scoped
 * shot.update dispatcher outside any transaction. Trusted fault/limit injection
 * is for synthetic tests. */
export function createAgentEditService({store, services, fault = () => {}, limits = {}}) {
 if(getWorkspaceRestoreContext(store))throw workspaceRestoreError();
  if (!store?.db || typeof store.tx !== 'function' || typeof services?.updateShotInProject !== 'function' || typeof fault !== 'function') corrupt();
  const {db} = store, bounds = {...AGENT_EDIT_LIMITS, ...limits};
  for (const key of ['rows', 'bytes', 'definitionBytes', 'rowBytes', 'pageSize', 'maxPageSize'])
    if (!integer(bounds[key]) || bounds[key] > AGENT_EDIT_LIMITS[key]) invalid();
  const select = `SELECT position,id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,status,approval,outcome,createdAt,updatedAt,bytes,
    CASE WHEN length(CAST(definition AS BLOB))<=${AGENT_EDIT_LIMITS.definitionBytes} THEN definition ELSE NULL END AS definition FROM agent_edit_proposals`;
  function owned(table, recordId, projectId) {
    const project = table === 'projects';
    const row = db.prepare(`SELECT id,${project ? '' : 'projectId,'}${table === 'versions' ? 'jobId,' : ''}
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM ${table} WHERE id=?`).get(recordId);
    if (!row || !project && row.projectId !== projectId) missing();
    const value = parse(row.data);
    if (!plain(value) || value.id !== row.id || !project && value.projectId !== projectId || table === 'versions' && value.jobId !== row.jobId) corrupt();
    return value;
  }
  function shotRelations(value, projectId) {
    if (!plain(value) || value.projectId !== projectId || !uuid(value.id) || !integer(value.revision) ||
      !field(value.title, 'title') || !field(value.prompt, 'prompt') || !Array.isArray(value.referenceAssetIds) || value.referenceAssetIds.length > 8) corrupt();
    for (const assetId of value.referenceAssetIds) { if (!uuid(assetId)) corrupt(); owned('assets', assetId, projectId); }
    // Saved/replayed tail relations stay private to ownership checking; the
    // Agent proposal allowlist remains title/prompt only.
    if(Object.hasOwn(value,'lastFrameAssetId')&&value.lastFrameAssetId!==null){
      if(!uuid(value.lastFrameAssetId))corrupt();
      const tail=owned('assets',value.lastFrameAssetId,projectId);
      if(!['image/png','image/jpeg','image/webp'].includes(tail.mimeType))corrupt();
      try{validateImageConsumption(db,tail,projectId);}catch{corrupt();}
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
  function targetOwned(projectId, shotId) {
    owned('projects', projectId);
    const shot = owned('shots', shotId, projectId); shotRelations(shot, projectId); return shot;
  }
  function runOwned(projectId, runId) {
    const row = db.prepare(`SELECT id,projectId,requestId,threadId,status,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM agent_chat_runs WHERE id=?`).get(runId);
    if (!row || row.projectId !== projectId) missing();
    const run = parse(row.data);
    if (!plain(run) || ['id', 'projectId', 'requestId', 'threadId', 'status'].some(key => run[key] !== row[key]) ||
      !['running', 'completed', 'failed', 'stopped', 'interrupted'].includes(run.status) || !['selected_shot_edit','selected_timeline_clip_move',AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode) ||
      !(run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? isAgentTimelineGainTarget(run.editTarget, {projectId}) : run.contextMode === 'selected_timeline_clip_move' ? isAgentTimelineMoveTarget(run.editTarget, {projectId}) : targetValid(run.editTarget)) || run.editTarget.projectId !== projectId) corrupt();
    const request = db.prepare(`SELECT runId,projectId,threadId,
      CASE WHEN length(CAST(acceptance AS BLOB))<=1048576 THEN acceptance ELSE NULL END AS acceptance FROM agent_chat_requests WHERE requestId=?`).get(run.requestId);
    const thread = db.prepare('SELECT projectId FROM agent_chat_threads WHERE id=?').get(run.threadId);
    if (!request || request.runId !== runId || request.projectId !== projectId || request.threadId !== run.threadId || thread?.projectId !== projectId) corrupt();
    const accepted = parse(request.acceptance);
    if (accepted.version !== 1 || accepted.execution?.version !== 1 || !same(accepted.execution.target, run.editTarget) ||
      !same(accepted.execution.policy, run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? timelineGainEditToolPolicy(projectId) : run.contextMode === 'selected_timeline_clip_move' ? timelineEditToolPolicy(projectId) : editToolPolicy(projectId))) corrupt();
    if (run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT) gainProposals.validateRun(run, accepted);
    return run;
  }
  function toolFor(run) {
    const row = db.prepare(`SELECT id,runId,projectId,status,
      CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data FROM agent_chat_steps WHERE runId=? AND kind='tool' AND position=2`).get(run.id);
    if (!row || row.projectId !== run.projectId) corrupt();
    const step = parse(row.data);
    if (!plain(step) || ['id', 'runId', 'projectId', 'status'].some(key => step[key] !== row[key]) || step.kind !== 'tool' || step.position !== 2) corrupt();
    return step;
  }
  function read(row, projectId) {
    if (!row || row.projectId !== projectId) missing();
    if (row.targetKind === 'timeline_clip') return readTimeline(row, projectId);
    if (row.targetKind !== 'shot' || row.clipId !== null || row.timelineId !== null) corrupt();
    targetOwned(projectId, row.shotId);
    const run = runOwned(projectId, row.runId), definition = parse(row.definition, AGENT_EDIT_LIMITS.definitionBytes);
    if (!exact(definition, ['version', 'id', 'projectId', 'runId', 'operation', 'target', 'changes', 'patch', 'diff', 'provenance', 'input', 'createdAt']) ||
      definition.version !== 1 || !uuid(definition.id) || !uuid(definition.runId) || definition.operation !== 'shot.update' ||
      ['id', 'projectId', 'runId', 'createdAt'].some(key => definition[key] !== row[key]) || !timestamp(row.createdAt) || !timestamp(row.updatedAt) ||
      !targetValid(definition.target) || definition.target.projectId !== projectId || definition.target.shotId !== row.shotId ||
      !same(definition.target, run.editTarget) || !changesValid(definition.changes) || !statuses.includes(row.status) ||
      !integer(row.position) || !integer(row.bytes) || row.bytes > AGENT_EDIT_LIMITS.rowBytes || hash(definition) !== row.digest) corrupt();
    const patch = Object.fromEntries(Object.entries(definition.changes).filter(([, value]) => value !== null));
    const before = {title: definition.target.title, prompt: definition.target.prompt}, after = {...before, ...patch};
    if (same(before, after) || !same(definition.patch, patch) || !same(definition.diff, {before, after}) ||
      !exact(definition.input, ['shotId', 'expectedRevision', 'patch', 'requestId']) || !uuid(definition.input.requestId) ||
      !same(definition.input, {shotId: row.shotId, expectedRevision: definition.target.expectedRevision, patch, requestId: definition.input.requestId}) ||
      !exact(definition.provenance, ['runId', 'toolCallId', 'toolName']) || definition.provenance.runId !== run.id ||
      !callId(definition.provenance.toolCallId) || definition.provenance.toolName !== 'mioon_propose_shot_update') corrupt();
    const approval = row.approval === null ? null : parse(row.approval, 32768), outcome = row.outcome === null ? null : parse(row.outcome, 1024);
    if ((['pending', 'rejected', 'cancelled'].includes(row.status)) !== (approval === null) ||
      (['applied', 'failed'].includes(row.status)) !== (outcome !== null)) corrupt();
    if (approval && (!exact(approval, ['approvedAt', 'proposalId', 'projectId', 'digest', 'operation', 'input']) ||
      !timestamp(approval.approvedAt) || approval.proposalId !== row.id || approval.projectId !== projectId || approval.digest !== row.digest ||
      approval.operation !== definition.operation || !same(approval.input, definition.input))) corrupt();
    if (outcome && (row.status === 'applied' ? !exact(outcome, ['status', 'shotId', 'revision']) || outcome.status !== 'applied' ||
      outcome.shotId !== row.shotId || outcome.revision !== definition.target.expectedRevision + 1 :
      !exact(outcome, ['status', 'code']) || outcome.status !== 'not_applied' || !['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED'].includes(outcome.code))) corrupt();
    return {row, run, definition, approval, outcome};
  }
  function readTimeline(row, projectId) {
    const run = runOwned(projectId, row.runId), definition = parse(row.definition, AGENT_EDIT_LIMITS.definitionBytes);
    if (definition.version === 3) return gainProposals.read(row, projectId, run, definition);
    if (!exact(definition, ['version', 'id', 'projectId', 'runId', 'operation', 'target', 'changes', 'patch', 'diff', 'provenance', 'input', 'createdAt']) ||
      definition.version !== 2 || definition.operation !== 'timeline.clip.update' || run.contextMode !== 'selected_timeline_clip_move' ||
      !uuid(definition.id) || !uuid(definition.runId) || ['id','projectId','runId','createdAt'].some(key => definition[key] !== row[key]) ||
      !timestamp(row.createdAt) || !timestamp(row.updatedAt) || !isAgentTimelineMoveTarget(definition.target, {projectId}) ||
      row.shotId !== null || row.timelineId !== definition.target.timelineId || row.clipId !== definition.target.clip.id ||
      !same(definition.target, run.editTarget) || !isAgentTimelineMoveArguments(definition.changes) || !same(definition.patch, definition.changes) ||
      !statuses.includes(row.status) || !integer(row.position) || !integer(row.bytes) || row.bytes > AGENT_EDIT_LIMITS.rowBytes || hash(definition) !== row.digest) corrupt();
    const diff = agentTimelineMoveDiff(definition.target, definition.changes);
    if (!diff || !same(definition.diff, diff) || !uuid(definition.input?.requestId) ||
      !same(definition.input, {projectId, clipId: row.clipId, expectedRevision: definition.target.expectedRevision, patch: definition.patch, requestId: definition.input.requestId}) ||
      !exact(definition.provenance, ['runId','toolCallId','toolName']) || definition.provenance.runId !== run.id ||
      !callId(definition.provenance.toolCallId) || definition.provenance.toolName !== 'mioon_propose_timeline_clip_move') corrupt();
    assertAgentTimelineMoveOwnership(db, definition.target);
    const approval = row.approval === null ? null : parse(row.approval, 32768), outcome = row.outcome === null ? null : parse(row.outcome, 1024);
    if ((['pending','rejected','cancelled'].includes(row.status)) !== (approval === null) || (['applied','failed'].includes(row.status)) !== (outcome !== null)) corrupt();
    if (approval && (!exact(approval, ['approvedAt','proposalId','projectId','digest','operation','input']) || !timestamp(approval.approvedAt) ||
      approval.proposalId !== row.id || approval.projectId !== projectId || approval.digest !== row.digest || approval.operation !== definition.operation || !same(approval.input, definition.input))) corrupt();
    if (outcome && (row.status === 'applied' ? !same(outcome, {status: 'applied', timelineId: row.timelineId, clipId: row.clipId, revision: definition.target.expectedRevision + 1}) :
      !exact(outcome, ['status','code']) || outcome.status !== 'not_applied' || !hasRequestNotAppliedProof({code: outcome.code, definitive: true,
        details: {mutationOutcome: 'not_applied', requestId: definition.input.requestId}}, definition.input, {operation: definition.operation}))) corrupt();
    return {row, run, definition, approval, outcome};
  }
  function createTimelineInside({projectId, runId, target, changes, toolCall}) {
    if (!uuid(runId) || !isAgentTimelineMoveArguments(changes)) invalid();
    assertAgentTimelineMoveOwnership(db, target);
    const run = runOwned(projectId, runId), tool = toolFor(run);
    if (run.contextMode !== 'selected_timeline_clip_move' || run.status !== 'running' || !same(run.editTarget, target) || tool.status !== 'dispatch_started' ||
      !same(tool.intent?.toolCall, toolCall) || !callId(toolCall?.id) || toolCall?.name !== 'mioon_propose_timeline_clip_move' || !same(toolCall.arguments, changes) ||
      !same(parse(toolCall.argumentsJson, 32768), changes) || !same(tool.intent.provenance,
        {category: 'project_selected_timeline_timing', projectId, operation: 'timeline.clip.update'})) conflict();
    try { parseTimelineEditToolArguments(toolCall.name, toolCall.argumentsJson); } catch { invalid(); }
    const diff = agentTimelineMoveDiff(target, changes); if (!diff) invalid();
    const existing = db.prepare(`${select} WHERE runId=?`).get(runId);
    if (existing) {
      const value = read(existing, projectId);
      if (!same(value.definition.changes, changes) || value.definition.provenance.toolCallId !== toolCall.id || value.definition.provenance.toolName !== toolCall.name) conflict();
      return dto(value);
    }
    const createdAt = now(), proposalId = randomUUID(), patch = structuredClone(changes);
    const definition = {version: 2, id: proposalId, projectId, runId, operation: 'timeline.clip.update', target: structuredClone(target),
      changes: structuredClone(changes), patch, diff, provenance: {runId, toolCallId: toolCall.id, toolName: toolCall.name},
      input: {projectId, clipId: target.clip.id, expectedRevision: target.expectedRevision, patch, requestId: randomUUID()}, createdAt};
    const encoded = JSON.stringify(definition), count = Buffer.byteLength(encoded) + 32768 + 2048;
    const quota = db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM agent_edit_proposals').get();
    if (Buffer.byteLength(encoded) > bounds.definitionBytes || count > bounds.rowBytes || quota.rows >= bounds.rows || quota.bytes + count > bounds.bytes) throw error('AGENT_EDIT_STORAGE_LIMIT');
    db.prepare(`INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,definition,status,createdAt,updatedAt,bytes)
      VALUES(?,?,?,NULL,'timeline_clip',?,?,?,?,'pending',?,?,?)`).run(proposalId, projectId, runId, target.clip.id, target.timelineId, hash(definition), encoded, createdAt, createdAt, count);
    return dto(byId(projectId, proposalId));
  }
  const byId = (projectId, proposalId) => read(db.prepare(`${select} WHERE id=?`).get(proposalId), projectId);
  function dto(value) {
    const {row, run, definition, approval, outcome} = value;
    if (row.status === 'applied' && !same(receipt(value), outcome)) corrupt();
    const result = structuredClone({id: row.id, projectId: row.projectId, runId: row.runId, runStatus: run.status, digest: row.digest, status: row.status,
      operation: definition.operation, target: definition.version === 3 ? agentTimelineGainPublicTarget(definition.target) : definition.version === 2 ? agentTimelineMovePublicTarget(definition.target) : publicTarget(definition.target), patch: definition.patch, diff: definition.diff,
      provenance: definition.provenance, createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(approval ? {approval: {approvedAt: approval.approvedAt, requestId: approval.input.requestId}} : {}), ...(outcome ? {outcome} : {})});
    return definition.version === 3 ? gainProposals.publicResult(result) : result;
  }
  function action(input) {
    if (!exact(input, ['projectId', 'proposalId', 'digest']) || !id(input.projectId) || !uuid(input.proposalId) ||
      typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest)) invalid();
    const value = byId(input.projectId, input.proposalId); if (value.row.digest !== input.digest) conflict(); return value;
  }
  function update(value, status, {approval = value.approval, outcome = value.outcome} = {}) {
    // Keep retained JSON bytes when only progress changes. Re-serializing an
    // unchanged legacy approval would violate its immutable raw-byte trigger.
    const approvalText = approval === value.approval ? value.row.approval : approval ? JSON.stringify(approval) : null;
    const outcomeText = outcome === value.outcome ? value.row.outcome : outcome ? JSON.stringify(outcome) : null;
    db.prepare('UPDATE agent_edit_proposals SET status=?,approval=?,outcome=?,updatedAt=? WHERE id=?')
      .run(status, approvalText, outcomeText, now(), value.row.id);
    return byId(value.row.projectId, value.row.id);
  }
  function receipt(value) {
    if (value.definition.version === 3) {
      return readAgentTimelineSnapshot(db, () => readAgentTimelineGainReceipt(db, value.definition.input, value.definition.target));
    }
    if (value.definition.version === 2) {
      const reconcile = () => readAgentTimelineMoveReceipt(db, value.definition.input, value.definition.target);
      return readAgentTimelineSnapshot(db, reconcile);
    }
    // Read the shared atomic journal directly. Recovery must not invoke a mutation
    // just to ask whether it happened, nor trust an obsolete receipt's ownership.
    targetOwned(value.row.projectId, value.row.shotId);
    const saved = db.prepare(`SELECT operation,projectId,canonicalInput,
      CASE WHEN length(CAST(response AS BLOB))<=1048576 THEN response ELSE NULL END AS response FROM mutation_requests WHERE requestId=?`).get(value.definition.input.requestId);
    if (!saved) return null;
    const {requestId, ...fields} = value.definition.input;
    if (saved.operation !== 'shot.update' || saved.projectId !== value.row.projectId || saved.canonicalInput !== canonical(fields)) corrupt();
    const response = parse(saved.response); shotRelations(response, value.row.projectId);
    if (response.id !== value.row.shotId || response.revision !== value.definition.target.expectedRevision + 1 ||
      response.title !== value.definition.diff.after.title || response.prompt !== value.definition.diff.after.prompt) corrupt();
    return {status: 'applied', shotId: response.id, revision: response.revision};
  }
  function completedProposal(value) {
    if (value.run.status !== 'completed') throw error('AGENT_EDIT_RUN_INCOMPLETE');
    const tool = toolFor(value.run), result = tool.observation?.result;
    const finalRow = db.prepare(`SELECT id,runId,projectId,status,CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data
      FROM agent_chat_steps WHERE runId=? AND kind='model' AND position=3`).get(value.run.id);
    if (!finalRow || finalRow.projectId !== value.row.projectId) corrupt();
    const final = parse(finalRow.data);
    if (value.run.modelRequestState !== 'completed' || !Array.isArray(value.run.activity) || !plain(final) || ['id', 'runId', 'projectId', 'status'].some(key => final[key] !== finalRow[key]) ||
      final.kind !== 'model' || final.position !== 3 || final.ordinal !== 2 || final.status !== 'completed' || final.output?.type !== 'done' || final.output.finishReason !== 'stop' ||
      Object.hasOwn(final.output, 'toolCall') || !value.run.activity?.some(item => item.id === final.id && item.kind === 'model' && item.ordinal === 2 && item.status === 'completed') ||
      tool.status !== 'completed' || result?.kind !== (value.definition.version === 3 ? 'untrusted_timeline_clip_gain_proposal' : value.definition.version === 2 ? 'untrusted_timeline_clip_move_proposal' : 'untrusted_shot_update_proposal') || result.proposalId !== value.row.id ||
      result.digest !== value.row.digest || result.operation !== value.definition.operation || result.applied !== false || result.status !== 'pending_review' ||
      !same(parse(tool.observation.resultJson, 8192), result) || tool.intent?.toolCall?.id !== value.definition.provenance.toolCallId ||
      tool.intent?.toolCall?.name !== value.definition.provenance.toolName || !same(tool.intent?.toolCall?.arguments, value.definition.changes) ||
      !Array.isArray(value.run.activity) || !value.run.activity.some(item => item.id === tool.id && item.kind === 'tool' && item.status === 'completed' && item.resultJson === tool.observation.resultJson)) corrupt();
  }
  async function dispatch(input) {
    fault('beforeDispatch');
    const started = store.tx(() => {
      const value = action(input);
      if (!['approved', 'unknown'].includes(value.row.status)) return {dispatch: false, value};
      completedProposal(value);
      const outcome = receipt(value);
      if (outcome) return {dispatch: false, value: update(value, 'applied', {outcome})};
      return {dispatch: true, value: update(value, 'dispatching')};
    });
    if (!started.dispatch) return dto(started.value);
    fault('afterDispatchStarted');
    const persisted = started.value.approval;
    let dispatchError, response;
    try {
      // No await, callback or outer transaction between ownership validation and
      // the existing synchronous mutation. Project ownership is checked again
      // inside that handler's own transaction, including receipt replay.
      if (started.value.definition.version === 3) {
        if (typeof services.setTimelineClipGainInProject !== 'function') corrupt();
        response = services.setTimelineClipGainInProject(input.projectId, structuredClone(persisted.input), structuredClone(started.value.definition.target));
      } else if (started.value.definition.version === 2) {
        if (typeof services.moveTimelineClipInProject !== 'function') corrupt();
        response = services.moveTimelineClipInProject(input.projectId, structuredClone(persisted.input), structuredClone(started.value.definition.target));
      } else {
        targetOwned(input.projectId, started.value.row.shotId);
        response = services.updateShotInProject(input.projectId, structuredClone(persisted.input));
      }
    } catch (caught) { dispatchError = caught; }
    try { fault('afterDispatch'); } catch (caught) { response?.catch?.(() => {}); throw caught; }
    try { if (response !== undefined) await response; } catch (caught) { dispatchError = caught; }
    const result = store.tx(() => {
      const value = action(input);
      if (['applied', 'failed'].includes(value.row.status)) return value;
      const outcome = receipt(value);
      if (outcome) return update(value, 'applied', {outcome});
      if ([2, 3].includes(value.definition.version) && dispatchError instanceof AppError && hasRequestNotAppliedProof(dispatchError, persisted.input, {operation: 'timeline.clip.update'}))
        return update(value, 'failed', {outcome: {status: 'not_applied', code: dispatchError.code}});
      if (value.definition.version === 1 && dispatchError instanceof AppError && dispatchError.details?.mutationOutcome === 'not_applied' &&
        dispatchError.details.requestId === persisted.input.requestId &&
        ['NOT_FOUND', 'REVISION_CONFLICT', 'INVALID_ORDER', 'ASSET_REQUIRED', 'INVALID_NODE_ASSET', 'REFERENCE_CONNECTED'].includes(dispatchError.code))
        return update(value, 'failed', {outcome: {status: 'not_applied', code: dispatchError.code}});
      return update(value, 'unknown');
    });
    fault('afterOutcome'); fault('beforeAcknowledgement');
    return dto(result);
  }
  const gainProposals = createAgentTimelineGainProposals({db, bounds, same, hash, parse, runOwned, toolFor, isTarget: isAgentTimelineGainTarget, isProposal: isAgentTimelineGainProposal, reviewTarget: agentTimelineGainReviewTarget,
    diff: agentTimelineGainDiff, ownership: assertAgentTimelineGainOwnership, hasNotAppliedProof: hasRequestNotAppliedProof,
    readById: byId, dto, invalid, corrupt, conflict, storageLimit() { throw error('AGENT_EDIT_STORAGE_LIMIT'); }});
  return Object.freeze({
    pinTimelineGainTarget(projectId, input) { return readAgentTimelineSnapshot(db, () => structuredClone(pinAgentTimelineGainTarget(db, projectId, input))); },
    assertTimelineGainTarget(target) { readAgentTimelineSnapshot(db, () => assertAgentTimelineGainTarget(db, target)); },
    pinTimelineTarget(projectId, input) {
      const pin = () => structuredClone(pinAgentTimelineMoveTarget(db, projectId, input));
      return readAgentTimelineSnapshot(db, pin);
    },
    pinTarget(projectId, input) {
      if (!id(projectId) || !exact(input, ['shotId', 'expectedRevision']) || !uuid(input.shotId) || !integer(input.expectedRevision)) invalid();
      const shot = targetOwned(projectId, input.shotId); if (shot.revision !== input.expectedRevision) conflict();
      return Object.freeze({projectId, shotId: shot.id, expectedRevision: shot.revision, title: shot.title, prompt: shot.prompt});
    },
    createInside({projectId, runId, target, changes, toolCall}) {
      if (!db.isTransaction) throw new TypeError('Agent edit proposals require the chat capture transaction');
      if (isAgentTimelineGainTarget(target, {projectId})) return gainProposals.createInside({projectId, runId, target, changes, toolCall});
      if (isAgentTimelineMoveTarget(target, {projectId})) return createTimelineInside({projectId, runId, target, changes, toolCall});
      if (!id(projectId) || !uuid(runId) || !targetValid(target) || target.projectId !== projectId || !changesValid(changes)) invalid();
      targetOwned(projectId, target.shotId);
      const run = runOwned(projectId, runId), tool = toolFor(run);
      if (run.status !== 'running' || !same(run.editTarget, target) || tool.status !== 'dispatch_started' ||
        !same(tool.intent?.toolCall, toolCall) || !callId(toolCall?.id) || toolCall?.name !== 'mioon_propose_shot_update' || !same(toolCall.arguments, changes) ||
        !same(parse(toolCall.argumentsJson, 32768), changes) || !same(tool.intent.provenance,
          {category: 'project_selected_shot_text', projectId, operation: 'shot.update'})) conflict();
      try { parseEditToolArguments(toolCall.name, toolCall.argumentsJson); } catch { invalid(); }
      const patch = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null));
      const before = {title: target.title, prompt: target.prompt}, after = {...before, ...patch};
      if (same(before, after)) invalid();
      const existing = db.prepare(`${select} WHERE runId=?`).get(runId);
      if (existing) {
        const value = read(existing, projectId);
        if (!same(value.definition.changes, changes) || value.definition.provenance.toolCallId !== toolCall.id || value.definition.provenance.toolName !== toolCall.name) conflict();
        return dto(value);
      }
      const createdAt = now(), proposalId = randomUUID();
      const definition = {version: 1, id: proposalId, projectId, runId, operation: 'shot.update', target: structuredClone(target),
        changes: structuredClone(changes), patch, diff: {before, after}, provenance: {runId, toolCallId: toolCall.id, toolName: toolCall.name},
        input: {shotId: target.shotId, expectedRevision: target.expectedRevision, patch, requestId: randomUUID()}, createdAt};
      const encoded = JSON.stringify(definition), count = Buffer.byteLength(encoded) + 32768 + 2048;
      const quota = db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM agent_edit_proposals').get();
      if (Buffer.byteLength(encoded) > bounds.definitionBytes || count > bounds.rowBytes || quota.rows >= bounds.rows || quota.bytes + count > bounds.bytes)
        throw error('AGENT_EDIT_STORAGE_LIMIT');
      db.prepare(`INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,digest,definition,status,createdAt,updatedAt,bytes)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(proposalId, projectId, runId, target.shotId, hash(definition), encoded, createdAt, createdAt, count);
      return dto(byId(projectId, proposalId));
    },
    get(input) {
      if (!exact(input, ['projectId', 'proposalId']) || !id(input.projectId) || !uuid(input.proposalId)) invalid();
      return dto(byId(input.projectId, input.proposalId));
    },
    list(input) {
      if (!exact(input, ['projectId'], ['limit', 'cursor', 'view']) || !id(input.projectId)) invalid();
      owned('projects', input.projectId);
      const limit = input.limit ?? bounds.pageSize, view = input.view ?? 'unresolved';
      if (!integer(limit) || limit > bounds.maxPageSize || !['unresolved', 'all'].includes(view)) invalid();
      let position = Number.MAX_SAFE_INTEGER;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) invalid();
        let cursor; try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); } catch { invalid(); }
        if (!exact(cursor, ['projectId', 'view', 'position']) || cursor.projectId !== input.projectId || cursor.view !== view || !integer(cursor.position)) invalid();
        position = cursor.position;
      }
      const filter = view === 'unresolved' ? " AND status IN ('pending','approved','dispatching','unknown')" : '';
      const rows = db.prepare(`${select} WHERE projectId=? AND position<?${filter} ORDER BY position DESC LIMIT ?`).all(input.projectId, position, limit + 1);
      const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({projectId: input.projectId, view, position: rows[limit - 1].position})).toString('base64url') : null;
      return {proposals: rows.slice(0, limit).map(row => dto(read(row, input.projectId))), nextCursor};
    },
    async approve(input) {
      fault('beforeApproval');
      const saved = store.tx(() => {
        const value = action(input);
        if (value.run.status !== 'completed') throw error('AGENT_EDIT_RUN_INCOMPLETE');
        if (value.row.status !== 'pending') return {dispatch: false, value};
        completedProposal(value);
        const approval = {approvedAt: now(), proposalId: value.row.id, projectId: value.row.projectId, digest: value.row.digest,
          operation: value.definition.operation, input: structuredClone(value.definition.input)};
        return {dispatch: true, value: update(value, 'approved', {approval})};
      });
      if (!saved.dispatch) return dto(saved.value);
      fault('afterApproval');
      return dispatch(input);
    },
    reject(input) {
      return store.tx(() => { const value = action(input); return dto(value.row.status === 'pending' ? update(value, 'rejected') : value); });
    },
    async recover(input) {
      const value = action(input);
      if (!value.approval) conflict();
      if (!['approved', 'unknown'].includes(value.row.status)) return dto(value);
      return dispatch(input);
    },
    cancelRun(runId) {
      if (!uuid(runId)) invalid();
      const cancel = () => {
        const row = db.prepare(`${select} WHERE runId=?`).get(runId);
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
        const rows = db.prepare(`${select} WHERE status IN ('pending','approved','dispatching','unknown') ORDER BY position LIMIT ?`).all(bounds.rows + 1);
        if (rows.length > bounds.rows) throw error('AGENT_EDIT_STORAGE_LIMIT');
        let reconciled = 0;
        for (const row of rows) {
          if (row.status === 'pending') {
            const run = db.prepare('SELECT projectId,status FROM agent_chat_runs WHERE id=?').get(row.runId);
            if (run?.projectId === row.projectId && ['failed', 'stopped', 'interrupted'].includes(run.status)) {
              db.prepare("UPDATE agent_edit_proposals SET status='cancelled',updatedAt=? WHERE id=? AND status='pending'").run(now(), row.id); reconciled++;
            }
            continue;
          }
          try {
            const value = read(row, row.projectId), outcome = receipt(value);
            if (outcome) { update(value, 'applied', {outcome}); reconciled++; }
            else if (row.status !== 'unknown') { update(value, 'unknown'); reconciled++; }
          } catch (caught) {
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
