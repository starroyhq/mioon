import { LOCALES, renderMessage } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskEnvelope, validateTaskList } from '../apps/web/src/edit-task-client.ts';
const id = (n: number) => `93000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input = { projectId: id(1), expectedRevision: 1, requestId: 'original', trackId: id(2), patch: { muted: true } };
const task = { id: id(3), projectId: id(1), operation: 'timeline.track.update', input, requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', acknowledged: false, origin: 'new' };
const envelope = { task, instanceId: id(4) };

test('task domain origin and original input remain exact without outer workspace metadata', () => {
  const before = structuredClone(envelope), checked = validateTaskEnvelope(envelope, { projectId: id(1), taskId: id(3), input, origin: 'new' });
  assert.equal(checked, envelope); assert.equal(checked.task, task);
  assert.equal(checked.task.input, input); assert.deepEqual(envelope, before);
  assert.equal(validateTaskEnvelope({ ...envelope, task: { ...task, origin: 'legacy_session' } }, { origin: 'legacy_session' }).task.origin, 'legacy_session');
  assert.throws(() => validateTaskEnvelope(envelope, { origin: 'legacy_session' }), { code: 'BACKEND_PROTOCOL_ERROR' });
});
test('ordinary task envelopes and lists reject unexpected metadata and foreign project identity', () => {
  assert.equal(validateTaskEnvelope(envelope), envelope);
  const page = { items: [task], instanceId: id(4), nextCursor: null };
  assert.equal(validateTaskList(page, id(1)), page);
  assert.throws(() => validateTaskEnvelope({ ...envelope, extra: {} }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.throws(() => validateTaskEnvelope(envelope, { projectId: id(9) }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.throws(() => validateTaskList(page, id(9)), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.throws(() => validateTaskList({ ...page, extra: {} }, id(1)), { code: 'BACKEND_PROTOCOL_ERROR' });
});
test('invalid task response preserves diagnostic and localized retained-request guidance without changing input', () => {
  const broken = { ...envelope, task: { ...task, input: { ...input, requestId: '日本語 繁體 <literal>' } } }, before = structuredClone(broken);
  let failure!: Error & {code: string; displayMessage: import('../packages/i18n/src/index.ts').DisplayMessage};
  try { validateTaskEnvelope(broken); } catch (error) { failure = error as typeof failure; }
  assert.equal(failure.code, 'BACKEND_PROTOCOL_ERROR');
  assert.equal(failure.message, '任务确认无效。原请求仍保留，请重新核对任务；不会自动重试。');
  assert.equal(failure.displayMessage.key, 'tasks.localError.taskProtocol');
  assert.equal(new Set(LOCALES.map(locale => renderMessage(locale, failure.displayMessage))).size, 4);
  assert.match(renderMessage('en', failure.displayMessage), /original request/);
  assert.match(renderMessage('en', failure.displayMessage), /not|never/i);
  assert.deepEqual(broken, before);
});
