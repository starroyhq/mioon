import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import type {ProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import {createProjectMediaController} from '../apps/web/src/project-media-state.ts';
import type {ProjectMediaAsset, ProjectMediaOwner} from '../apps/web/src/project-media-state.ts';
import {createProjectMediaClient, ProjectMediaError} from '../apps/web/src/project-media-client.ts';
import {createNativeAssetMediaBridge} from '../apps/desktop/src/asset-relink-preload.ts';
import {createAssetRelinkHost} from '../apps/desktop/src/asset-relink-host.ts';
import {nativeRelinkPreviewSchema, NATIVE_ASSET_MEDIA_CHANNEL, NATIVE_ASSET_MEDIA_LIMITS} from '../packages/contracts/src/asset-media-native.ts';
import type {NativeAssetMediaPort, NativeRelinkPreview, NativeRelinkApplyResult, NativeRelinkApplyInput} from '../packages/contracts/src/asset-media-native.ts';
import type {AssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {assetMediaDtoSchema, assetMediaRecordSchema, assetMediaStatusListResponseSchema} from '../packages/contracts/src/asset-media.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAssetMediaServices} from '../packages/business/src/asset-media-services.ts';
import {createNativeAssetMediaServices} from '../packages/business/src/asset-media-native.ts';
import {run} from '../packages/business/src/media.ts';
import {mediaLocationPageSchema} from '../packages/contracts/src/project-media-ui.ts';

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

test('native apply retains the original token and verifies complete DTOs/revisions without changing old references', async () => {
  const f = fixture(), timeline = {clips: [{assetId: id(1)}, {assetId: id(3)}]}, history = JSON.stringify(timeline); await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
  assert.equal(await f.controller.apply(), true); assert.deepEqual(f.calls.find(value => value.kind === 'native-apply')!.input, {projectId, previewToken: id(800), requestId: 'native-original-request-1'});
  assert.equal(f.applied.length, 1); assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, ['/moved']); assert.equal(f.controller.getState().newAdded, 0); assert.equal(JSON.stringify(timeline), history);
  assert.equal(f.controller.getState().relinkOpen, true, 'A partial apply keeps the dialog available for its changed and missing rows');
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

test('a held native ACK cannot publish across owner/lease changes; committed catalog refreshes preserve its receipt', async () => {
  for (const replacement of [null, {...owner(), epoch: 2}, {...owner(), instanceId: id(902)}, 'revision'] as const) {
    const late = deferred<NativeRelinkApplyResult>(), f = fixture({apply: async () => late.promise}); await f.controller.refresh(); await f.controller.choose(id(1)); const writing = f.controller.apply(); await turn();
    if (replacement === 'revision') {f.setAssets([asset(1, 2), asset(2, 2), asset(3), asset(4)]); f.controller.update(f.owner);}
    else {f.setOwner(replacement); if (replacement) f.controller.update(replacement);}
    late.resolve(success()); assert.equal(await writing, replacement === 'revision'); assert.equal(f.applied.length, replacement === 'revision' ? 1 : 0);
    if (replacement === 'revision') assert.equal(f.controller.getState().nativeOutcomeUnknown, false);
    f.controller.dispose();
  }
});

test('malformed native success never acknowledges duplicate, foreign, stale or inconsistent hash assets', async () => {
  for (const assets of [[dto(1), dto(1)], [dto(1), {...dto(2), projectId: id(999), url: projectMediaPath(id(999), id(2))}], [dto(1, 1), dto(2)], [{...dto(1), sha256: null, fingerprint: {...dto(1).fingerprint, fullSha256: hash}, hashState: 'sampled' as const}, dto(2)]]) {
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

/** Real project/app databases, filesystem media and native services run through
 * the actual host/preload/client chain. Only picker/consent and ACK loss are
 * controlled; the returned relink DTO and durable receipt are never fabricated. */
async function realNativeFixture(t: test.TestContext, mode: 'normal' | 'lost-ack' | 'not-committed' = 'normal') {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-q08-native-'));
  const projectDir = path.join(root, 'project'), external = path.join(root, 'moved');
  mkdirSync(projectDir); mkdirSync(external);
  const store = openStore(projectDir), app = openAppLibrary({dataDir: path.join(root, 'application')});
  store.put('projects', {id: store.projectId, name: 'Native sampled relink'});
  const services = createServices(store, new Map(), {application: createProjectServiceApplication(app)});
  const media = createAssetMediaServices(store, {outsidePaths: app.outsidePaths});
  const native = createNativeAssetMediaServices(store, {outsidePaths: app.outsidePaths});
  const attempts: NativeRelinkApplyInput[] = [], receipts: NativeRelinkApplyResult[] = [], previews: NativeRelinkPreview[] = [];
  let controller: ReturnType<typeof createProjectMediaController> | undefined;
  let host: ReturnType<typeof createAssetRelinkHost<object, object>> | undefined;
  t.after(async () => {controller?.dispose(); host?.dispose(); await turn(); await services.drain(); store.close(); app.close(); rmSync(root, {recursive: true, force: true});});
  const names = ['q-clip-a.mp4', 'q-clip-b.mp4', 'q-clip-c.mp4'];
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=0.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(projectDir, names[0])]);
  for (const name of names.slice(1)) copyFileSync(path.join(projectDir, names[0]), path.join(projectDir, name));
  const imported: AssetMediaDto[] = [];
  for (const name of names) imported.push(assetMediaDtoSchema.parse(await services.call('asset.import', {projectId: store.projectId, requestId: randomUUID(), sourcePath: path.join(projectDir, name)})));
  assert.deepEqual(imported.map(value => [value.hashState, value.sha256, value.referenceRevision]), Array.from({length: 3}, () => ['sampled', null, 1]));
  const bytes = names.map(name => readFileSync(path.join(projectDir, name)));
  for (const name of names) renameSync(path.join(projectDir, name), path.join(external, name));
  const owner: ProjectMediaOwner = {appLibraryScope: hash, instanceId: randomUUID(), projectId: store.projectId, epoch: 1, session: 'real-native-editor'};
  let values: ProjectMediaAsset[] = imported;
  let applied = 0, confirmations = 0;
  const backend: NativeAssetMediaPort = {...native,
    preview: async (...args) => {const result = await native.preview(...args); previews.push(result); return result;},
    apply: async (input, options) => {
      attempts.push(input);
      if (mode === 'not-committed' && attempts.length === 1) return {status: 'failed', error: {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409}, confirmedDirectories: []};
      const result = await native.apply(input, options); receipts.push(result);
      if (mode === 'lost-ack' && attempts.length === 1) throw Object.assign(new Error('Synthetic ACK loss after real commit'), {code: 'ASSET_MEDIA_NATIVE_OUTCOME_UNKNOWN', status: 409});
      return result;
    },
  };
  host = createAssetRelinkHost<object, object>({backend,
    ownerForEvent: () => ({window: {}, windowId: id(910), backendId: id(911), contextId: id(912), projectId: store.projectId, key: owner, isCurrent: () => true}),
    chooseFile: async () => path.join(external, names[0]),
    confirmOutside: async (_owner, input) => {confirmations++; assert.equal(input.displayPath, path.join(external, names[0])); return true;},
  });
  const bridge = createNativeAssetMediaBridge((channel, input) => {assert.equal(channel, NATIVE_ASSET_MEDIA_CHANNEL); return host!.handle({}, input);});
  const client = {...createProjectMediaClient(),
    status: async (input: unknown) => assetMediaStatusListResponseSchema.parse(await media.call('asset.media.status.list', input)),
    locations: async (input: unknown) => mediaLocationPageSchema.parse(await media.trustedCall('asset.media.location.list', input)),
    rules: async () => ({projectId: store.projectId, file: 'AGENTS.md' as const, exists: false, text: '', hash: null, trust: 'absent' as const, maxBytes: 8192 as const, readError: null, pendingWrites: false}),
  };
  const readStoredAsset = (value: unknown) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    // Stored imports retain a derived URL for older readers; the reference
    // record validator deliberately excludes that non-authoritative field.
    return assetMediaRecordSchema.parse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'url')));
  };
  const readStoredAssets = () => store.list('assets', store.projectId).map(readStoredAsset);
  const storedRevision = (assetId: string) => readStoredAsset(store.get('assets', assetId)).referenceRevision;
  controller = createProjectMediaController({client, nativeRelink: readProjectMediaNativeClient({__mioonAssetMediaNative: bridge})!,
    readOwner: () => owner, readAssets: () => values, onApplied: () => {applied++; values = readStoredAssets().map(value => ({id: value.id, projectId: value.projectId, name: value.name, mimeType: value.mimeType, referenceRevision: value.referenceRevision})); controller!.update(owner);},
  });
  controller.activate(); controller.update(owner); await controller.refresh(); controller.openRelink(); await controller.choose(imported[0].id);
  assert.equal(confirmations, 1); assert.equal(previews.length, 1); assert.equal(previews[0].outside, true);
  assert.deepEqual(previews[0].rows.map(value => value.outcome).sort(), ['auto', 'auto', 'picked']);
  assert.equal(previews[0].foundBy?.count, 2); assert.equal(controller.getState().canApply, true);
  const sequence = () => store.db.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence;
  return {controller, store, app, attempts, receipts, imported, values: () => values, applied: () => applied,
    external, sequence, bytes, storedRevision,
    refreshCatalog() {values = imported.map(value => ({...value, referenceRevision: storedRevision(value.id)})); controller!.update(owner);},
    assertFilesUnchanged() {for (const [index, name] of names.entries()) assert.deepEqual(readFileSync(path.join(external, name)), bytes[index]);},
    replaceChosen() {writeFileSync(path.join(external, names[0]), Buffer.from('A different file after the original unknown'));},
  };
}

test('real native three-video outside relink accepts sampled receipts, closes the dialog and restores online media', async t => {
  const f = await realNativeFixture(t);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].status, 'applied');
  if (f.receipts[0].status !== 'applied') assert.fail('Expected the real backend relink receipt');
  assert.deepEqual(f.receipts[0].assets.map(value => [value.hashState, value.sha256, value.referenceRevision]), Array.from({length: 3}, () => ['sampled', null, 2]));
  assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().relinkOpen, false);
  assert.equal(f.applied(), 1); assert.equal(f.attempts.length, 1);
  assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, [f.external]);
  assert.equal(f.store.list('assets', f.store.projectId).length, 3);
  for (const value of f.values()) {assert.equal(value.referenceRevision, 2); assert.equal(f.controller.statusFor(value).kind, 'online'); assert.equal(f.controller.canRead(value), true);}
  const state = f.controller.getState(); assert.equal(state.status.kind, 'ready');
  if (state.status.kind === 'ready') for (const value of Object.values(state.status.value)) {assert.equal(value.outside, true); assert.equal(value.status, 'online'); assert.equal(value.reason, 'same-stats');}
  f.assertFilesUnchanged();
});

test('real committed relink with a lost ACK settles by original-key receipt after the catalog observes the new revisions', async t => {
  const f = await realNativeFixture(t, 'lost-ack');
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
  assert.equal(f.applied(), 0); assert.deepEqual(f.imported.map(value => f.storedRevision(value.id)), [2, 2, 2]);
  const sequence = f.sequence(); f.refreshCatalog(); await f.controller.refresh();
  f.app.outsidePaths.revoke(f.store.projectId, f.external);
  assert.equal(await f.controller.apply(), true); assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().relinkOpen, false);
  assert.equal(f.attempts.length, 2); assert.deepEqual(f.attempts[0], f.attempts[1]); assert.equal(f.applied(), 1);
  assert.equal(f.sequence(), sequence); assert.deepEqual(f.app.outsidePaths.list(f.store.projectId), []);
  assert.equal(f.store.list('assets', f.store.projectId).length, 3); assert.deepEqual(f.imported.map(value => f.storedRevision(value.id)), [2, 2, 2]);
  f.assertFilesUnchanged();
});

test('real unknown before commit cannot acknowledge changed media on retry or mint a second relink intent', async t => {
  const f = await realNativeFixture(t, 'not-committed'), sequence = f.sequence();
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
  assert.deepEqual(f.imported.map(value => f.storedRevision(value.id)), [1, 1, 1]);
  assert.deepEqual(f.app.outsidePaths.list(f.store.projectId), []); f.replaceChosen();
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, false);
  assert.equal(f.controller.getState().lastError, 'REVISION_CONFLICT');
  assert.equal(f.applied(), 0); assert.equal(f.attempts.length, 2); assert.deepEqual(f.attempts[0], f.attempts[1]);
  assert.equal(f.sequence(), sequence); assert.deepEqual(f.app.outsidePaths.list(f.store.projectId), []);
  assert.deepEqual(f.imported.map(value => f.storedRevision(value.id)), [1, 1, 1]);
});
