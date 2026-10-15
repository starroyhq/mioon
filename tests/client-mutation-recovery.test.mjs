import { translate } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIMELINE_MUTATION_OPERATIONS, REFERENCE_MUTATION_OPERATIONS, hasRequestNotAppliedProof } from '@mioon/contracts';
import { prepareMutation, isMutationOperation, mutationNotApplied, validateMutationResponse } from '../apps/web/src/mutation-submissions.js';
import { readPending, clearPending, prepareSubmission, reconcilePending } from '../apps/web/src/submissions.js';
import { loudnessApplyFixture } from './fixtures/timeline-loudness-apply.mjs';

class Storage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function fixture(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = new Storage();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
  return storage;
}
const entry = (overrides = {}) => ({ projectId: 'project-a', key: 'save:shot-a', operation: 'shot.update', createdAt: '2026-10-09T20:00:00Z', input: { shotId: 'shot-a', expectedRevision: 3, patch: { prompt: 'Original draft', parameters: { seed: 8 } } }, ...overrides });
const allocate = () => 'original-mutation-request';

test('all six mutations opt in, persist a deep exact input once, and never generate an ID for replay', t => {
  fixture(t);
  for (const operation of ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select']) {
    assert.equal(isMutationOperation(operation), true);
    const draft = entry({ operation }); let ids = 0;
    const stored = prepareMutation(draft, { requestId: () => { ids++; return allocate(); } });
    assert.deepEqual(readPending(draft.projectId, draft.key), stored);
    draft.input.patch.prompt = 'Later edit'; draft.input.patch.parameters.seed = 9;
    assert.equal(stored.input.patch.prompt, 'Original draft');
    assert.equal(stored.input.patch.parameters.seed, 8);
    assert.deepEqual(prepareMutation(stored, { replay: true, requestId: () => { throw Error('No new ID during replay'); } }), stored);
    assert.equal(ids, 1); clearPending(stored.projectId, stored.key);
  }
  assert.equal(isMutationOperation('generation.submit'), false);
});

test('new intent never receives an old save acknowledgement or replaces unknown input', t => {
  fixture(t); const original = prepareMutation(entry(), { requestId: allocate }); let ids = 0;
  for (const changed of [entry(), entry({ input: { shotId: 'shot-a', expectedRevision: 9, patch: { prompt: 'New draft' } } }), entry({ key: 'node-create', operation: 'node.create', input: { projectId: 'project-a', type: 'text' } })])
    assert.throws(() => prepareMutation(changed, { requestId: () => { ids++; return 'must-not-replace'; } }), { code: 'MUTATION_PENDING' });
  assert.equal(ids, 0); assert.deepEqual(readPending(original.projectId, original.key), original);
  assert.throws(() => prepareMutation({ ...original, input: { ...original.input, expectedRevision: 9 } }, { replay: true }), { code: 'MUTATION_REPLAY_MISMATCH' });
  assert.throws(() => prepareMutation({ ...original, operation: 'node.update' }, { replay: true }), { code: 'MUTATION_REPLAY_MISMATCH' });
});

test('pending mutation blocks only its project and newer server state cannot establish its outcome', t => {
  fixture(t); const original = prepareMutation(entry(), { requestId: allocate });
  const other = prepareMutation(entry({ projectId: 'project-b' }), { requestId: () => 'second-project-request' });
  assert.equal(other.projectId, 'project-b');
  reconcilePending('project-a', { shots: [{ id: 'shot-a', revision: 99 }], jobs: [{ requestId: allocate() }], exports: [{ requestId: allocate() }] });
  assert.deepEqual(readPending('project-a', original.key), original);
  assert.throws(() => prepareMutation(entry({ projectId: 'project-c', input: { projectId: 'project-a' } })), { code: 'MUTATION_PROJECT_MISMATCH' });
});

test('legacy durable submissions retain their existing exact replay behavior', t => {
  fixture(t); const original = prepareSubmission(entry({ operation: 'generation.submit', key: 'generate:shot-a', input: { requestId: 'legacy-request', shotId: 'shot-a' } }));
  const mutation = prepareMutation(entry(), { requestId: allocate });
  assert.equal(mutation.operation, 'shot.update');
  assert.deepEqual(prepareSubmission({ ...original, input: { requestId: 'replacement' } }), original);
});

test('storage denial, silent write failure and corruption fail closed before a mutation dispatch', t => {
  const storage = fixture(t), originalSet = storage.setItem;
  storage.setItem = () => { throw Error('QuotaExceededError'); };
  assert.throws(() => prepareMutation(entry()), /无法保存/);
  storage.setItem = () => {};
  assert.throws(() => prepareMutation(entry()), /未能保存/);
  storage.setItem = originalSet;
  storage.setItem('mioon.pending.v1:project-a:damaged', '{');
  assert.throws(() => prepareMutation(entry()), SyntaxError);
  storage.setItem('mioon.pending.v1:project-a:damaged', JSON.stringify({ ...entry(), input: {} }));
  assert.throws(() => prepareMutation(entry()), /记录损坏/);
});

test('only exact backend rollback proof can clear a mutation failure', t => {
  fixture(t); const stored = prepareMutation(entry(), { requestId: allocate });
  for (const code of ['UNAUTHORIZED', 'ORIGIN_REJECTED', 'IDEMPOTENCY_CONFLICT', 'REVISION_CONFLICT', 'NETWORK', 'BACKEND_PROTOCOL_ERROR'])
    assert.equal(mutationNotApplied({ code, definitive: true, details: {} }, stored), false);
  const proof = { definitive: true, details: { mutationOutcome: 'not_applied', requestId: allocate() } };
  assert.equal(mutationNotApplied(proof, stored), true);
  assert.equal(mutationNotApplied({ ...proof, definitive: false }, stored), false);
  assert.equal(mutationNotApplied({ ...proof, details: { ...proof.details, requestId: 'different-request' } }, stored), false);
  assert.equal(mutationNotApplied(proof, null), false);
});

test('historical responses must identify the original project and target before acknowledging', t => {
  fixture(t); const stored = prepareMutation(entry(), { requestId: allocate });
  const response = { id: 'shot-a', projectId: 'project-a', revision: 4, prompt: 'Original draft' };
  assert.equal(validateMutationResponse(stored, response), response);
  for (const invalid of [null, [], {}, { ...response, id: 'other' }, { ...response, projectId: 'other' }, { ...response, revision: 0 }, { ...response, revision: '4' }])
    assert.throws(() => validateMutationResponse(stored, invalid), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual(readPending(stored.projectId, stored.key), stored);
  const order = { ...stored, operation: 'shot.reorder', input: { projectId: 'project-a' } };
  assert.doesNotThrow(() => validateMutationResponse(order, { id: 'project-a', revision: 5 }));
});

test('App opts every six-op path in, uses explicit drawer replay, and never resumes a partial structure', async () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /stored = mutation \? prepareMutation\(entry, \{ replay \}\) : prepareSubmission\(entry, \{ replay \}\)/);
  assert.match(app, /mutation && replay \? null : result/);
  assert.match(readFileSync(new URL('../apps/web/src/TaskCenter.jsx', import.meta.url), 'utf8'), /entry\.input, message\('tasks\.center\.originalRecovered'\), restored \? \{ replay: true, pendingEntry: entry \} : \{ replay: true \}/);
  assert.equal(translate('zh-Hans', 'tasks.center.originalRecovered'), '原请求已恢复并确认');
  // Evaluate the actual App classifier rather than require its former inline
  // `timeline || isReferenceOperation(...)` spelling. Reference proof handling
  // must remain stricter than a generic definitive 4xx after the alias refactor.
  const run = app.slice(app.indexOf('async function runSession('), app.indexOf('async function inspect(')).replace('async function runSession(', 'async function run(');
  const flagsEnd = 'const requestBound = timeline || reference;';
  const flagsStart = run.indexOf('const mutation ='), flagsStop = run.indexOf(flagsEnd);
  assert.ok(flagsStart >= 0 && flagsStop > flagsStart, 'The actual classification declarations must remain present');
  const flags = run.slice(flagsStart, flagsStop + flagsEnd.length);
  const decision = run.slice(run.indexOf('const rejected ='), run.indexOf('onFailure?.'));
  assert.ok(flags && decision, 'The test must evaluate the real App failure path');
  const classify = Function('operation', 'e', 'stored', 'isMutationOperation', 'TIMELINE_MUTATION_OPERATIONS', 'REFERENCE_MUTATION_OPERATIONS',
    'mutationNotApplied', 'hasRequestNotAppliedProof', `${flags}\n${decision}\nreturn rejected;`);
  const owner = '87000000-0000-4000-8000-000000000001', other = '87000000-0000-4000-8000-000000000002';
  const stored = { input: { projectId: owner, requestId: 'original-app-classification-request' } };
  const loudnessInput = (await loudnessApplyFixture(stored.input)).input;
  const check = (operation, error, receipt = stored) => classify(operation, error, receipt, isMutationOperation,
    TIMELINE_MUTATION_OPERATIONS, REFERENCE_MUTATION_OPERATIONS, mutationNotApplied, hasRequestNotAppliedProof);
  const rejection = { code: 'REVISION_CONFLICT', definitive: true, details: {} };
  for (const operation of ['shot.create', 'shot.update', 'shot.reorder', 'node.create', 'node.update', 'version.select', ...TIMELINE_MUTATION_OPERATIONS]) {
    assert.equal(check(operation, rejection), false, `${operation} does not trust a bare 4xx`);
    if (operation === 'timeline.loudness.apply' || operation === 'timeline.format.set' || operation.startsWith('timeline.subtitle.')) {
      const fields = operation === 'timeline.loudness.apply' ? loudnessInput : operation === 'timeline.format.set' ? { expectedProjectRevision: 1, expectedRevision: 0, presetId: 'landscape_720' } : operation === 'timeline.subtitle.add' ? { expectedRevision: 1, text: '字幕', startFrame: 0, durationFrames: 30 } : { expectedRevision: 1, cueId: other, ...(operation === 'timeline.subtitle.update' ? { patch: { text: '字幕' } } : {}) };
      const formatStored = { input: { ...stored.input, ...fields } };
      const proof = { mutationOutcome: 'not_applied', operation, projectId: owner, requestId: stored.input.requestId };
      assert.equal(check(operation, { ...rejection, details: proof }, formatStored), true);
      for (const key of ['operation', 'projectId', 'requestId']) {
        const incomplete = { ...proof }; delete incomplete[key];
        assert.equal(check(operation, { ...rejection, details: incomplete }, formatStored), false, `${key} is mandatory for the new operation`);
      }
      assert.equal(check(operation, { ...rejection, details: proof }), false, 'A malformed saved intent cannot release a key');
    } else assert.equal(check(operation, { ...rejection, details: { mutationOutcome: 'not_applied', requestId: stored.input.requestId } }), true,
      `${operation} retains its existing request-bound proof contract`);
  }
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const details = { mutationOutcome: 'not_applied', operation, projectId: owner, requestId: stored.input.requestId };
    assert.equal(check(operation, rejection), false);
    assert.equal(check(operation, { ...rejection, details }), true, `${operation} uses explicit reference proof`);
    assert.equal(check(operation, { ...rejection, details }, null), false, 'No saved receipt means no release');
    for (const field of ['operation', 'projectId', 'requestId']) {
      const missing = { ...details }; delete missing[field];
      assert.equal(check(operation, { ...rejection, details: missing }), false, `Missing ${field} cannot release a reference key`);
    }
    for (const patch of [{ operation: operation === 'reference.attach' ? 'reference.detach' : 'reference.attach' },
      { projectId: other }, { requestId: 'different-reference-request' }])
      assert.equal(check(operation, { ...rejection, details: { ...details, ...patch } }), false);
    for (const code of ['TIMELINE_LIMIT', 'IDEMPOTENCY_CONFLICT', 'UNAUTHORIZED', 'BACKEND_PROTOCOL_ERROR'])
      assert.equal(check(operation, { ...rejection, code, details }), false, `${code} is not a reference rollback proof`);
  }
  assert.match(app, /isBusy\('canvas:mutation', projectId\)/);
  assert.doesNotMatch(app, /await rpc\('(shot\.create|shot\.update|shot\.reorder|node\.create|node\.update|version\.select)'/);
  const structure = app.slice(app.indexOf('async function addStructure()'), app.indexOf('async function addNode('));
  assert.match(structure, /owner !== currentProject\.current/);
  assert.match(structure, /dataRef\.current\.shots\.length \|\| dataRef\.current\.nodes\.length/);
  assert.match(structure, /if \(!isCurrent\(captured\)\) return/);
  assert.match(structure, /if \(!created\).*msg\('projects\.structureStopped', \{ count: done \}\).*return;/);
  assert.match(translate('zh-Hans', 'projects.structureStopped', { count: 1 }), /已确认 1\/3.*其余镜头不会自动创建/);
});

test('six-op recovery warns about session-only unencrypted receipts without changing generation guarantees', () => {
  const card = readFileSync(new URL('../apps/web/src/PendingSubmission.jsx', import.meta.url), 'utf8');
  assert.match(card, /mutation &&/);
  assert.match(card, /t\('tasks\.pending\.mutationStorage'\)/);
  const notice = translate('zh-Hans', 'tasks.pending.mutationStorage');
  assert.match(notice, /恢复记录仅存于当前浏览器会话，未经保险库加密/);
  assert.match(notice, /关闭窗口或重建应用会话可能丢失记录/);
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(readFileSync(new URL('../apps/web/src/TaskWorkspace.tsx', import.meta.url), 'utf8'), /t\('tasks\.workspace\.durableState'\)/);
  assert.match(translate('zh-Hans', 'tasks.workspace.durableState'), /生成任务状态持久保存/);
});

test('a colliding legacy receipt can never silently turn a new edit into another operation', t => {
  fixture(t);
  const original = prepareSubmission(entry({ operation: 'generation.submit', input: { shotId: 'shot-a', requestId: 'legacy-colliding-request' } }));
  assert.throws(() => prepareMutation(entry(), { requestId: allocate }), { code: 'MUTATION_PENDING' });
  assert.deepEqual(readPending(original.projectId, original.key), original);
});
