import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {registerProjectTransactionObserver} from '../../packages/business/src/project-file/index.ts';
import {createMioTestFixture} from './mio-runtime-fixture.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const root = required('MIO_RUNTIME_ROOT'), point = required('MIO_RUNTIME_POINT');
const barrier = (): never => {
  writeFileSync(required('MIO_RUNTIME_MARKER'), 'ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('The parent must kill the worker at its requested runtime boundary');
};
const gateway: TaskGateway = async function* (request) {
  request.beforeSubmit?.();
  writeFileSync(path.join(root, 'gateway-body.txt'), request.body);
  if (point === 'dispatch-after-commit') barrier();
  yield {type: 'delta', text: 'PARTIAL_CHECKPOINT_'.repeat(600)};
  if (point === 'first-delta') barrier();
  yield {type: 'done', output: {text: 'Complete synthetic output', toolCalls: [], providerOutput: {role: 'assistant', content: 'Complete synthetic output'}}};
};
const f = await createMioTestFixture(root, gateway, journal => new Proxy(journal, {
  get(target, property, receiver) {
    if (property === 'beginModelStep') return (...args: Parameters<typeof journal.beginModelStep>) => {
      const step = target.beginModelStep(...args);
      if (point === 'intent-after-commit') barrier();
      return step;
    };
    return Reflect.get(target, property, receiver);
  },
}));
registerProjectTransactionObserver(f.store.db, () => {
  const request = f.store.db.prepare('SELECT state,originalBody FROM mio_requests ORDER BY rowid DESC LIMIT 1').get();
  if (point === 'intent-before-commit' && request?.state === 'intent'
    || point === 'dispatch-before-commit' && request?.state === 'dispatch_started'
    || point === 'completion-before-commit' && request?.state === 'completed' && request.originalBody === null) barrier();
});
const sent = await f.runtime.send(f.store.projectId, {requestId: randomUUID(), expectedSettingsRevision: 1, text: 'Reply with a synthetic answer.'});
await f.runtime.drain();
if (point === 'completion-after-commit' && f.runtime.get(f.store.projectId, sent.run.id).run.status === 'completed') barrier();
await f.close();
throw new Error(`The runtime did not reach its requested barrier: ${point}`);
