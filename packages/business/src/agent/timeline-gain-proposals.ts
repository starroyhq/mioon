import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE, AGENT_TIMELINE_GAIN_TOOL, AGENT_TIMELINE_GAIN_LIMITS, isAgentTimelineGainArguments} from '@mioon/contracts/agent-timeline-gain';
import type {AgentTimelineGainTarget, AgentTimelineGainArguments, AgentTimelineGainDiff} from '@mioon/contracts/agent-timeline-gain';
import {parseTimelineGainEditToolArguments, parseTimelineGainConsent} from './timeline-gain-tool-policy.ts';

type ObjectValue = Record<string, unknown>;
type Row = ObjectValue & {id: string; projectId: string; runId: string; clipId: string | null; timelineId: string | null; digest: string; status: string; approval: string | null; outcome: string | null; createdAt: string; updatedAt: string; bytes: number; position: number};
type Run = ObjectValue & {id: string; projectId: string; contextMode: string; status: string; editTarget: unknown};
type Input = {projectId: string; clipId: string; expectedRevision: number; patch: AgentTimelineGainArguments; requestId: string};
type Definition = {version: 3; id: string; projectId: string; runId: string; operation: 'timeline.clip.update'; target: AgentTimelineGainTarget; changes: AgentTimelineGainArguments; patch: AgentTimelineGainArguments; diff: AgentTimelineGainDiff; provenance: {runId: string; toolCallId: string; toolName: typeof AGENT_TIMELINE_GAIN_TOOL}; input: Input; createdAt: string};
type Value = {row: Row; run: Run; definition: Definition; approval: unknown; outcome: unknown};
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is ObjectValue => object(value) && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
});
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const callId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && Buffer.from(value).toString('utf8') === value && !/[\x00-\x20\x7f]/u.test(value);
const statuses = ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'];
interface Options {
  db: DatabaseSync;
  bounds: {definitionBytes: number; rowBytes: number; rows: number; bytes: number};
  same(a: unknown, b: unknown): boolean;
  hash(value: unknown): string;
  parse(value: unknown, maximum?: number): unknown;
  runOwned(projectId: string, runId: string): Run;
  toolFor(run: Run): ObjectValue;
  reviewTarget(value: unknown): unknown;
  isProposal(value: unknown): boolean;
  isTarget(value: unknown, options?: {projectId?: string}): value is AgentTimelineGainTarget;
  diff(target: unknown, changes: unknown): AgentTimelineGainDiff | null;
  ownership(db: DatabaseSync, target: unknown): unknown;
  hasNotAppliedProof(error: unknown, input: unknown, options: {operation: string}): boolean;
  readById(projectId: string, proposalId: string): unknown;
  dto(value: unknown): unknown;
  invalid(): never;
  corrupt(): never;
  conflict(): never;
  storageLimit(): never;
}

/** Definition v3 is an explicit private alternative. No operation registry,
 * model-supplied authority, new SQL discriminator or mutation implementation. */
export function createAgentTimelineGainProposals(options: Options) {
  const {db, bounds, same, hash, parse} = options;
  function invalid(): never { return options.invalid(); }
  function corrupt(): never { return options.corrupt(); }
  function conflict(): never { return options.conflict(); }
  function validateRun(run: Run, acceptance: unknown): void {
    const provenance = run.provenance;
    if (run.contextMode !== AGENT_TIMELINE_GAIN_CONTEXT || !exact(provenance, ['category','projectId','sourceRunIds']) || provenance.category !== AGENT_TIMELINE_GAIN_PROVENANCE || provenance.projectId !== run.projectId || !Array.isArray(provenance.sourceRunIds) || provenance.sourceRunIds.length > 12 || provenance.sourceRunIds.some(id => !uuid(id)) || new Set(provenance.sourceRunIds).size !== provenance.sourceRunIds.length || !object(acceptance) || !object(acceptance.execution) || !object(acceptance.execution.request) || !same(acceptance.execution.request.provenance,provenance)) corrupt();
    let consent; try { consent = parseTimelineGainConsent(acceptance.consent); } catch { corrupt(); }
    if (!same(consent.reviewTarget,options.reviewTarget(run.editTarget))) corrupt();
  }
  function read(row: Row, projectId: string, run: Run, rawDefinition: unknown): Value {
    if (!exact(rawDefinition, ['version','id','projectId','runId','operation','target','changes','patch','diff','provenance','input','createdAt']) || rawDefinition.version !== 3 || rawDefinition.operation !== 'timeline.clip.update' || run.contextMode !== AGENT_TIMELINE_GAIN_CONTEXT ||
      !uuid(rawDefinition.id) || !uuid(rawDefinition.runId) || ['id','projectId','runId','createdAt'].some(key => rawDefinition[key] !== row[key]) || !timestamp(row.createdAt) || !timestamp(row.updatedAt) ||
      !options.isTarget(rawDefinition.target, {projectId}) || row.shotId !== null || row.timelineId !== rawDefinition.target.timelineId || row.clipId !== rawDefinition.target.clip.id ||
      !same(rawDefinition.target, run.editTarget) || !isAgentTimelineGainArguments(rawDefinition.changes) || !same(rawDefinition.patch, rawDefinition.changes) || !statuses.includes(row.status) || !integer(row.position) || !integer(row.bytes) || row.bytes > bounds.rowBytes || hash(rawDefinition) !== row.digest) corrupt();
    const definition = rawDefinition as unknown as Definition, diff = options.diff(definition.target, definition.changes);
    if (!diff || !same(definition.diff, diff) || !uuid(definition.input?.requestId) || !same(definition.input, {projectId,clipId:row.clipId,expectedRevision:definition.target.expectedRevision,patch:definition.patch,requestId:definition.input.requestId}) ||
      !exact(definition.provenance,['runId','toolCallId','toolName']) || definition.provenance.runId !== run.id || !callId(definition.provenance.toolCallId) || definition.provenance.toolName !== AGENT_TIMELINE_GAIN_TOOL) corrupt();
    options.ownership(db, definition.target);
    const approval = row.approval === null ? null : parse(row.approval, 32768), outcome = row.outcome === null ? null : parse(row.outcome, 1024);
    if (['pending','rejected','cancelled'].includes(row.status) !== (approval === null) || ['applied','failed'].includes(row.status) !== (outcome !== null)) corrupt();
    if (approval !== null && (!exact(approval,['approvedAt','proposalId','projectId','digest','operation','input']) || !timestamp(approval.approvedAt) || approval.proposalId !== row.id || approval.projectId !== projectId || approval.digest !== row.digest || approval.operation !== definition.operation || !same(approval.input,definition.input))) corrupt();
    if (outcome !== null && (row.status === 'applied' ? !same(outcome,{status:'applied',timelineId:row.timelineId,clipId:row.clipId,revision:definition.target.expectedRevision+1}) : !exact(outcome,['status','code']) || outcome.status !== 'not_applied' || !options.hasNotAppliedProof({code:outcome.code,definitive:true,details:{mutationOutcome:'not_applied',requestId:definition.input.requestId}},definition.input,{operation:definition.operation}))) corrupt();
    return {row,run,definition,approval,outcome};
  }
  function createInside({projectId,runId,target,changes,toolCall}: {projectId: string; runId: string; target: unknown; changes: unknown; toolCall: unknown}): unknown {
    if (!db.isTransaction) throw new TypeError('Agent edit proposals require the chat capture transaction');
    if (!uuid(runId) || !options.isTarget(target,{projectId}) || !isAgentTimelineGainArguments(changes)) invalid();
    options.ownership(db,target);
    const run = options.runOwned(projectId,runId), tool = options.toolFor(run), intent = tool.intent;
    if (run.contextMode !== AGENT_TIMELINE_GAIN_CONTEXT || run.status !== 'running' || !same(run.editTarget,target) || tool.status !== 'dispatch_started' || !object(intent) || !same(intent.toolCall,toolCall) || !object(toolCall) || !callId(toolCall.id) || toolCall.name !== AGENT_TIMELINE_GAIN_TOOL || !same(toolCall.arguments,changes) || !same(parse(toolCall.argumentsJson,1024),changes) || !same(intent.provenance,{category:AGENT_TIMELINE_GAIN_PROVENANCE,projectId,operation:'timeline.clip.update'})) conflict();
    try { parseTimelineGainEditToolArguments(toolCall.name,toolCall.argumentsJson); } catch { invalid(); }
    const diff = options.diff(target,changes); if (!diff) invalid();
    const existing = db.prepare('SELECT id FROM agent_edit_proposals WHERE runId=?').get(runId);
    if (existing) {
      if (typeof existing.id !== 'string') corrupt();
      const value = options.readById(projectId,existing.id) as Value;
      if (!same(value.definition.changes,changes) || value.definition.provenance.toolCallId !== toolCall.id || value.definition.provenance.toolName !== toolCall.name) conflict();
      return options.dto(value);
    }
    const createdAt = new Date().toISOString(), proposalId = randomUUID(), patch = structuredClone(changes);
    const definition: Definition = {version:3,id:proposalId,projectId,runId,operation:'timeline.clip.update',target:structuredClone(target),changes:structuredClone(changes),patch,diff,
      provenance:{runId,toolCallId:toolCall.id,toolName:AGENT_TIMELINE_GAIN_TOOL},input:{projectId,clipId:target.clip.id,expectedRevision:target.expectedRevision,patch,requestId:randomUUID()},createdAt};
    const encoded = JSON.stringify(definition), count = Buffer.byteLength(encoded) + 32768 + 2048;
    const quota = db.prepare('SELECT count(*) AS rows,coalesce(sum(bytes),0) AS bytes FROM agent_edit_proposals').get();
    if (!quota || typeof quota.rows !== 'number' || typeof quota.bytes !== 'number') corrupt();
    if (Buffer.byteLength(encoded) > bounds.definitionBytes || Buffer.byteLength(JSON.stringify(target)) > AGENT_TIMELINE_GAIN_LIMITS.targetBytes || count > bounds.rowBytes || quota.rows >= bounds.rows || quota.bytes + count > bounds.bytes) options.storageLimit();
    db.prepare(`INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,targetKind,clipId,timelineId,digest,definition,status,createdAt,updatedAt,bytes)
      VALUES(?,?,?,NULL,'timeline_clip',?,?,?,?,'pending',?,?,?)`).run(proposalId,projectId,runId,target.clip.id,target.timelineId,hash(definition),encoded,createdAt,createdAt,count);
    return options.dto(options.readById(projectId,proposalId));
  }
  return {read,createInside,validateRun,publicResult(value: unknown) { if (!options.isProposal(value)) corrupt(); return value; }};
}
