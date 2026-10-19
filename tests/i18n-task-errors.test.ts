import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LOCALES, renderMessage } from '../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../packages/i18n/src/index.ts';
import type { EditTaskClient } from '../apps/web/src/edit-task-client.ts';
import { readPending, writePending, prepareSubmission, prepareRequestReplay } from '../apps/web/src/submissions.ts';
import { assertMutationOwner, prepareMutation, validateMutationResponse } from '../apps/web/src/mutation-submissions.ts';
import { taskProtocolError } from '../apps/web/src/edit-task-client.ts';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.ts';

class Storage {
  values = new Map<string, string>(); writes = 0;
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: unknown): void { this.writes++; this.values.set(key, String(value)); }
  removeItem(key: string): void { this.values.delete(key); }
}
function storageFixture(t: import('node:test').TestContext) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), storage = new Storage();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete (globalThis as { sessionStorage?: unknown }).sessionStorage);
  return storage;
}
const entry = (overrides: Record<string, unknown> = {}) => ({ projectId: 'project-a', key: 'save:shot-a', operation: 'shot.update', createdAt: '2026-10-09T20:00:00Z', input: { projectId: 'project-a', requestId: 'exact-original-request', shotId: 'shot-a', expectedRevision: 3, patch: { prompt: 'Original 日本語 / 用户 draft' } }, ...overrides });
type DisplayError = Error & { displayMessage: DisplayMessage; code?: string; details?: unknown; definitive?: unknown };
function verify(error: unknown, key: string, code?: string): true {
  assert.ok(error instanceof Error); const failure = error as DisplayError;
  assert.equal(failure.displayMessage.key, `tasks.localError.${key}`);
  if (code) assert.equal(failure.code, code);
  const original = { message: failure.message, code: failure.code, details: failure.details, definitive: failure.definitive };
  assert.equal(renderMessage('zh-Hans', failure.displayMessage), failure.message.replace(/。$/u, ''));
  for (const locale of LOCALES) assert.ok(renderMessage(locale, failure.displayMessage).length);
  assert.deepEqual({ message: failure.message, code: failure.code, details: failure.details, definitive: failure.definitive }, original);
  return true;
}
const throws = (fn: () => unknown, key: string, code?: string) => assert.throws(fn, (error: unknown) => verify(error, key, code));

test('pending request diagnostics relabel in all four locales without changing original input or saved bytes', t => {
  const storage = storageFixture(t), original = entry(), frozenInput = JSON.stringify(original);
  storage.setItem('mioon.pending.v1:project-a:save:shot-a', JSON.stringify({ ...original, input: {} }));
  throws(() => readPending(original.projectId, original.key), 'pendingCorrupt');
  storage.values.clear();
  throws(() => prepareRequestReplay(original), 'replayUnavailable', 'MUTATION_REPLAY_MISMATCH');
  throws(() => prepareSubmission(entry({ operation: 'generation.submit', input: { ...original.input, subjectVersionId: 'subject-version' } })), 'subjectPin', 'SUBJECT_SUBMISSION_MISMATCH');
  throws(() => prepareSubmission(entry({ operation: 'job.retry', subjectRetry: true })), 'subjectRetryPin', 'SUBJECT_SUBMISSION_MISMATCH');
  const save = storage.setItem;
  storage.setItem = () => { throw Error('Synthetic storage unavailable'); };
  throws(() => writePending(original), 'pendingStorage');
  storage.setItem = () => {};
  throws(() => prepareSubmission(original), 'pendingNotSaved');
  storage.setItem = save;
  const saved = prepareSubmission(original), before = [...storage.values], writes = storage.writes;
  throws(() => prepareMutation(entry()), 'mutationPending', 'MUTATION_PENDING');
  assert.deepEqual([...storage.values], before); assert.equal(storage.writes, writes);
  assert.deepEqual(saved, original); assert.equal(JSON.stringify(original), frozenInput);
});

test('mutation error sidecars keep exact original codes, guidance and recovery identity', t => {
  storageFixture(t);
  throws(() => assertMutationOwner(entry(), { project: { id: 'different-project' } }), 'targetChanged', 'MUTATION_PROJECT_MISMATCH');
  throws(() => prepareMutation(entry({ operation: 'unsupported' })), 'unsupportedRecovery', 'INVALID_MUTATION');
  throws(() => prepareMutation(entry({ input: { projectId: 'different-project' } })), 'projectChanged', 'MUTATION_PROJECT_MISMATCH');
  throws(() => prepareMutation(entry(), { replay: true }), 'replayChanged', 'MUTATION_REPLAY_MISMATCH');
  throws(() => validateMutationResponse(entry(), null), 'mutationProtocol', 'BACKEND_PROTOCOL_ERROR');
  verify(taskProtocolError(), 'taskProtocol', 'BACKEND_PROTOCOL_ERROR');
});

test('task controller errors remain descriptors across relabeling with no extra task calls', async () => {
  const projectId = '91000000-0000-4000-8000-000000000001', instanceId = '91000000-0000-4000-8000-000000000003';
  let calls = 0;
  const controller = createEditTaskController({ client: { list: async (args: { cursor?: string | null }) => { calls++; return { items: [], nextCursor: args.cursor ? null : 'next-page', instanceId: args.cursor ? '91000000-0000-4000-8000-000000000099' : instanceId }; } } as unknown as EditTaskClient });
  const input = { projectId, expectedRevision: 1, requestId: 'exact-request', trackId: '91000000-0000-4000-8000-000000000004', patch: { muted: true } };
  await assert.rejects(controller.submit({ projectId, operation: 'timeline.track.update', input } as never), (error: unknown) => verify(error, 'listUnverified', 'TASK_LIST_UNAVAILABLE'));
  await assert.rejects(controller.submit({ projectId, operation: 'not-an-operation', input } as never), (error: unknown) => verify(error, 'requestChanged', 'MUTATION_PROJECT_MISMATCH'));
  assert.equal(calls, 0);
  const state = await controller.load(projectId);
  assert.equal(state.phase, 'error'); assert.ok(state.error); verify(state.error, 'serverChanged', 'TASK_SERVER_CHANGED');
  assert.equal(calls, 2); assert.equal(controller.blocked(projectId, 'timeline:mutation'), true);
});

test('every retained local task diagnostic has an adjacent explicit display descriptor', () => {
  for (const file of ['submissions.ts', 'mutation-submissions.ts', 'edit-task-client.ts', 'edit-task-controller.ts']) {
    const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let diagnostics = 0;
    function visit(node: ts.Node): void {
      if (ts.isStringLiteralLike(node) && /[\u3400-\u9fff]/u.test(node.text)) {
        diagnostics++;
        const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        assert.match(source.split('\n')[line], /localizedMessage\('tasks\.localError\./, `${file}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast); assert.ok(diagnostics > 0);
  }
});
