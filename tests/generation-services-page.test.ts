import test from 'node:test';
import assert from 'node:assert/strict';
import {saveGenerationServiceDomains} from '../apps/web/src/generation-services-settings.ts';
import type {GenerationDomainOutcome, GenerationSaveTicket} from '../apps/web/src/generation-services-settings.ts';
import {createGenerationLiveSettings} from '../apps/web/src/generation-services-live-setting.ts';
import type {WorkspaceSettings, WorkspaceSettingsUpdate} from '../packages/contracts/src/workspace-configuration.ts';

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

function liveFixture(enabled: boolean) {
  let stored: WorkspaceSettings = {formatVersion: 1, revision: 7, liveGeneration: enabled};
  const calls: WorkspaceSettingsUpdate[] = []; let reads = 0;
  const owner = createGenerationLiveSettings({client: {
    async read() {reads++; return structuredClone(stored);},
    async write(input) {calls.push(structuredClone(input)); assert.equal(input.expectedRevision, stored.revision); stored = {...stored, revision: stored.revision + 1, liveGeneration: input.liveGeneration}; return structuredClone(stored);},
  }});
  return {owner, calls, reads: () => reads, stored: () => structuredClone(stored)};
}

test('changing the real-generation switch only drafts; closing is the first confirmed file', async () => {
  const f = liveFixture(true); f.owner.setVisible(true); await f.owner.load();
  assert.equal(f.owner.setEnabled(false), true); assert.deepEqual(f.calls, []);
  const events: string[] = [];
  const gate = {clearKeys() {}, prepareSave: f.owner.prepareSave};
  const video = {clearKeys() {}, prepareSave() {return {async run() {assert.equal(f.stored().liveGeneration, false); events.push('video'); return 'error' as const;}, dispose() {}};}};
  assert.deepEqual(await saveGenerationServiceDomains([gate, video]), {state: 'partial', confirmed: 1});
  assert.deepEqual(f.calls, [{expectedRevision: 7, liveGeneration: false}]); assert.deepEqual(events, ['video']);
  f.owner.dispose();
});

test('an opening is never sent if an earlier service file is unconfirmed', async () => {
  const f = liveFixture(false); f.owner.setVisible(true); await f.owner.load(); f.owner.setEnabled(true);
  const service = {clearKeys() {}, prepareSave() {return {async run() {return 'unknown' as const;}, dispose() {}};}};
  const gate = {clearKeys() {}, prepareSave: f.owner.prepareSave};
  assert.deepEqual(await saveGenerationServiceDomains([service, gate]), {state: 'unknown', confirmed: 0});
  assert.deepEqual(f.calls, []); assert.equal(f.stored().liveGeneration, false);
  assert.equal(f.owner.getState().draft, true); f.owner.dispose();
});

test('an opening runs once after all service files and its ticket is not reusable', async () => {
  const f = liveFixture(false); f.owner.setVisible(true); await f.owner.load(); f.owner.setEnabled(true);
  const events: string[] = [];
  const domains = ['video', 'custom', 'official', 'comfy'].map(name => ({clearKeys() {}, prepareSave() {return {async run() {assert.equal(f.stored().liveGeneration, false); events.push(name); return 'saved' as const;}, dispose() {}};}}));
  assert.deepEqual(await saveGenerationServiceDomains([...domains, {clearKeys() {}, prepareSave: f.owner.prepareSave}]), {state: 'saved', confirmed: 5});
  assert.deepEqual(events, ['video', 'custom', 'official', 'comfy']); assert.equal(f.calls.length, 1); assert.equal(f.stored().liveGeneration, true);
  f.owner.setEnabled(false); const ticket = f.owner.prepareSave()!;
  assert.equal(await ticket.run(), 'saved'); assert.equal(await ticket.run(), 'blocked'); assert.equal(f.calls.length, 2); f.owner.dispose();
});

test('a lost live-gate ACK reads once but a matching value remains unknown until explicit review', async () => {
  let reads = 0, writes = 0;
  const owner = createGenerationLiveSettings({client: {
    async read() {reads++; return {formatVersion: 1, revision: writes ? 8 : 7, liveGeneration: !!writes};},
    async write() {writes++; throw new Error('ACK_LOST');},
  }});
  owner.setVisible(true); await owner.load(); owner.setEnabled(true);
  assert.equal(await owner.prepareSave()!.run(), 'unknown'); assert.equal(writes, 1); assert.equal(reads, 2);
  assert.equal(owner.getState().phase, 'review'); assert.equal(owner.getState().recovery, 'unknown');
  assert.equal(owner.setEnabled(false), false); assert.equal(owner.discard(), false);
  // Even though the readback happens to match, no write or retry is permitted.
  assert.throws(() => owner.prepareSave(), /GENERATION_SETTINGS_NOT_READY/); assert.equal(writes, 1);
  assert.equal(owner.useLatest(), true); assert.equal(owner.getState().recovery, null); owner.dispose();
});

test('hide/reopen, edits and disposal fence prepared live-gate tickets without sending', async () => {
  const f = liveFixture(false); f.owner.setVisible(true); await f.owner.load(); f.owner.setEnabled(true);
  const hidden = f.owner.prepareSave()!; f.owner.setVisible(false); f.owner.setVisible(true); assert.equal(await hidden.run(), 'blocked');
  const edited = f.owner.prepareSave()!; f.owner.setEnabled(false); assert.equal(await edited.run(), 'blocked');
  f.owner.setEnabled(true); const disposed = f.owner.prepareSave()!; f.owner.dispose(); assert.equal(await disposed.run(), 'blocked');
  assert.deepEqual(f.calls, []);
});

test('accepted gate write may finish hidden; a retired owner cannot publish a late ACK', async () => {
  const pending = Promise.withResolvers<WorkspaceSettings>(), states: string[] = [];
  const owner = createGenerationLiveSettings({client: {read: async () => ({formatVersion: 1, revision: 1, liveGeneration: false}), write: () => pending.promise}, onChange: state => states.push(state.phase)});
  owner.setVisible(true); await owner.load(); owner.setEnabled(true); const saving = owner.prepareSave()!.run();
  owner.setVisible(false); owner.dispose(); const before = [...states];
  pending.resolve({formatVersion: 1, revision: 2, liveGeneration: true}); assert.equal(await saving, 'blocked'); assert.deepEqual(states, before);
});

test('hide/reopen on the same owner never adopts a late live-gate ACK into the new page', async () => {
  const pending = Promise.withResolvers<WorkspaceSettings>();
  let writes = 0, reads = 0, confirmed = 0;
  let stored: WorkspaceSettings = {formatVersion: 1, revision: 1, liveGeneration: false};
  const owner = createGenerationLiveSettings({client: {
    async read() {reads++; return structuredClone(stored);},
    write() {writes++; return pending.promise;},
  }, onConfirmed() {confirmed++;}});
  owner.setVisible(true); await owner.load(); owner.setEnabled(true);
  const saving = owner.prepareSave()!.run();
  owner.setVisible(false); owner.setVisible(true);
  // The server really committed; this old acknowledgement cannot admit UI data.
  stored = {formatVersion: 1, revision: 2, liveGeneration: true}; pending.resolve(stored);
  assert.equal(await saving, 'blocked'); assert.equal(confirmed, 0); assert.equal(writes, 1);
  assert.equal(owner.getState().snapshot!.revision, 1); assert.equal(owner.getState().phase, 'blocked');
  assert.equal(owner.getState().recovery, 'unknown'); assert.throws(() => owner.prepareSave());
  assert.equal(await owner.reload(), true); assert.equal(reads, 2); assert.equal(writes, 1);
  assert.equal(owner.getState().phase, 'review'); assert.equal(owner.useLatest(), true);
  assert.equal(owner.getState().snapshot!.revision, 2); owner.dispose();
});
