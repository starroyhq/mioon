import test from 'node:test';
import assert from 'node:assert/strict';
import {saveGenerationServiceDomains} from '../apps/web/src/generation-services-settings.ts';
import type {GenerationDomainOutcome, GenerationSaveTicket} from '../apps/web/src/generation-services-settings.ts';

test('page save prepares and synchronously clears every domain before the first transport starts', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: string[] = [], inputs = [{value: 'synthetic-video'}, {value: 'synthetic-image'}, {value: 'synthetic-official'}];
  const domains = inputs.map((input, index) => ({
    clearKeys() {input.value = '';},
    prepareSave(): GenerationSaveTicket {
      let body: string | null = input.value, used = false;
      input.value = ''; events.push(`prepare:${index}`);
      return {
        dispose() {body = null; events.push(`dispose:${index}`);},
        async run() {
          assert.equal(used, false); used = true;
          assert.deepEqual(inputs.map(item => item.value), ['', '', '']);
          assert.ok(body); body = null;
          events.push(`send:${index}`);
          if (!index) {entered.resolve(); await release.promise;}
          return 'saved';
        },
      };
    },
  }));
  const saving = saveGenerationServiceDomains(domains);
  await entered.promise;
  assert.deepEqual(events, ['prepare:0', 'prepare:1', 'prepare:2', 'send:0']);
  release.resolve();
  assert.deepEqual(await saving, {state: 'saved', confirmed: 3});
  assert.deepEqual(events, ['prepare:0', 'prepare:1', 'prepare:2', 'send:0', 'send:1', 'send:2', 'dispose:0', 'dispose:1', 'dispose:2']);
  assert.doesNotMatch(JSON.stringify(events), /synthetic/);
});

test('invalid draft does not short-circuit later password clearing and prevents every write', async () => {
  let sent = 0, disposed = 0;
  const inputs = [{value: 'synthetic-A'}, {value: 'synthetic-B'}, {value: 'synthetic-C'}];
  const result = await saveGenerationServiceDomains(inputs.map((input, index) => ({
    clearKeys() {input.value = '';},
    prepareSave() {
      if (index === 1) throw new Error('SAFE_VALIDATION');
      return {async run() {sent++; return 'saved' as const;}, dispose() {disposed++;}};
    },
  })));
  assert.deepEqual(result, {state: 'error', confirmed: 0});
  assert.deepEqual(inputs.map(input => input.value), ['', '', '']);
  assert.equal(sent, 0); assert.equal(disposed, 2);
});

for (const outcome of ['error', 'unknown', 'blocked'] as const) test(`confirmed files remain partial after ${outcome}; later domains are not sent`, async () => {
  const sent: number[] = [], disposed: number[] = [];
  const result = await saveGenerationServiceDomains([0, 1, 2].map(index => ({
    clearKeys() {}, prepareSave() {return {async run(): Promise<GenerationDomainOutcome> {sent.push(index); return index === 1 ? outcome : 'saved';}, dispose() {disposed.push(index);}};},
  })));
  assert.deepEqual(result, {state: 'partial', confirmed: 1});
  assert.deepEqual(sent, [0, 1]); assert.deepEqual(disposed, [0, 1, 2]);
});

test('unexpected transport rejection is unknown, never replayed, and releases unsent tickets', async () => {
  let sent = 0, disposed = 0;
  const result = await saveGenerationServiceDomains([0, 1].map(() => ({
    clearKeys() {}, prepareSave() {return {async run(): Promise<GenerationDomainOutcome> {sent++; throw new Error('untrusted response');}, dispose() {disposed++;}};},
  })));
  assert.deepEqual(result, {state: 'unknown', confirmed: 0}); assert.equal(sent, 1); assert.equal(disposed, 2);
});
