import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import type {ProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import {createProjectMediaController} from '../apps/web/src/project-media-state.ts';
import type {ProjectMediaAsset, ProjectMediaOwner} from '../apps/web/src/project-media-state.ts';
import {createProjectMediaClient, ProjectMediaError} from '../apps/web/src/project-media-client.ts';
import {createNativeAssetMediaBridge} from '../apps/desktop/src/asset-relink-preload.ts';
import {nativeRelinkPreviewSchema, NATIVE_ASSET_MEDIA_CHANNEL, NATIVE_ASSET_MEDIA_LIMITS} from '../packages/contracts/src/asset-media-native.ts';
import type {NativeRelinkPreview, NativeRelinkApplyResult} from '../packages/contracts/src/asset-media-native.ts';
import type {AssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';

const id = (n: number) => `78000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(900), hash = 'a'.repeat(64);
const owner = (): ProjectMediaOwner => ({appLibraryScope: hash, instanceId: id(901), projectId, epoch: 1, session: 'native-editor'});
const asset = (n = 1, revision = 1): ProjectMediaAsset => ({id: id(n), projectId, name: `${n}.png`, mimeType: 'image/png', referenceRevision: revision});
const dto = (n = 1, revision = 2): AssetMediaDto => ({...asset(n, revision), mimeType: 'image/png', sizeBytes: 1, sha256: hash, fingerprint: {sizeBytes: 1, mtimeMs: 1, sampledSha256: hash, fullSha256: hash}, hashState: 'full', url: projectMediaPath(projectId, id(n))});
const preview = (token = id(800)): NativeRelinkPreview => nativeRelinkPreviewSchema.parse({projectId, assetId: id(1), expectedReferenceRevision: 1, previewToken: token, displayPath: '/moved/1.png', outside: true,
  rows: [{assetId: id(1), name: 'Picked', from: '/old/1.png', to: '/moved/1.png', outcome: 'picked', referenceRevision: 1},
    {assetId: id(2), name: 'Automatic', from: '/old/2.png', to: '/moved/2.png', outcome: 'auto', referenceRevision: 1},
    {assetId: id(3), name: 'Different candidate', from: '/old/3.png', to: '/moved/3.png', outcome: 'changed', referenceRevision: 1},
    {assetId: id(4), name: 'Missing', from: '/old/4.png', to: null, outcome: 'missing', referenceRevision: 1}], foundBy: {name: '1.png', count: 1}});
const success = (): NativeRelinkApplyResult => ({status: 'applied', assets: [dto(1), dto(2)], confirmedDirectories: ['/moved']});
function deferred<T>() {let resolve!: (value: T) => void; return {promise: new Promise<T>(yes => {resolve = yes;}), resolve: (value: T) => resolve(value)};}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(patch: Partial<ProjectMediaNativeClient> = {}) {
  let current: ProjectMediaOwner | null = owner(), values = [asset(1), asset(2), asset(3), asset(4)], clock = 1000;
  const calls: Array<{kind: string; input: unknown}> = [], published: unknown[] = [], applied: ProjectMediaOwner[] = [];
  const native: ProjectMediaNativeClient = {
    choose: async input => {calls.push({kind: 'choose', input}); return preview();},
    apply: async input => {calls.push({kind: 'native-apply', input}); return success();},
    discard: async input => {calls.push({kind: 'discard', input});}, ...patch,
  };
  const client = {...createProjectMediaClient(),
    status: async () => ({items: values.map(value => ({assetId: value.id, referenceRevision: value.referenceRevision, fingerprintToken: hash, status: 'missing' as const, reason: 'not-found' as const, outside: true, readable: false})), nextCursor: null}),
    locations: async () => ({assets: values.map(value => ({assetId: value.id, displayPath: `/old/${value.name}`, pathForm: 'relative' as const, volume: null, outside: false})), locations: [], nextCursor: null}),
    rules: async () => ({projectId, file: 'AGENTS.md' as const, exists: false, text: '', hash: null, trust: 'absent' as const, maxBytes: 8192 as const, readError: null, pendingWrites: false}),
    apply: async (input: unknown) => {calls.push({kind: 'http-apply', input}); return {assets: [dto()]};},
    acceptChanged: async (input: unknown) => {calls.push({kind: 'accept-changed', input}); return {asset: dto(10, 1), replacesAssetId: id(3)};},
    confirm: async (input: unknown) => {calls.push({kind: 'confirm', input}); return {confirmedDirectories: ['/moved'], revokedDirectories: []};},
  };
  let sequence = 0;
  const controller = createProjectMediaController({client, nativeRelink: native, readOwner: () => current, readAssets: () => values,
    onChange: value => published.push(value), onApplied: value => {applied.push(value);}, now: () => clock, newRequestId: () => `native-original-request-${++sequence}`});
  controller.activate(); controller.update(current);
  return {controller, calls, published, applied, setOwner(value: ProjectMediaOwner | null) {current = value;}, setAssets(value: ProjectMediaAsset[]) {values = value;}, advance(ms: number) {clock += ms;}, get owner() {return current;}};
}

test('native reader uses only the real preload actions and strict DTOs without path or consent inputs', async () => {
  assert.equal(readProjectMediaNativeClient({}), null);
  assert.throws(() => readProjectMediaNativeClient({__mioonAssetMediaNative: {choose() {}}}), {code: 'ASSET_RELINK_PROTOCOL'});
  const calls: unknown[] = [];
  const bridge = createNativeAssetMediaBridge(async (channel, input) => {assert.equal(channel, NATIVE_ASSET_MEDIA_CHANNEL); calls.push(input); return {ok: true, data: (input as {action: string}).action === 'choose' ? preview() : (input as {action: string}).action === 'apply' ? success() : true};});
  const client = readProjectMediaNativeClient({__mioonAssetMediaNative: bridge})!;
  assert.deepEqual(await client.choose({projectId, assetId: id(1), expectedReferenceRevision: 1}), preview());
  assert.deepEqual(await client.apply({projectId, previewToken: id(800), requestId: 'original-request'}), success());
  await client.discard({projectId, previewToken: id(800)});
  assert.deepEqual(calls, [{action: 'choose', projectId, assetId: id(1), expectedReferenceRevision: 1}, {action: 'apply', projectId, previewToken: id(800), requestId: 'original-request'}, {action: 'discard', projectId, previewToken: id(800)}]);
  await assert.rejects(client.choose({projectId, assetId: id(1), expectedReferenceRevision: 1, sourcePath: '/forbidden.png'} as never), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.apply({projectId, previewToken: id(800), requestId: 'original-request', ownerToken: id(999)} as never), {code: 'VALIDATION_ERROR'});
  assert.equal(calls.length, 3);
});

test('native reader aborts without dispatch and cleans an ignored-signal late picker preview only', async () => {
  const late = deferred<NativeRelinkPreview | null>(), calls: unknown[] = [], abort = new AbortController();
  const client = readProjectMediaNativeClient({__mioonAssetMediaNative: {choose: async (input: unknown) => {calls.push(input); return late.promise;}, apply: async () => {assert.fail('no apply');}, discard: async (input: unknown) => {calls.push(input);}}})!;
  abort.abort(); await assert.rejects(client.choose({projectId, assetId: id(1), expectedReferenceRevision: 1}, {signal: abort.signal}), {code: 'INTERRUPTED'}); assert.equal(calls.length, 0);
  const stop = new AbortController(), pending = client.choose({projectId, assetId: id(1), expectedReferenceRevision: 1}, {signal: stop.signal});
  stop.abort(); await assert.rejects(pending, {code: 'INTERRUPTED'}); late.resolve(preview()); await turn();
  assert.deepEqual(calls, [{projectId, assetId: id(1), expectedReferenceRevision: 1}, {projectId, previewToken: id(800)}]);
});

test('native reader validates scope, limits and acknowledgements; dispatched interruption remains unknown', async () => {
  for (const value of [{...preview(), projectId: id(999)}, {...preview(), unexpectedPath: '/private'}, {...preview(), rows: Array.from({length: 101}, () => preview().rows[0])}]) {
    const client = readProjectMediaNativeClient({__mioonAssetMediaNative: {choose: async () => value, apply: async () => success(), discard: async () => {}}})!;
    await assert.rejects(client.choose({projectId, assetId: id(1), expectedReferenceRevision: 1}), {code: 'ASSET_RELINK_PROTOCOL'});
  }
  const late = deferred<NativeRelinkApplyResult>(), stop = new AbortController();
  const client = readProjectMediaNativeClient({__mioonAssetMediaNative: {choose: async () => null, apply: async () => late.promise, discard: async () => {}}})!;
  const pending = client.apply({projectId, previewToken: id(800), requestId: 'original-request'}, {signal: stop.signal}); stop.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ProjectMediaError && error.code === 'INTERRUPTED' && error.outcomeUnknown);
  late.resolve(success()); await turn();
});

test('native validated rows remain native; choosing and canceling never applies, imports or grants', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
  const state = f.controller.getState(); assert.equal(state.relink.kind, 'ready');
  if (state.relink.kind === 'ready') {assert.deepEqual(state.relink.value.rows.map(row => row.outcome), ['picked', 'auto', 'changed', 'missing']); assert.equal(state.relink.value.rows[2]!.to, '/moved/3.png'); assert.deepEqual(state.relink.value.foundBy, {name: '1.png', count: 1});}
  assert.equal(state.canApply, true); assert.deepEqual(state.nativeConfirmedDirectories, []); assert.equal(f.controller.canRead(asset()), false);
  f.controller.toggleChanged(id(3)); assert.deepEqual(f.controller.getState().changedSelected, []); f.controller.cancelRelink(); await turn();
  assert.equal(f.controller.getState().relinkOpen, false); assert.deepEqual(f.calls.map(value => value.kind), ['choose', 'discard']); assert.equal(await f.controller.apply(), false); f.controller.dispose();
});

test('picker cancellation and a mismatched candidate cannot borrow HTTP acceptChanged authority', async () => {
  for (const result of [null, {...preview(), rows: preview().rows.map(row => row.assetId === id(1) ? {...row, outcome: 'changed' as const} : row)}]) {
    const f = fixture({choose: async () => result}); await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1)); f.controller.toggleChanged(id(1));
    assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); assert.equal(f.calls.some(value => ['http-apply', 'accept-changed', 'native-apply', 'confirm'].includes(value.kind)), false); f.controller.dispose();
  }
});

test('native apply retains the original token and verifies full hashes/revisions without changing old references', async () => {
  const f = fixture(), timeline = {clips: [{assetId: id(1)}, {assetId: id(3)}]}, history = JSON.stringify(timeline); await f.controller.refresh(); await f.controller.choose(id(1));
  assert.equal(await f.controller.apply(), true); assert.deepEqual(f.calls.find(value => value.kind === 'native-apply')!.input, {projectId, previewToken: id(800), requestId: 'native-original-request-1'});
  assert.equal(f.applied.length, 1); assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, ['/moved']); assert.equal(f.controller.getState().newAdded, 0); assert.equal(JSON.stringify(timeline), history);
  assert.equal(f.calls.some(value => ['http-apply', 'accept-changed', 'confirm'].includes(value.kind)), false); f.controller.dispose();
});

test('native unknown locks choice and cancellation and only an explicit retry reuses the same original intent', async () => {
  const inputs: unknown[] = []; let count = 0;
  const f = fixture({apply: async input => {inputs.push(input); return ++count === 1 ? {status: 'failed', error: {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}, confirmedDirectories: ['/moved']} : success();}});
  await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false);
  const state = f.controller.getState(); assert.equal(state.nativeOutcomeUnknown, true); assert.equal(state.canChoose, false); assert.equal(state.canChangeSelection, false); assert.equal(state.canApply, true); assert.deepEqual(state.nativeConfirmedDirectories, ['/moved']);
  f.controller.cancelRelink(); await f.controller.choose(id(2)); f.controller.toggleChanged(id(3)); await f.controller.refresh(); await turn();
  assert.equal(f.controller.getState().relinkOpen, true); assert.equal(inputs.length, 1); assert.equal(f.calls.filter(value => value.kind === 'choose').length, 1);
  assert.equal(await f.controller.apply(), true); assert.deepEqual(inputs[0], inputs[1]); assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(inputs.length, 2); assert.equal(f.calls.some(value => value.kind === 'discard'), false); f.controller.dispose();
});

test('unknown original-intent retry survives observed committed revisions but never creates another identity', async () => {
  const inputs: unknown[] = []; let count = 0;
  const f = fixture({apply: async input => {inputs.push(input); if (++count === 1) throw new ProjectMediaError('ASSET_RELINK_UNAVAILABLE', {outcomeUnknown: true}); return success();}});
  await f.controller.refresh(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false);
  f.setAssets([asset(1, 2), asset(2, 2), asset(3), asset(4)]); f.controller.update(f.owner); await f.controller.refresh();
  assert.equal(await f.controller.apply(), true); assert.deepEqual(inputs[0], inputs[1]); assert.equal(f.applied.length, 1); assert.equal(f.controller.getState().newAdded, 0); f.controller.dispose();
});

test('definitive native failure preserves reported grant facts without pretending media was relinked', async () => {
  const f = fixture({apply: async () => ({status: 'failed', error: {code: 'REVISION_CONFLICT', status: 409}, confirmedDirectories: ['/moved']})});
  await f.controller.refresh(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false);
  assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, ['/moved']); assert.equal(f.applied.length, 0); assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().canApply, false); assert.equal(f.controller.canRead(asset()), false); f.controller.dispose();
});

test('unaccepted previews expire, reject stale revisions/new assets, and never reuse a retired token', async () => {
  for (const change of ['expiry', 'revision', 'new-asset']) {
    const f = fixture(); await f.controller.refresh(); await f.controller.choose(id(1));
    if (change === 'expiry') f.advance(NATIVE_ASSET_MEDIA_LIMITS.ticketMs);
    else f.setAssets(change === 'revision' ? [asset(1, 2), asset(2), asset(3), asset(4)] : [asset(1), asset(2), asset(3), asset(4), asset(5)]);
    assert.equal(await f.controller.apply(), false); assert.equal(f.calls.some(value => value.kind === 'native-apply'), false); await turn(); assert.equal(f.calls.filter(value => value.kind === 'discard').length, 1); f.controller.dispose();
  }
  const f = fixture(); await f.controller.refresh(); await f.controller.choose(id(1)); f.controller.cancelRelink(); await f.controller.choose(id(1));
  assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); assert.equal(f.calls.some(value => value.kind === 'native-apply'), false); f.controller.dispose();
});

test('all owner fields, lease loss, cancellation and revision changes discard held picker answers without publishing', async () => {
  for (const replacement of [{...owner(), appLibraryScope: 'b'.repeat(64)}, {...owner(), instanceId: id(902)}, {...owner(), projectId: id(903)}, {...owner(), epoch: 2}, {...owner(), session: 'new-session'}, null, 'revision', 'cancel', 'dispose'] as const) {
    const late = deferred<NativeRelinkPreview | null>(), f = fixture({choose: async () => late.promise}); await f.controller.refresh(); f.controller.openRelink(); const choosing = f.controller.choose(id(1)); await turn();
    if (replacement === 'revision') {f.setAssets([asset(1, 2), asset(2), asset(3), asset(4)]); f.controller.update(f.owner);}
    else if (replacement === 'cancel') f.controller.cancelRelink();
    else if (replacement === 'dispose') f.controller.dispose();
    else {f.setOwner(replacement); if (replacement !== null) f.controller.update(replacement);}
    const count = f.published.length; late.resolve(preview()); await choosing; await turn();
    assert.equal(f.controller.getState().canApply, false); assert.equal(f.applied.length, 0); assert.equal(f.published.length, count); assert.equal(f.calls.filter(value => value.kind === 'discard').length, 1); assert.equal(f.calls.some(value => value.kind === 'native-apply'), false); f.controller.dispose();
  }
});

test('a held native ACK cannot publish across owner/lease changes; revision changes remain unknown until original retry', async () => {
  for (const replacement of [null, {...owner(), epoch: 2}, {...owner(), instanceId: id(902)}, 'revision'] as const) {
    const late = deferred<NativeRelinkApplyResult>(), f = fixture({apply: async () => late.promise}); await f.controller.refresh(); await f.controller.choose(id(1)); const writing = f.controller.apply(); await turn();
    if (replacement === 'revision') {f.setAssets([asset(1, 2), asset(2, 2), asset(3), asset(4)]); f.controller.update(f.owner);}
    else {f.setOwner(replacement); if (replacement) f.controller.update(replacement);}
    late.resolve(success()); assert.equal(await writing, false); assert.equal(f.applied.length, 0);
    if (replacement === 'revision') assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
    f.controller.dispose();
  }
});

test('malformed native success never acknowledges duplicate, foreign, stale or sampled assets', async () => {
  for (const assets of [[dto(1), dto(1)], [dto(1), {...dto(2), projectId: id(999), url: projectMediaPath(id(999), id(2))}], [dto(1, 1), dto(2)], [{...dto(1), sha256: null, fingerprint: {...dto(1).fingerprint, fullSha256: null}, hashState: 'sampled' as const}, dto(2)]]) {
    const inputs: unknown[] = [], f = fixture({apply: async input => {inputs.push(input); return {status: 'applied', assets, confirmedDirectories: []};}});
    await f.controller.refresh(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true); assert.equal(f.applied.length, 0); await turn(); assert.equal(inputs.length, 1);
    assert.equal(await f.controller.apply(), false); assert.deepEqual(inputs[0], inputs[1]); f.controller.dispose();
  }
});

test('retiring a dispatched unknown owner keeps native close uncertain without lending its retry to a new scope', async () => {
  for (const mode of ['null', 'scope', 'instance', 'session', 'dispose']) {
    const inputs: unknown[] = [], f = fixture({apply: async input => {inputs.push(input); throw new ProjectMediaError('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', {status: 409, outcomeUnknown: true});}});
    await f.controller.refresh(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false);
    if (mode === 'dispose') f.controller.dispose();
    else {const next = mode === 'null' ? null : {...owner(), ...(mode === 'scope' ? {appLibraryScope: 'b'.repeat(64)} : mode === 'instance' ? {instanceId: id(902)} : {session: 'replacement'})}; f.setOwner(next); f.controller.update(next);}
    assert.equal(f.controller.getState().nativeOutcomeUnknown, true); assert.equal(f.controller.getState().canApply, false); assert.equal(f.controller.getState().canChoose, false);
    await f.controller.apply(); await f.controller.choose(id(1)); assert.equal(inputs.length, 1); assert.equal(f.calls.some(value => value.kind === 'discard'), false); f.controller.dispose();
  }
});

test('retiring a still dispatched native apply immediately latches unknown and ignores its late ACK', async () => {
  const late = deferred<NativeRelinkApplyResult>(), f = fixture({apply: async () => late.promise}); await f.controller.refresh(); await f.controller.choose(id(1));
  const writing = f.controller.apply(); await turn(); f.setOwner(null); f.controller.update(null);
  assert.equal(f.controller.getState().nativeOutcomeUnknown, true); assert.equal(f.controller.getState().canApply, false);
  const count = f.published.length; late.resolve(success()); assert.equal(await writing, false); await turn();
  assert.equal(f.published.length, count); assert.equal(f.applied.length, 0); assert.equal(f.calls.some(value => value.kind === 'discard'), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true); f.controller.dispose();
});

test('a host-reported earlier unknown cannot be cleared by a fresh chooser or a fabricated retry identity', async () => {
  let choices = 0;
  const f = fixture({choose: async () => {choices++; throw new ProjectMediaError('ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', {status: 409});}});
  await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
  assert.equal(f.controller.getState().nativeOutcomeUnknown, true); assert.equal(f.controller.getState().canChoose, false); assert.equal(f.controller.getState().canApply, false);
  f.controller.cancelRelink(); await f.controller.choose(id(1)); assert.equal(await f.controller.apply(), false); assert.equal(choices, 1); assert.equal(f.controller.getState().relinkOpen, true); f.controller.dispose();
});
