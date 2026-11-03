import {createHash, randomUUID} from 'node:crypto';
import type {AgentTaskJson} from '../../../contracts/src/agent-tasks-v2.ts';
import {projectRulesEnableInputSchema, projectRulesSaveInputSchema, projectRulesSnapshotSchema, rulesRequestIdSchema, RULES_MAX_BYTES} from '../../../contracts/src/mio-rules.ts';
import type {MioRulesErrorCode, ProjectRulesRequestLookup, ProjectRulesSnapshot, ProjectRulesToolInput} from '../../../contracts/src/mio-rules.ts';
import type {MioRuleWrite} from '../../../contracts/src/mio-rule-writes.ts';
import type {AppLibrary} from '../app-db/index.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {createMioProjectJournal} from './mio-journal-factory.ts';
import {createMioRecords} from './mio-records.ts';
import {createMioRuleWriteRepository} from './mio-rule-write-repository.ts';
import {finishRulesFileCleanup, inspectRulesArtifact, publishRulesFile, readRulesFile} from './mio-rules-file.ts';
import type {RulesFileRead, RulesPublicationEvidence, RulesPublicationInput} from './mio-rules-file.ts';

export interface FrozenMioRules {
 readonly version: 1;
 readonly project: {readonly text: string; readonly hash: string} | null;
 readonly user: {readonly text: string; readonly revision: number} | null;
 readonly message: {readonly role: 'user'; readonly content: string} | null;
}
export interface MioRulesApproval {
 readonly runId: string; readonly stepId: string; readonly approvalReceiptId: string;
 readonly proposalDigest: string;
 readonly recordInside: (result: AgentTaskJson) => void;
}
export interface MioRulesProposal {
 readonly file: 'AGENTS.md'; readonly expectedHash: string | null;
 readonly beforeText: string | null; readonly proposedText: string; readonly afterHash: string;
 readonly diff: {readonly before: string | null; readonly after: string};
}
export type MioRulesPhase = 'prepared' | 'published' | 'before_trust' | 'trusted' | 'completed';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = (value: unknown): string => hash(JSON.stringify(value));
function fail(code: MioRulesErrorCode): never {throw Object.assign(new Error(code), {code});}
const sameNode = (a: {dev: string; ino: string}, b: {dev: string; ino: string}): boolean => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a: {dev:string;ino:string;size:string;mtimeNs:string;ctimeNs:string}, b: {dev:string;ino:string;size:string;mtimeNs:string;ctimeNs:string}):boolean => sameNode(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

/** One native project host owns this synchronous boundary. No filesystem or B1
 * work runs inside a history transaction. Every effect follows durable intent;
 * restart does not infer publication ownership from content equality. */
export function createMioProjectRules({store, application, signal, assertMutationAllowed = () => {}, onPhase, publication = {}}: {
 readonly store: ProjectStore;
 readonly application: Pick<AppLibrary, 'rulesTrust' | 'userRules' | 'receipts' | 'tx' | 'agentPolicy'>;
 readonly signal?: AbortSignal;
 readonly assertMutationAllowed?: () => void;
 readonly onPhase?: (phase: MioRulesPhase) => void;
 readonly publication?: Pick<RulesPublicationInput, 'onPhase' | 'afterEffect'>;
}) {
 const records = createMioRecords(store), repository = createMioRuleWriteRepository(store), projectId = store.projectId;
 let closed = false, busy = false;
 const journal = createMioProjectJournal(store, application.agentPolicy);
 const at = (): string => new Date().toISOString();
 function live(): void {if (closed || signal?.aborted) fail('MIO_RULES_UNAVAILABLE');}
 function mutate<T>(apply: () => T): T {
  live(); assertMutationAllowed(); if (busy) fail('MIO_RULES_PENDING'); busy = true;
  try {return apply();} finally {busy = false;}
 }
 function checkpoint(phase: MioRulesPhase): void {onPhase?.(phase); live();}
 function read(): ProjectRulesSnapshot {
  live();
  const pendingWrites = repository.listPending().length > 0, file = readRulesFile(store.projectDir, {signal});
  const base = {projectId, file: 'AGENTS.md' as const, maxBytes: RULES_MAX_BYTES, pendingWrites};
  if (file.status === 'error') {
   const readError = ({too_large: 'too_large', invalid_utf8: 'invalid_utf8', invalid_text: 'invalid_text', unsafe_file: 'unsafe_file', changed: 'changed'} as const)[file.code as 'too_large' | 'invalid_utf8' | 'invalid_text' | 'unsafe_file' | 'changed'] ?? 'io_error';
   return projectRulesSnapshotSchema.parse({...base, exists: true, text: null, hash: null, trust: pendingWrites ? 'pending' : 'unavailable', readError});
  }
  if (file.status === 'missing') return projectRulesSnapshotSchema.parse({...base, exists: false, text: null, hash: null, trust: pendingWrites ? 'pending' : 'absent', readError: null});
  let trusted = false;
  try {trusted = application.rulesTrust.get(projectId)?.sha256 === file.hash;}
  catch {return projectRulesSnapshotSchema.parse({...base, exists: true, text: null, hash: null, trust: pendingWrites ? 'pending' : 'unavailable', readError: 'trust_unavailable'});}
  return projectRulesSnapshotSchema.parse({...base, exists: true, text: file.text, hash: file.hash, trust: pendingWrites ? 'pending' : trusted ? 'trusted' : 'untrusted', readError: null});
 }
 function capture(): FrozenMioRules {
  const view = read();
  const project = view.trust === 'trusted' && view.text !== null && view.hash !== null ? {text: view.text, hash: view.hash} : null;
  // A failed B1 read is fail closed, never an invitation to use stale defaults.
  let user: FrozenMioRules['user'] = null;
  try {const saved = application.userRules.get(); if (saved.text) user = {text: saved.text, revision: saved.revision};} catch { /* omit unavailable user rules */ }
  const sections = [user?.text ? `Generic user rules:\n${user.text}` : '', project !== null ? `Project rules (AGENTS.md, SHA-256 ${project.hash}):\n${project.text}` : ''].filter(Boolean);
  return {version: 1, project, user, message: sections.length ? {role: 'user', content: `Host-provided frozen rules for this round. Priority: host instructions > this round’s explicit user request > project rules > generic user rules. Rules do not grant tool, file, network or paid authority.\n\n${sections.join('\n\n')}`} : null};
 }
 function current(expectedHash: string | null): Exclude<RulesFileRead, {status: 'error'}> {
  const file = readRulesFile(store.projectDir, {signal});
  if (file.status === 'error') fail('MIO_RULES_UNAVAILABLE');
  if ((file.status === 'safe' ? file.hash : null) !== expectedHash) fail('MIO_RULES_CONFLICT');
  return file;
 }
 function proposal(input: ProjectRulesToolInput): MioRulesProposal {
  live(); if (repository.listPending().length) fail('MIO_RULES_PENDING');
  const parsed = projectRulesSaveInputSchema.safeParse({requestId: 'proposal-only', expectedHash: input.expectedHash, text: input.proposedText});
  if (!parsed.success) fail('MIO_RULES_INVALID');
  const file = current(input.expectedHash), beforeText = file.status === 'safe' ? file.text : null;
  return {file: 'AGENTS.md', expectedHash: input.expectedHash, beforeText, proposedText: input.proposedText, afterHash: hash(input.proposedText), diff: {before: beforeText, after: input.proposedText}};
 }
 function operationReceipt(operation: string, requestId: string, expectedDigest?: string): ProjectRulesSnapshot | null {
  const receipt = application.receipts.read(operation, requestId);
  if (!receipt) return null;
  if (expectedDigest !== undefined && receipt.digest !== expectedDigest) fail('MIO_RULES_REQUEST_CONFLICT');
  const parsed = projectRulesSnapshotSchema.safeParse(receipt.response);
  if (!parsed.success || parsed.data.projectId !== projectId) fail('MIO_RULES_REQUEST_CONFLICT');
  return parsed.data;
 }
 function lookup(requestId: string): ProjectRulesRequestLookup {
  live(); if (!rulesRequestIdSchema.safeParse(requestId).success) fail('MIO_RULES_INVALID');
  const row = repository.get(requestId);
  const result = operationReceipt('project.rules.save', requestId, row?.digest) ?? operationReceipt('project.rules.enable', requestId);
  if ((!row || row.state === 'completed') && result) return {projectId, requestId, status: 'applied', state: 'completed', result};
  if (!row || row.state === 'not_applied') return {projectId, requestId, status: 'not_applied', state: row ? 'not_applied' : null, result: null};
  if (row.state === 'completed') fail('MIO_RULES_UNAVAILABLE');
  return {projectId, requestId, status: 'uncertain', state: row.state, result: null};
 }
 function validateApproval(approval: MioRulesApproval, input: {expectedHash: string | null; text: string}): void {
  const step = records.step(approval.stepId), receipt = records.control(approval.approvalReceiptId);
  const projected = journal.step(approval.stepId), data = projected.data, value = receipt?.data;
  const expectedDigest = digest({call:projected.toolCall,targets:projected.targets,tier:projected.tier,...(object(data)&&Array.isArray(data.dispatchApprovalTargets)?{dispatchTargets:data.dispatchApprovalTargets}:{}),...(object(data)&&data.rulesProposal!==undefined?{rulesProposal:data.rulesProposal}:{})});
  if (step.runId !== approval.runId || step.kind !== 'tool' || !['dispatch_started', 'unknown'].includes(step.status)
   || !object(data) || data.rulesApprovalReceiptId !== approval.approvalReceiptId || data.approvalDigest !== approval.proposalDigest || approval.proposalDigest !== expectedDigest
   || receipt?.runId !== approval.runId || !object(value) || value.action !== 'approve' || !object(value.result)
   || !object(value.result.approvedRules) || value.result.approvedRules.stepId !== approval.stepId || value.result.approvedRules.proposalDigest !== approval.proposalDigest) fail('MIO_RULES_CONFLICT');
  const saved = data.rulesProposal;
  if (!object(saved) || saved.expectedHash !== input.expectedHash || saved.proposedText !== input.text || saved.afterHash !== hash(input.text)) fail('MIO_RULES_CONFLICT');
  // Source tool identity and raw arguments are canonical provider output, not a
  // model-supplied approval field or a previous AGENTS.md/notes permission.
  if (step.sourceEntryId === null || step.sourceCallIndex === null) fail('MIO_RULES_CONFLICT');
  const call = records.sourceCall(step.sourceEntryId, step.sourceCallIndex);
  if (call.name !== 'mioon_project_rules_set' || !object(call.arguments) || call.arguments.expectedHash !== input.expectedHash || call.arguments.proposedText !== input.text) fail('MIO_RULES_CONFLICT');
 }
 function published(row: MioRuleWrite): boolean {
  const proof = row.fileIdentity;
  // A crash after link but before its durable publication checkpoint remains
  // unknown. Matching hashes/dev:ino alone cannot prove ownership after ABA.
  if (!proof?.candidateIdentity || !proof.publishedIdentity) return false;
  const target = readRulesFile(store.projectDir, {signal});
  if (target.status !== 'safe' || target.hash !== row.afterHash || !sameVersion(target.identity, proof.publishedIdentity) || !sameNode(target.directoryIdentity, proof.directoryIdentity)) return false;
  const candidate = inspectRulesArtifact(store.projectDir, proof.candidateName, {signal});
  if (candidate.status !== 'safe' || candidate.hash !== row.afterHash || !sameVersion(candidate.identity, proof.candidateIdentity) || !sameVersion(candidate.identity,proof.publishedIdentity)) return false;
  if (row.expectedExists) {
   const backup = inspectRulesArtifact(store.projectDir, proof.backupName, {signal});
   if (backup.status !== 'safe' || backup.hash !== row.beforeHash || proof.capturedIdentity === null || proof.capturedHash !== row.beforeHash || !sameVersion(backup.identity, proof.capturedIdentity)) return false;
  }
  return true;
 }
 function complete(row: MioRuleWrite, approval?: MioRulesApproval): ProjectRulesSnapshot {
  live(); if (!published(row)) fail('MIO_RULES_WRITE_UNCERTAIN');
  if (row.state !== 'published' && row.state !== 'trust_pending') row = store.tx(() => repository.transition(row.requestId, row.state, 'published', {updatedAt: at()}));
  if (row.state === 'published') row = store.tx(() => repository.transition(row.requestId, 'published', 'trust_pending', {updatedAt: at()}));
  checkpoint('before_trust');
  // Recheck after fault/lifecycle hooks, immediately before B1 trust. An outside
  // writer never acquires trust merely by producing the same text elsewhere.
  if (!published(row)) fail('MIO_RULES_WRITE_UNCERTAIN');
  const result: ProjectRulesSnapshot = {projectId, file: 'AGENTS.md', exists: true, text: records.blob(row.afterBlobHash), hash: row.afterHash, trust: 'trusted', maxBytes: RULES_MAX_BYTES, readError: null, pendingWrites: false};
  application.tx(() => {
   live();
   const previous = operationReceipt('project.rules.save', row.requestId, row.digest);
   if (previous) {
    if (application.rulesTrust.get(projectId)?.sha256 !== row.afterHash) fail('MIO_RULES_WRITE_UNCERTAIN');
    return;
   }
   application.rulesTrust.set({projectId, sha256: row.afterHash, trustedAt: at()});
   application.receipts.write({operation: 'project.rules.save', requestId: row.requestId, digest: row.digest, response: result, createdAt: at()});
  });
  checkpoint('trusted');
  store.tx(() => {
   live(); repository.transition(row.requestId, 'trust_pending', 'completed', {updatedAt: at()});
   approval?.recordInside(JSON.parse(JSON.stringify({file: 'AGENTS.md', hash: row.afterHash, requestId: row.requestId, state: 'completed'})) as AgentTaskJson);
  });
  checkpoint('completed');
  // Cleanup can be retried independently after both durable domains agree.
  // Terminal intent stays immutable; an interrupted cleanup grants no authority.
  if (row.fileIdentity) finishRulesFileCleanup(store.projectDir, row.fileIdentity, {signal, checkpoint: () => live()});
  return result;
 }
 function save(input: unknown, approval?: MioRulesApproval): ProjectRulesSnapshot {
  return mutate(() => {
   const parsed = projectRulesSaveInputSchema.safeParse(input); if (!parsed.success) fail('MIO_RULES_INVALID');
   const value = parsed.data;
   if (approval) validateApproval(approval, value);
   const inputDigest = digest({projectId, actor: approval ? 'mio' : 'manual', runId: approval?.runId ?? null, stepId: approval?.stepId ?? null, approvalReceiptId: approval?.approvalReceiptId ?? null, expectedHash: value.expectedHash, text: value.text});
   const previous = repository.get(value.requestId);
   if (previous) {
    if (previous.digest !== inputDigest) fail('MIO_RULES_REQUEST_CONFLICT');
    if (previous.state !== 'completed') fail('MIO_RULES_WRITE_UNCERTAIN');
    return operationReceipt('project.rules.save', value.requestId, inputDigest) ?? fail('MIO_RULES_UNAVAILABLE');
   }
   if (application.receipts.read('project.rules.enable', value.requestId)) fail('MIO_RULES_REQUEST_CONFLICT');
   if (repository.listPending().length) fail('MIO_RULES_PENDING');
   const before = current(value.expectedHash), afterHash = hash(value.text), time = at(), token = randomUUID();
   let row = store.tx(() => {
    live(); const beforeHash = before.status === 'safe' ? records.putBlob(before.text, time) : null;
    records.putBlob(value.text, time);
    return repository.prepare({requestId: value.requestId, projectId, actor: approval ? 'mio' : 'manual', runId: approval?.runId ?? null, stepId: approval?.stepId ?? null, approvalReceiptId: approval?.approvalReceiptId ?? null, digest: inputDigest, expectedExists: before.status === 'safe', beforeHash, afterHash, beforeBlobHash: beforeHash, afterBlobHash: afterHash, fixedRelativeName: 'AGENTS.md', fileIdentity: null, state: 'prepared', createdAt: time, updatedAt: time});
   });
   checkpoint('prepared');
   const publicationResult = publishRulesFile(store.projectDir, {expectedExists: row.expectedExists, expectedHash: row.beforeHash, text: value.text, candidateName: `.mioon-rules-${token}.candidate`, backupName: `.mioon-rules-${token}.backup`, signal, deferCleanup: true, ...publication,
    checkpoint(evidence) {
     live(); row = store.tx(() => repository.transition(row.requestId, row.state, row.state === 'prepared' ? 'publication_unknown' : row.state, {fileIdentity: evidence, updatedAt: at()}));
    }});
   live();
   if (publicationResult.status !== 'published') fail('MIO_RULES_WRITE_UNCERTAIN');
   row = store.tx(() => repository.transition(row.requestId, row.state, 'published', {fileIdentity: publicationResult.evidence, updatedAt: at()}));
   checkpoint('published'); return complete(row, approval);
  });
 }
 function enable(input: unknown): ProjectRulesSnapshot {
  return mutate(() => {
   const parsed = projectRulesEnableInputSchema.safeParse(input); if (!parsed.success) fail('MIO_RULES_INVALID');
   const value = parsed.data, inputDigest = digest({projectId, ...value});
   if (repository.get(value.requestId) || application.receipts.read('project.rules.save', value.requestId)) fail('MIO_RULES_REQUEST_CONFLICT');
   const previous = operationReceipt('project.rules.enable', value.requestId, inputDigest); if (previous) return previous;
   if (repository.listPending().length) fail('MIO_RULES_PENDING');
   const file = current(value.expectedHash); if (file.status !== 'safe') fail('MIO_RULES_NOT_FOUND');
   const result: ProjectRulesSnapshot = {projectId, file: 'AGENTS.md', exists: true, text: file.text, hash: file.hash, trust: 'trusted', maxBytes: RULES_MAX_BYTES, pendingWrites: false, readError: null};
   application.tx(() => {
    live(); const reread = current(value.expectedHash);
    if (reread.status !== 'safe' || !sameNode(file.identity, reread.identity) || !sameNode(file.directoryIdentity, reread.directoryIdentity)) fail('MIO_RULES_CONFLICT');
    application.rulesTrust.set({projectId, sha256: file.hash, trustedAt: at()});
    application.receipts.write({operation: 'project.rules.enable', requestId: value.requestId, digest: inputDigest, response: result, createdAt: at()});
   });
   return result;
  });
 }
 function reconcile(requestId: string): ProjectRulesRequestLookup {
  return mutate(() => {
   if (!rulesRequestIdSchema.safeParse(requestId).success) fail('MIO_RULES_INVALID');
   const row = repository.get(requestId);
   if (!row || row.state === 'completed' || row.state === 'not_applied') return lookup(requestId);
   let approval: MioRulesApproval | undefined;
   if (row.actor === 'mio') {
    const step = journal.step(row.stepId!), data = step.data;
    if (!object(data) || typeof data.approvalDigest !== 'string') return lookup(requestId);
    approval = {runId: row.runId!, stepId: row.stepId!, approvalReceiptId: row.approvalReceiptId!, proposalDigest: data.approvalDigest,
     recordInside: result => journal.completeStepInside(row.runId!, row.stepId!, {result, changes: []})};
    validateApproval(approval, {expectedHash: row.beforeHash, text: records.blob(row.afterBlobHash)});
   }
   if (published(row)) complete(row, approval);
   else if (row.state === 'prepared' && row.fileIdentity === null) {
    // No filesystem checkpoint was committed, so no file operation could run.
    store.tx(() => {
     repository.transition(requestId, 'prepared', 'not_applied', {updatedAt: at()});
     approval?.recordInside({error:{code:'RULES_NOT_APPLIED',message:'规范发布未执行，请重新规划；原请求不会自动重试。'}});
    });
   }
   return lookup(requestId);
  });
 }
 return Object.freeze({read, capture, proposal, save, enable, lookup, reconcile, close: () => {closed = true;}, isBusy: () => busy, drain: async () => {}});
}
export type MioProjectRules = ReturnType<typeof createMioProjectRules>;
