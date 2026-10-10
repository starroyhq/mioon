import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMutation, isMutationOperation, mutationNotApplied, validateMutationResponse } from '../apps/web/src/mutation-submissions.js';
import { readPending, clearPending, prepareSubmission, reconcilePending } from '../apps/web/src/submissions.js';

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

test('App opts every six-op path in, uses explicit drawer replay, and never resumes a partial structure', () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /stored = mutation \? prepareMutation\(entry, \{ replay \}\) : prepareSubmission\(entry\)/);
  assert.match(app, /mutation && replay \? null : result/);
  assert.match(app, /entry\.input, '原请求已恢复并确认', \{ replay: true \}/);
  assert.match(app, /mutation \? mutationNotApplied\(e, stored\) : timeline \|\| isReferenceOperation\(operation\)/);
  assert.match(app, /hasRequestNotAppliedProof\(e, stored\.input, \{ operation \}\)/);
  assert.match(app, /isBusy\('canvas:mutation', projectId\)/);
  assert.doesNotMatch(app, /await rpc\('(shot\.create|shot\.update|shot\.reorder|node\.create|node\.update|version\.select)'/);
  const structure = app.slice(app.indexOf('async function addStructure()'), app.indexOf('async function addNode('));
  assert.match(structure, /owner !== currentProject\.current/);
  assert.match(structure, /dataRef\.current\.shots\.length \|\| dataRef\.current\.nodes\.length/);
  assert.match(structure, /if \(!isCurrent\(captured\)\) return/);
  assert.match(structure, /if \(!created\).*已确认 \$\{done\}\/3.*其余镜头不会自动创建.*return;/);
});

test('six-op recovery warns about session-only unencrypted receipts without changing generation guarantees', () => {
  const card = readFileSync(new URL('../apps/web/src/PendingSubmission.jsx', import.meta.url), 'utf8');
  assert.match(card, /mutation &&/);
  assert.match(card, /恢复记录仅存于当前浏览器会话，未经保险库加密/);
  assert.match(card, /关闭窗口或重建应用会话可能丢失记录/);
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /生成任务状态持久保存/);
});

test('a colliding legacy receipt can never silently turn a new edit into another operation', t => {
  fixture(t);
  const original = prepareSubmission(entry({ operation: 'generation.submit', input: { shotId: 'shot-a', requestId: 'legacy-colliding-request' } }));
  assert.throws(() => prepareMutation(entry(), { requestId: allocate }), { code: 'MUTATION_PENDING' });
  assert.deepEqual(readPending(original.projectId, original.key), original);
});
