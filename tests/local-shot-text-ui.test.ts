import type {LocalShotTextContext,LocalShotTextSupported,ShotTextForm} from '../apps/web/src/local-shot-text-state.ts';
import type {LocalShotTextClient} from '../apps/web/src/local-shot-text-client.ts';
import type {LocalShotTextDraftPut,LocalShotTextDraftDelete,LocalShotTextPrepare,LocalShotTextExecute,LocalShotTextResponseTarget,LocalShotTextDraftRaw,LocalShotTextDraftValue} from '../packages/contracts/src/local-shot-text.ts';
type TextOverrides=Partial<{[K in keyof LocalShotTextClient]:(...args:Parameters<LocalShotTextClient[K]>)=>unknown}>;
type TextCall={method:'get';projectId:string;shotId:string}|{method:'put';input:LocalShotTextDraftPut}|{method:'discard';input:LocalShotTextDraftDelete}|{method:'prepare';input:LocalShotTextPrepare}|{method:'execute'|'recover';input:LocalShotTextExecute};
import type {LocalShotTextAccepted} from '../apps/web/src/local-shot-text-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '@mioon/contracts';
import { LOCAL_SHOT_TEXT_LIMITS } from '@mioon/contracts/local-shot-text';
import { createLocalShotTextController, createLocalShotTextRetention, mergeFreshShotTextAck } from '../apps/web/src/local-shot-text-state.ts';
import { createLocalShotTextClient, LocalShotTextRequestError, localShotTextFailure } from '../apps/web/src/local-shot-text-client.ts';

const id = (n: number) => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), shotId = id(2), stamp = '2026-10-12T00:00:00.000Z', baseText = { title: 'Saved title', prompt: 'Saved prompt' };
const valid = (value: unknown) => schemas['shot.update'].safeParse(value).success;
const copy = <T>(value: T) => structuredClone(value);
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = (done as (value?: T | PromiseLike<T>) => void); }); return { promise, resolve }; };
const empty = ():LocalShotTextSupported => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: id(3), projectId, shotId, draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset', projectPendingIntent: null });
const storedDraft = (raw = { title: 'Draft title', prompt: '' }, patch = {}) => ({ ...empty(), draftRevision: 1, draft: { draftId: id(4), baseRevision: 4, baseText, raw, updatedAt: stamp, ...patch }, draftTargetStatus: 'matching' });
function receipt(intent: LocalShotTextResponseTarget) { return { id: shotId, projectId, revision: intent.baseRevision + 1, ...intent.baseText, ...intent.input.patch, duration: 7, aspectRatio: '16:9', parameters: { seed: 42 }, referenceAssetIds: [] }; }
const until = async (predicate: { (): boolean; (): boolean; (): boolean; (): unknown; }) => { for (let i = 0; i < 40 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate()); };
function fixture(t: test.TestContext, options: {context?:Partial<LocalShotTextContext>;stored?:unknown;retention?:ReturnType<typeof createLocalShotTextRetention>;acknowledge?:boolean} = {}) {
  let context:LocalShotTextContext = { scope: 'project:1', projectId, shotId, revision: 4, baseRevision: 4, baseText, savedText: baseText, restored: false, connected: true, visible: true, busy: false,
    raw: copy(baseText), textVersion: 1, formSerial: 0, textDirty: false, formDirty: false, executionEpoch: 'owner-action', ...options.context };
  let stored = copy(options.stored ?? empty()) as LocalShotTextSupported, nextId = 100;
  const calls: TextCall[] = [], accepted: (LocalShotTextAccepted)[] = [], overrides:TextOverrides = {};
  const client = {
    async get(project: string, shot: string) { calls.push({ method: 'get', projectId: project, shotId: shot }); return overrides.get ? overrides.get(project, shot) : copy(stored); },
    async put(input: LocalShotTextDraftPut) {
      calls.push({ method: 'put', input: copy(input) }); if (overrides.put) return overrides.put(input);
      const expected = { draftId: input.draftId, baseRevision: input.baseRevision, baseText: copy(input.baseText), raw: copy(input.raw), updatedAt: stamp };
      if (stored.draftRevision === input.expectedDraftRevision + 1 && JSON.stringify(stored.draft) === JSON.stringify(expected)) return copy(stored);
      if (stored.draftRevision !== input.expectedDraftRevision || stored.draft && (stored.draft.draftId !== input.draftId || stored.draft.baseRevision !== input.baseRevision || JSON.stringify(stored.draft.baseText) !== JSON.stringify(input.baseText))) throw new LocalShotTextRequestError('conflict', 'LOCAL_SHOT_TEXT_CONFLICT', 409);
      stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: expected, draftTargetStatus: input.baseRevision === context.revision ? 'matching' : 'changed' }; return copy(stored);
    },
    async discard(input: LocalShotTextDraftDelete) { calls.push({ method: 'discard', input: copy(input) }); if (overrides.discard) return overrides.discard(input); stored = { ...stored, draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' }; return copy(stored); },
    async prepare(input: LocalShotTextPrepare) { calls.push({ method: 'prepare', input: copy(input) }); if (overrides.prepare) return overrides.prepare(input); return prepare(input); },
    async execute(input: LocalShotTextExecute) { calls.push({ method: 'execute', input: copy(input) }); return overrides.execute ? overrides.execute(input) : settle(); },
    async recover(input: LocalShotTextExecute) { calls.push({ method: 'recover', input: copy(input) }); return overrides.recover ? overrides.recover(input) : settle(); },
  };
  function prepare(input: LocalShotTextPrepare) { stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { intentId: input.intentId, baseRevision: input.baseRevision, baseText: copy(input.baseText), draft: copy(input.draft), input: copy(input.input), createdAt: stamp, outcome: { status: 'pending' } }, intentTargetStatus: 'matching', projectPendingIntent: { shotId, intentId: input.intentId } }; return copy(stored); }
  function settle() { const response = receipt(stored.intent!); stored = { ...stored, intentRevision: stored.intentRevision + 1, intent: { ...stored.intent!, outcome: { status: 'applied', shotRevision: response.revision, responseSha256: 'd'.repeat(64), resolvedAt: stamp } }, projectPendingIntent: null,
    ...(stored.draft && stored.draftRevision === stored.intent!.draft.revision && JSON.stringify(stored.draft.raw) === JSON.stringify(stored.intent!.draft.raw) ? { draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset' } : {}) }; return { envelope: copy(stored), response }; }
  const controller = createLocalShotTextController({ context, getContext: () => context, retention: options.retention, client:client as unknown as LocalShotTextClient, isShotUpdateInput: valid, delay: 60000, createId: () => id(nextId++),
    onRestore(draft, token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, raw: copy(draft.raw), baseRevision: draft.baseRevision, baseText: copy(draft.baseText), textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; return true; },
    onRebase(token) { if (context.formSerial !== token.formSerial) return false; context = { ...context, baseRevision: context.revision, baseText: copy(context.savedText) }; return true; },
    onAccepted(value) { accepted.push(value); return options.acknowledge !== false; } });
  t.after(() => controller.dispose());
  return { controller, calls, accepted, overrides, client, prepare, settle, state: () => controller.getState(), context: () => copy(context), stored: () => copy(stored), write(value: unknown) { stored = copy(value) as LocalShotTextSupported; },
    set(patch: Partial<LocalShotTextContext>, notify = true) { context = { ...context, ...patch }; if (notify) controller.setContext(context); },
    edit(patch: { title?: string; prompt?: string; }) { context = { ...context, raw: { ...context.raw, ...patch }, textVersion: context.textVersion + 1, formSerial: context.formSerial + 1, textDirty: true, formDirty: true }; controller.setContext(context); } };
}

test('passive mount, hydration, read and reconnect never create writes or restore text', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load();
  assert.deepEqual(f.state().raw, baseText); assert.equal(f.state().candidate!.raw.prompt, ''); assert.deepEqual(f.calls.map(c => c.method), ['get']);
  f.set({ raw: { title: 'Refreshed', prompt: '' }, savedText: { title: 'Refreshed', prompt: '' }, baseText: { title: 'Refreshed', prompt: '' }, revision: 5, baseRevision: 5 });
  assert.equal(f.state().dirty, false); f.set({ visible: false, connected: false }); f.set({ visible: true, connected: true });
  assert.deepEqual(f.calls.map(c => c.method), ['get']);
});

test('user empty prompt and invalid blank title remain exact recoverable raw input', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: '', prompt: '' }); assert.equal(await f.controller.flush(), true);
  assert.deepEqual(f.stored().draft!.raw, { title: '', prompt: '' }); assert.equal(await f.controller.submit(), null); assert.equal(f.calls.some(c => c.method === 'prepare'), false);
  f.edit({ title: 'Valid' }); assert.ok(await f.controller.submit()); assert.deepEqual(f.accepted[0].intent.input.patch, { title: 'Valid', prompt: '' });
});

test('restoration preserves original revision and exact original text rather than today baseline', async t => {
  const f = fixture(t, { stored: storedDraft({ title: 'Raw', prompt: '' }, { baseRevision: 2 }) }); await f.controller.load();
  const old = f.controller.capture(); f.set({ formSerial: 1, formDirty: true }); assert.equal(f.controller.restore(old), false);
  assert.equal(f.controller.restore(), true); assert.equal(f.state().baseline!.baseRevision, 2); assert.deepEqual(f.state().baseline!.baseText, baseText); assert.equal(f.state().baselineConflict, true); assert.equal(f.controller.canPrepare(), false);
});

test('raw guard preserves maximum Unicode and controls without truncation or forged local evidence', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: '汉'.repeat(150), prompt: '\0'.repeat(5000) }); assert.equal(await f.controller.flush(), true); assert.equal(f.stored().draft!.raw.prompt.length, 5000);
  f.edit({ prompt: 'x'.repeat(LOCAL_SHOT_TEXT_LIMITS.rawPromptUnits + 1) }); const before = f.calls.length; assert.equal(await f.controller.flush(), false); assert.equal(f.calls.length, before); assert.equal(f.state().draftFailure!.code, 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION');
});

test('full form capture fences same-tick nontext edits independently of text serial', async t => {
  const f = fixture(t); await f.controller.load(); const capture = f.controller.capture(); f.set({ formSerial: 1, formDirty: true }, false);
  assert.equal(f.controller.isCurrent(capture), false); assert.equal(f.controller.hasUnsaved(), true); assert.equal(f.controller.blocksLegacy(), false);
});

test('loaded selected target required for legacy admission; restored fallback remains available', async t => {
  const f = fixture(t); assert.equal(f.controller.blocksLegacy(shotId), true); await f.controller.load(); assert.equal(f.controller.blocksLegacy(shotId), false); assert.equal(f.controller.blocksLegacy(id(20)), true);
  const restored = fixture(t, { context: { restored: true } }); await restored.controller.load(); assert.equal(restored.controller.blocksLegacy(shotId), false); assert.equal(restored.calls.length, 0);
});

test('fresh submit durably saves raw then prepares immutable text-only intent before execute', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'New' }); assert.ok(await f.controller.submit());
  assert.deepEqual(f.calls.map(c => c.method), ['get', 'put', 'prepare', 'execute']); const input = f.accepted[0].intent.input;
  assert.deepEqual(input.patch, { title: 'New' }); assert.deepEqual(Object.keys(input).sort(), ['expectedRevision', 'patch', 'requestId', 'shotId']); assert.equal(f.state().pending, false); assert.equal(f.state().dirty, false);
});

test('legacy mutation/ref busy blocks text handlers even without a rerender', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'New' }); f.set({ busy: true }, false);
  assert.equal(await f.controller.submit(), null); assert.equal(await f.controller.recover(), null); assert.equal(f.calls.some(c => c.method === 'prepare'), false);
});

test('full form serial, current revision, action epoch, visibility and busy each fence late prepare', async t => {
  for (const patch of [{ formSerial: 20 }, { revision: 5 }, { executionEpoch: 'new action' }, { visible: false }, { busy: true }]) {
    const f = fixture(t); await f.controller.load(); f.edit({ title: 'New' }); const gate = deferred(); f.overrides.prepare = (input: LocalShotTextPrepare) => gate.promise.then(() => f.prepare(input));
    const work = f.controller.submit(); await until(() => f.calls.some(c => c.method === 'prepare')); f.set(patch, false); gate.resolve!(); await work;
    assert.equal(f.calls.some(c => c.method === 'execute'), false); assert.equal(f.state().pending, true);
  }
});

test('late text ACK preserves newer typing and never acknowledges current form', async t => {
  const f = fixture(t, { acknowledge: false }); await f.controller.load(); f.edit({ title: 'Submitted' }); const gate = deferred(); f.overrides.execute = () => gate.promise;
  const work = f.controller.submit(); await until(() => f.calls.some(c => c.method === 'execute')); f.edit({ title: 'Newer typing' }); gate.resolve!(f.settle()); await work;
  assert.equal(f.state().raw.title, 'Newer typing'); assert.equal(f.state().dirty, true); assert.equal(f.state().baseline!.baseRevision, 4);
});

test('fresh text merge preserves all unrelated draft values and nontext dirty state', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Changed', prompt: '' }); const capture = f.controller.capture();
  const baseline:ShotTextForm = { ...baseText, duration: 7, aspectRatio: '16:9', referenceAssetIds: [id(50)], lastFrameAssetId: null, parameters: { seed: 42 } };
  const draft:ShotTextForm = { ...baseline, ...f.context().raw, duration: 9, parameters: { seed: 84 }, referenceAssetIds: [], lastFrameAssetId: id(51) };
  const intent = { baseRevision: 4, baseText, input: { requestId: 'request-original', shotId, expectedRevision: 4, patch: { title: 'Changed', prompt: '' } } }, response = receipt(intent);
  const result = { response, intent, capture, recovered: false } as unknown as LocalShotTextAccepted;
  const merged = mergeFreshShotTextAck({ result, current: f.context(), draft, baseline, currentCapture: true, visible: true, busy: false });
  assert.deepEqual(merged!.draft, draft); assert.equal(merged!.baseRevision, 5); assert.equal(merged!.dirty, true); assert.deepEqual(merged!.baseline.parameters, { seed: 42 });
  for (const changed of [{ formSerial: 40 }, { baseRevision: 3 }, { revision: 6 }, { executionEpoch: 'other' }]) assert.equal(mergeFreshShotTextAck({ result, current: { ...f.context(), ...changed }, draft, baseline, currentCapture: true, visible: true, busy: false }), null);
  assert.equal(mergeFreshShotTextAck({ result: { ...result, recovered: true }, current: f.context(), draft, baseline, currentCapture: true, visible: true, busy: false }), null);
  assert.equal(mergeFreshShotTextAck({ result, current: f.context(), draft, baseline, currentCapture: true, visible: true, busy: true }), null);
});

test('duration edit during text execution requires explicit current-text acceptance without another no-op request', async t => {
  const f = fixture(t, { acknowledge: false }); await f.controller.load(); f.edit({ title: 'Saved text' }); const gate = deferred(); f.overrides.execute = () => gate.promise;
  const work = f.controller.submit(); await until(() => f.calls.some(c => c.method === 'execute')); f.set({ formSerial: f.context().formSerial + 1 }); const settled = f.settle(); gate.resolve!(settled); await work;
  f.set({ revision: 5, savedText: { title: 'Saved text', prompt: baseText.prompt } }); const before = f.calls.length;
  assert.equal(await f.controller.keepCurrent(), true); assert.equal(f.state().dirty, false); assert.equal(f.controller.blocksLegacy(), false); assert.equal(f.context().formDirty, true); assert.equal(f.calls.length, before);
});

test('unknown PUT survives empty reread and exact retry uses fresh nonce, original raw and CAS', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Original' }); f.overrides.put = () => { throw Error('lost'); }; await f.controller.flush(); const original = f.calls.find(c => c.method === 'put')!.input;
  f.edit({ title: 'Newer' }); f.write({ ...empty(), instanceId: id(88) }); await f.controller.load(); assert.equal(f.state().draftFailure!.kind, 'unknown'); assert.equal(f.controller.canPrepare(), false); assert.equal(f.controller.allowLeaveWithoutSaving(), false);
  delete f.overrides.put; assert.equal(await f.controller.retryDraftSave(), false); const retried = f.calls.filter(c => c.method === 'put')[1].input;
  assert.deepEqual(retried, { ...original, instanceId: id(88) }); assert.equal(f.state().raw.title, 'Newer'); assert.equal(f.state().autosavePaused, true); assert.equal(f.state().draftRetry, 'current');
});

test('known refusal permits explicit leave but never unlocks a separate legacy busy state', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Current' }); f.overrides.put = () => { throw new LocalShotTextRequestError('full', 'LOCAL_SHOT_TEXT_CAPACITY', 507); };
  await f.controller.flush(); assert.equal(f.state().draftFailure!.kind, 'refused'); assert.equal(f.controller.allowLeaveWithoutSaving(), true); f.set({ busy: true }); assert.equal(f.controller.canPrepare(), false);
});

test('unknown preparation never dispatches and empty reread cannot revoke original identity', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Original' }); f.overrides.prepare = () => { throw Error('lost prepare'); }; await f.controller.submit(); const original = f.calls.find(c => c.method === 'prepare')!.input;
  await f.controller.load(); assert.equal(f.state().pending, true); assert.equal(f.calls.some(c => c.method === 'execute'), false); assert.equal(f.state().retainedPreparation!.intentId, original!.intentId);
  f.edit({ title: 'Current' }); delete f.overrides.prepare; assert.ok(await f.controller.recover());
  assert.deepEqual(f.calls.filter(c => c.method === 'prepare')[1].input, original); assert.equal(f.calls.some(c => c.method === 'execute'), false); assert.equal(f.state().raw.title, 'Current'); assert.equal(f.state().dirty, true); assert.equal(f.accepted[0].recovered, true);
});

test('passive terminal reveal cannot resurrect same identity or substitute frozen input at higher revision', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'One' }); await f.controller.submit(); const accepted = f.stored();
  f.write({ ...accepted, intentRevision: accepted.intentRevision + 1, intent: { ...accepted.intent, outcome: { status: 'pending' } }, projectPendingIntent: { shotId, intentId: accepted.intent!.intentId } }); await f.controller.load(); assert.equal(f.state().intent!.outcome.status, 'applied'); assert.equal(f.state().phase, 'error');
});

test('malformed response, wrong unchanged prompt and wrong revision remain pending', async t => {
  for (const patch of [{ prompt: 'Another prompt' }, { revision: 88 }, { projectId: id(30) }]) {
    const f = fixture(t); await f.controller.load(); f.edit({ title: 'One' }); f.overrides.execute = () => { const settled = f.settle(); settled.response = { ...settled.response, ...patch }; return settled; };
    assert.equal(await f.controller.submit(), null); assert.equal(f.state().pending, true); assert.equal(f.state().dirty, true); assert.equal(f.accepted.length, 0);
  }
});

test('unknown PUT and preparation survive actual controller disposal/remount with session retention', async t => {
  for (const method of ['put', 'prepare'] as const) {
    const retention = createLocalShotTextRetention(), first = fixture(t, { retention }); await first.controller.load(); first.edit({ title: 'Original' }); first.overrides[method] = () => { throw Error('lost'); };
    if (method === 'put') await first.controller.flush(); else await first.controller.submit(); const saved = first.stored(); first.controller.dispose();
    const second = fixture(t, { retention, stored: saved }); await second.controller.load(); assert.equal(second.controller.blocksLegacy(), true);
    assert.ok(method === 'put' ? second.state().retainedDraftWrite : second.state().retainedPreparation); assert.deepEqual(second.calls.map(c => c.method), ['get']);
  }
});

test('ambiguous DELETE survives remount; null unchanged GET cannot settle; explicit newer authoritative state preserves candidate', async t => {
  const retention = createLocalShotTextRetention(), first = fixture(t, { retention, stored: storedDraft() }); await first.controller.load(); first.overrides.discard = () => { throw Error('lost deletion'); };
  await first.controller.discardStored(); const deletion = first.state().retainedDeletion; assert.ok(deletion); first.controller.dispose();
  const second = fixture(t, { retention, stored: { ...empty(), draftRevision: 1 } }); await second.controller.load(); assert.equal(second.controller.blocksLegacy(), true); assert.equal(await second.controller.acceptCurrentAfterDeletion(), false); assert.ok(second.state().retainedDeletion);
  const newer = { ...storedDraft({ title: 'Another window', prompt: '' }), draftRevision: 3 }; second.write(newer);
  assert.equal(await second.controller.acceptCurrentAfterDeletion(), true); assert.equal(second.state().retainedDeletion, null); assert.equal(second.state().candidate!.raw.title, 'Another window'); assert.equal(second.state().autosavePaused, true); assert.equal(second.calls.some(c => c.method === 'put'), false);
});

test('other-shot project pending is visible and blocks fresh submission without hidden dispatch', async t => {
  const f = fixture(t, { stored: { ...empty(), projectPendingIntent: { shotId: id(70), intentId: id(71) } } }); await f.controller.load(); f.edit({ title: 'One' });
  assert.equal(f.controller.canPrepare(), false); assert.equal(f.controller.blocksLegacy(), true); assert.equal(await f.controller.recover(), null); assert.equal(f.calls.some(c => ['prepare', 'execute', 'recover'].includes(c.method)), false);
});

test('hidden view cannot restore or initiate persistence, business save or recovery', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load(); f.edit({ title: 'One' }); f.set({ visible: false });
  const count = f.calls.length; assert.equal(f.controller.restore(), false); assert.equal(await f.controller.flush(), false); assert.equal(await f.controller.submit(), null); assert.equal(await f.controller.recover(), null); assert.equal(f.calls.length, count);
});

test('two local controllers cannot overwrite another window draft CAS', async t => {
  const one = fixture(t), two = fixture(t); await one.controller.load(); await two.controller.load(); one.edit({ title: 'First window' }); await one.controller.flush();
  two.edit({ title: 'Second window' }); two.overrides.put = (input: LocalShotTextDraftPut) => one.client.put(input); assert.equal(await two.controller.flush(), false); assert.equal(two.state().draftFailure!.kind, 'conflict'); assert.equal(one.stored().draft!.raw.title, 'First window');
});

test('fixed scoped client endpoints, exact refusal codes, bounded timeout and malformed protocol', async () => {
  const calls: { url: URL|RequestInfo; init: RequestInit|undefined; }[] = [], client = createLocalShotTextClient({ isShotUpdateInput: valid, fetcher: (async (url: string, init: RequestInit | undefined) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: empty() }), { status: 200 }); }) as unknown as typeof fetch });
  await client.get(projectId, shotId); assert.equal(calls[0].url, `/api/local-shot-text?projectId=${projectId}&shotId=${shotId}`); assert.equal(calls[0].init!.credentials, 'same-origin'); assert.equal(calls[0].init!.cache, 'no-store');
  assert.equal(localShotTextFailure(new LocalShotTextRequestError('full', 'LOCAL_SHOT_TEXT_CAPACITY', 507)).kind, 'refused'); assert.equal(localShotTextFailure(new LocalShotTextRequestError('full', 'LOCAL_SHOT_TEXT_CAPACITY', 500)).kind, 'unknown');
  const timeout = createLocalShotTextClient({ isShotUpdateInput: valid, timeoutMs: 5, fetcher: (() => new Promise(() => {})) as unknown as typeof fetch }); await assert.rejects(timeout.get(projectId, shotId), { code: 'LOCAL_SHOT_TEXT_TIMEOUT_UNKNOWN' });
  const malformed = createLocalShotTextClient({ isShotUpdateInput: valid, fetcher: (async () => new Response(JSON.stringify({ ok: true, data: empty(), extra: true }), { status: 200 })) as unknown as typeof fetch }); await assert.rejects(malformed.get(projectId, shotId), { code: 'LOCAL_SHOT_TEXT_PROTOCOL_UNKNOWN' });
  for (const code of ['LOCAL_SHOT_TEXT_LOCAL_VALIDATION', 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT']) {
    const forged = createLocalShotTextClient({ isShotUpdateInput: valid, fetcher: (async () => new Response(JSON.stringify({ ok: false, error: { code, message: 'forged', details: {}, retryable: false } }), { status: 400 })) as unknown as typeof fetch }); await assert.rejects(forged.get(projectId, shotId), { code: 'LOCAL_SHOT_TEXT_PROTOCOL_UNKNOWN' });
  }
});

test('accepted navigation releases only abandoned local input synchronously, retaining request uncertainty', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Leave local input' }); await f.controller.flush(); const capture = f.controller.capture();
  assert.equal(f.controller.abandonCurrentInput(capture), true); assert.equal(f.controller.blocksLegacy(), false); assert.equal(f.controller.hasUnsaved(), false);
  const pending = fixture(t); await pending.controller.load(); pending.edit({ title: 'Pending original' }); pending.overrides.prepare = () => { throw Error('unknown'); }; await pending.controller.submit();
  assert.equal(pending.controller.abandonCurrentInput(), true); assert.equal(pending.controller.blocksLegacy(), true); assert.ok(pending.state().retainedPreparation);
});

test('unknown DELETE with unchanged original draft can explicitly retry exact original CAS using fresh nonce', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load(); f.overrides.discard = () => { throw Error('never reached service'); };
  await f.controller.discardStored(); const original = f.state().retainedDeletion; f.write({ ...f.stored(), instanceId: id(88) });
  delete f.overrides.discard; assert.equal(await f.controller.retryDraftDeletion(), true); assert.deepEqual(f.calls.filter(c => c.method === 'discard')[1].input, { ...original, instanceId: id(88) });
  assert.equal(f.state().retainedDeletion, null); assert.equal(f.state().autosavePaused, true); assert.equal(f.calls.some(c => c.method === 'put'), false);
});

test('a refused exact DELETE retry cannot disprove original deletion uncertainty', async t => {
  const f = fixture(t, { stored: storedDraft() }); await f.controller.load(); f.overrides.discard = () => { throw Error('lost'); }; await f.controller.discardStored();
  f.overrides.discard = () => { throw new LocalShotTextRequestError('not found', 'LOCAL_SHOT_TEXT_NOT_FOUND', 404); }; assert.equal(await f.controller.retryDraftDeletion(), false);
  assert.ok(f.state().retainedDeletion); assert.equal(f.state().draftFailure!.kind, 'unknown'); assert.equal(f.controller.blocksLegacy(), true);
});

test('session retention reveals private raw only after matching verified workspace authority', async t => {
  for (const method of ['put', 'prepare'] as const) {
    const retention = createLocalShotTextRetention(), first = fixture(t, { retention }); await first.controller.load(); first.edit({ title: 'Private title', prompt: 'PRIVATE RECOVERY TEXT' }); first.overrides[method] = () => { throw Error('lost'); };
    if (method === 'put') await first.controller.flush(); else await first.controller.submit(); first.controller.dispose();
    for (const options of [{}, { context: { restored: true } }]) {
      const other = fixture(t, { retention, ...options, stored: { ...empty(), workspaceScope: 'b'.repeat(64) } });
      assert.equal(JSON.stringify(other.state()).includes('PRIVATE RECOVERY TEXT'), false); await other.controller.load(); assert.equal(JSON.stringify(other.state()).includes('PRIVATE RECOVERY TEXT'), false); assert.equal(other.calls.some(c => c.method !== 'get'), false);
    }
    const refused = fixture(t, { retention }); refused.overrides.get = () => { throw new LocalShotTextRequestError('denied', 'LOCAL_SHOT_TEXT_OWNER_REQUIRED', 403); }; await refused.controller.load(); assert.equal(JSON.stringify(refused.state()).includes('PRIVATE RECOVERY TEXT'), false);
    const original = fixture(t, { retention, stored: first.stored() }); assert.equal(JSON.stringify(original.state()).includes('PRIVATE RECOVERY TEXT'), false); await original.controller.load(); assert.equal(JSON.stringify(original.state()).includes('PRIVATE RECOVERY TEXT'), true); assert.equal(original.controller.blocksLegacy(), true);
  }
});

test('an authoritative unsupported response detaches previously displayed recovery payloads without deleting retention', async t => {
  const f = fixture(t); await f.controller.load(); f.edit({ title: 'Private retained title', prompt: 'Private retained prompt' }); f.overrides.put = () => { throw Error('lost'); }; await f.controller.flush();
  assert.ok(f.state().retainedDraftWrite); f.overrides.get = () => ({ supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED' }); await f.controller.load();
  assert.equal(f.state().phase, 'unsupported'); assert.equal(f.state().retainedDraftWrite, null); assert.equal(f.state().retainedPreparation, null); assert.equal(f.state().retainedDeletion, null); assert.equal(f.state().intent, null); assert.equal(f.state().candidate, null);
  delete f.overrides.get; await f.controller.load(); assert.ok(f.state().retainedDraftWrite); assert.equal(f.state().retainedDraftWrite!.raw.title, 'Private retained title');
});
