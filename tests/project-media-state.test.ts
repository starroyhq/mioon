import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProjectMediaController, sameMediaOwner} from '../apps/web/src/project-media-state.ts';
import type {ProjectMediaAsset, ProjectMediaOwner, ChooseMediaPreview} from '../apps/web/src/project-media-state.ts';
import {createProjectMediaClient, ProjectMediaError} from '../apps/web/src/project-media-client.ts';
import type {ProjectMediaClient} from '../apps/web/src/project-media-client.ts';
import type {ProjectMediaNativeClient} from '../apps/web/src/project-media-native-client.ts';
import type {AssetMediaState, AssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {nativeRelinkPreviewSchema} from '../packages/contracts/src/asset-media-native.ts';
import type {NativeRelinkApplyResult} from '../packages/contracts/src/asset-media-native.ts';
import {projectMediaPath, projectRpcPath, projectApiPath} from '../packages/contracts/src/project-file.ts';
import {extractBetween, stripSourceTypes} from './helpers/eval-source.ts';
import {projectEntryFixture, projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(900), hash = 'a'.repeat(64);
const owner = (epoch = 1): ProjectMediaOwner => ({appLibraryScope: hash, instanceId: id(901), projectId, epoch, session: 'editor-session'});
const asset = (value = 1, referenceRevision = 1): ProjectMediaAsset => ({id: id(value), projectId, name: `${value}.png`, mimeType: 'image/png', referenceRevision});
const status = (value = 1, patch: Partial<AssetMediaState> = {}): AssetMediaState => ({assetId: id(value), referenceRevision: 1, fingerprintToken: hash, status: 'online', reason: 'same-stats', outside: false, readable: true, ...patch});
const location = (value = 1) => ({assetId: id(value), displayPath: `/project/${value}.png`, pathForm: 'relative' as const, volume: null, outside: false});
const group = (directory = '/outside', patch = {}) => ({directory, volume: null, assetCount: 1, available: true, locationToken: id(700), confirmed: false, ...patch});
const dto = (value: number, revision = 1): AssetMediaDto => ({...asset(value, revision), mimeType: 'image/png', sizeBytes: 1, sha256: hash, fingerprint: {sizeBytes: 1, mtimeMs: 1, sampledSha256: hash, fullSha256: hash}, hashState: 'full', url: projectMediaPath(projectId, id(value))});
const rules = {projectId, file: 'AGENTS.md' as const, exists: true, text: 'Only a synthetic rule.', hash, trust: 'untrusted' as const, maxBytes: 8192 as const, readError: null, pendingWrites: false};
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {resolve, promise};}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(patch: Partial<ProjectMediaClient> = {}, chooser?: ChooseMediaPreview, nativeRelink?: ProjectMediaNativeClient) {
  let current: ProjectMediaOwner | null = owner(), values: readonly ProjectMediaAsset[] = [asset()];
  let failObservation = false;
  const calls: {kind: string; input: unknown}[] = [], changes: unknown[] = [], applied: ProjectMediaOwner[] = [];
  const client: ProjectMediaClient = {...createProjectMediaClient(),
    status: async input => {calls.push({kind: 'status', input}); return {items: values.map(value => status(Number(value.id.slice(-12)), {referenceRevision: value.referenceRevision})), nextCursor: null};},
    locations: async input => {calls.push({kind: 'locations', input}); return {assets: values.map(value => location(Number(value.id.slice(-12)))), locations: [], nextCursor: null};},
    rules: async () => rules,
    apply: async input => {calls.push({kind: 'apply', input}); return {assets: [dto(1, 2)]};},
    acceptChanged: async input => {calls.push({kind: 'changed', input}); return {asset: dto(10), replacesAssetId: id(1)};},
    confirm: async input => {calls.push({kind: 'confirm', input}); return {confirmedDirectories: ['/outside'], revokedDirectories: []};}, ...patch};
  let sequence = 0;
  const controller = createProjectMediaController({client, readOwner: () => current, readAssets: () => values, onChange: value => changes.push(value), onApplied: value => {applied.push(value); if (failObservation) throw Error('synthetic observation failure');}, newRequestId: () => `synthetic-request-${++sequence}`, ...(chooser ? {choosePreview: chooser} : {}), ...(nativeRelink ? {nativeRelink} : {})});
  controller.activate(); controller.update(current);
  return {controller, calls, changes, applied, failObservation: () => {failObservation = true;}, setOwner: (value: ProjectMediaOwner | null) => {current = value;}, setAssets: (next: readonly ProjectMediaAsset[]) => {values = next;}, get owner() {return current;}, get assets() {return values;}};
}
const preview = {previewToken: id(800), chosen: {assetId: id(1), matches: true}, found: [], mismatched: [], unverified: []};
const choose: ChooseMediaPreview = async () => ({preview, displayPaths: [{assetId: id(1), displayPath: '/chosen/1.png'}]});

test('complete strict status and locations are read without content, permission or import actions', async () => {
  const f = fixture(); assert.equal(f.controller.canRead(asset()), false);
  await f.controller.refresh(); assert.equal(f.controller.canRead(asset()), true);
  assert.equal(f.controller.getState().rulesUntrusted, true);
  assert.deepEqual(f.calls.map(value => value.kind).sort(), ['locations', 'status']);
  assert.equal(JSON.stringify(f.controller.getState()).includes(rules.text), false);
  f.controller.dispose();
});

test('unconfirmed, changed, missing, unreadable and failure never admit media bytes', async () => {
  for (const value of [status(1, {outside: true, readable: false}), status(1, {status: 'changed', reason: 'unverified', outside: true, readable: false}), status(1, {status: 'changed', reason: 'content'}), status(1, {status: 'missing', reason: 'not-found', readable: false}), status(1, {readable: false})]) {
    const f = fixture({status: async () => ({items: [value], nextCursor: null})}); await f.controller.refresh(); assert.equal(f.controller.canRead(asset()), false); f.controller.dispose();
  }
  const f = fixture({status: async () => {throw new ProjectMediaError('UNAUTHORIZED', {status: 401});}});
  await f.controller.refresh(); assert.deepEqual(f.controller.statusFor(asset()), {kind: 'check-failed'}); assert.equal(f.controller.canRead(asset()), false); assert.equal(f.controller.getState().lastError, 'UNAUTHORIZED'); f.controller.dispose();
});

test('pagination publishes no partial statuses and rejects duplicate, loop, foreign and stale revisions', async () => {
  const gate = deferred<{items: AssetMediaState[]; nextCursor: null}>();
  let pages = 0;
  const f = fixture({status: async () => ++pages === 1 ? {items: [status()], nextCursor: id(1)} : gate.promise});
  f.setAssets([asset(), asset(2)]); f.controller.update(f.owner);
  const reading = f.controller.refreshStatus(); await turn(); assert.equal(f.controller.canRead(asset()), false); assert.equal(f.controller.getState().status.kind, 'loading');
  gate.resolve({items: [status(2)], nextCursor: null}); await reading; assert.equal(f.controller.canRead(asset(2)), true); f.controller.dispose();
  for (const bad of [{items: [status(), status()], nextCursor: null}, {items: [status(2)], nextCursor: null}, {items: [status(1, {referenceRevision: 2})], nextCursor: null}, {items: [], nextCursor: id(1)}]) {
    const g = fixture({status: async () => bad}); await g.controller.refreshStatus(); assert.equal(g.controller.getState().status.kind, 'error'); assert.equal(g.controller.canRead(asset()), false); g.controller.dispose();
  }
});

test('a new refresh aborts an ignored-signal page; same UUID owner generation and dispose discard late callbacks', async () => {
  const late = deferred<{items: AssetMediaState[]; nextCursor: null}>(); let calls = 0, oldSignal: AbortSignal | undefined;
  const f = fixture({status: async (_input, options) => {if (++calls === 1) {oldSignal = options?.signal; return late.promise;} return {items: [status()], nextCursor: null};}});
  const first = f.controller.refreshStatus(); await turn(); await f.controller.refreshStatus(); await first;
  assert.equal(oldSignal?.aborted, true); assert.equal(f.controller.canRead(asset()), true);
  f.setOwner(owner(2)); assert.equal(f.controller.canRead(asset()), false); f.controller.update(f.owner);
  late.resolve({items: [status()], nextCursor: null}); await turn(); assert.equal(f.controller.getState().status.kind, 'loading');
  f.controller.dispose(); const count = f.changes.length; await turn(); assert.equal(f.changes.length, count);
});

test('revision changes invalidate stale objects and pending preview before any apply', async () => {
  const selected = deferred<Awaited<ReturnType<ChooseMediaPreview>>>(); const f = fixture({}, () => selected.promise);
  await f.controller.refresh(); f.controller.openRelink(); const choosing = f.controller.choose(id(1)); await turn();
  f.setAssets([asset(1, 2)]); assert.equal(f.controller.canRead(asset()), false); f.controller.update(f.owner);
  selected.resolve(await choose({projectId, assetId: id(1), expectedReferenceRevision: 1, signal: new AbortController().signal})); await choosing;
  assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); assert.equal(f.calls.some(value => value.kind === 'apply'), false); f.controller.dispose();
});

test('chooser cancellation and dialog cancellation perform no project or permission writes', async () => {
  const f = fixture({}, async () => null); await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1)); f.controller.cancelRelink(); f.controller.openOnly();
  assert.equal(await f.controller.apply(), false); assert.deepEqual(f.calls.map(value => value.kind).sort(), ['locations', 'status']); f.controller.dispose();
});

test('same-content preview only changes references on explicit apply and checks new revision', async () => {
  const f = fixture({}, choose); await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
  assert.equal(f.calls.some(value => value.kind === 'apply'), false); assert.equal(f.controller.getState().canApply, true);
  assert.equal(await f.controller.apply(), true); assert.equal(f.calls.filter(value => value.kind === 'apply').length, 1); assert.deepEqual(f.applied, [owner()]); f.controller.dispose();
});

test('changed content stages a new ID; old identity and all old clip references are preserved', async () => {
  const old = asset(), timeline = {clips: [{assetId: old.id, id: id(55)}]};
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'content'})], nextCursor: null})});
  await f.controller.refresh(); f.controller.openRelink(); f.controller.toggleChanged(id(1));
  assert.deepEqual(f.controller.getState().changedSelected, [id(1)]); assert.equal(f.controller.getState().canApply, true); assert.equal(f.calls.some(value => value.kind === 'changed'), false);
  assert.equal(await f.controller.apply(), true); assert.equal(f.controller.getState().newAdded, 1); assert.equal(old.referenceRevision, 1); assert.equal(timeline.clips[0]!.assetId, id(1)); assert.equal(f.calls.filter(value => value.kind === 'changed').length, 1); f.controller.dispose();
});

test('unverified changed rows cannot be accepted; absent chooser has no fallback import capability', async () => {
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'unverified', outside: true, readable: false})], nextCursor: null})});
  await f.controller.refresh(); f.controller.toggleChanged(id(1)); await f.controller.choose(id(1)); assert.equal(f.controller.getState().canChoose, false); assert.equal(f.controller.getState().canApply, false); assert.equal(await f.controller.apply(), false); f.controller.dispose();
});

test('a changed selection pins the shown revision even before the next layout update', async () => {
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'content'})], nextCursor: null})});
  await f.controller.refresh(); f.controller.toggleChanged(id(1)); f.setAssets([asset(1, 2)]);
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().lastError, 'REVISION_CONFLICT'); assert.equal(f.calls.some(value => value.kind === 'changed'), false); f.controller.dispose();
});

test('unknown mutation acknowledgements retry the exact key, never silently accept a second identity', async () => {
  const inputs: unknown[] = []; let count = 0;
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'content'})], nextCursor: null}), acceptChanged: async input => {inputs.push(input); if (++count === 1) throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: true}); return {asset: dto(10), replacesAssetId: id(1)};}});
  await f.controller.refresh(); f.controller.openRelink(); f.controller.toggleChanged(id(1)); assert.equal(await f.controller.apply(), false); assert.equal(inputs.length, 1); await turn(); assert.equal(inputs.length, 1);
  f.controller.cancelRelink(); f.controller.openRelink(); assert.equal(await f.controller.apply(), true); assert.deepEqual(inputs[0], inputs[1]); assert.equal(f.controller.getState().newAdded, 1); f.controller.dispose();
});

test('invalid new-ID acknowledgement stays unknown and rejects reused old identity', async () => {
  const inputs: unknown[] = [];
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'content'})], nextCursor: null}), acceptChanged: async input => {inputs.push(input); return {asset: dto(1), replacesAssetId: id(1)};}});
  await f.controller.refresh(); f.controller.toggleChanged(id(1)); assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().newAdded, 0); assert.equal(await f.controller.apply(), false); assert.deepEqual(inputs[0], inputs[1]); f.controller.dispose();
});

test('a verified mutation stays successful when its follow-up read fails; the content gate remains closed', async () => {
  const f = fixture({}, choose); await f.controller.refresh(); await f.controller.choose(id(1)); f.failObservation();
  assert.equal(await f.controller.apply(), true); assert.equal(f.controller.getState().applyAction.kind, 'idle'); assert.equal(f.controller.getState().status.kind, 'error'); assert.equal(f.controller.canRead(asset()), false); f.controller.dispose();
});

test('a later definitive failure still reports and observes the verified changed-asset prefix', async () => {
  let attempts = 0;
  const f = fixture({status: async () => ({items: [status(1, {status: 'changed', reason: 'content'}), status(2, {status: 'changed', reason: 'content'})], nextCursor: null}), acceptChanged: async () => {if (++attempts === 2) throw new ProjectMediaError('MEDIA_MISSING', {status: 404}); return {asset: dto(10), replacesAssetId: id(1)};}});
  f.setAssets([asset(), asset(2)]); f.controller.update(f.owner); await f.controller.refresh(); f.controller.toggleChanged(id(1)); f.controller.toggleChanged(id(2));
  assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().newAdded, 1); assert.equal(f.applied.length, 1); assert.equal(f.controller.getState().canApply, false); assert.equal(attempts, 2); f.controller.dispose();
});

test('outside location pages repeat groups without duplication; only available unconfirmed exact directories can be granted', async () => {
  const seen: unknown[] = [];
  const f = fixture({locations: async input => {const after = typeof input === 'object' && input && 'cursor' in input; return {assets: [location(after ? 2 : 1)], locations: [group('/outside', {locationToken: id(after ? 702 : 701)}), group('/missing', {available: false}), group('/already', {confirmed: true})], nextCursor: after ? null : id(1)};}, confirm: async input => {seen.push(input); return {confirmedDirectories: ['/outside'], revokedDirectories: []};}});
  f.setAssets([asset(), asset(2)]); f.controller.update(f.owner); await f.controller.refresh();
  const state = f.controller.getState(); assert.equal(state.outsideOpen, true); if (state.locations.kind === 'ready') assert.equal(state.locations.value.locations.length, 3); else assert.fail('complete locations');
  f.controller.openOnly(); assert.equal(seen.length, 0); f.controller.openOutside(); await turn(); assert.equal(await f.controller.allowOutside(), true);
  assert.deepEqual(seen, [{projectId, requestId: 'synthetic-request-1', locationToken: id(702)}]); assert.equal(f.controller.getState().rulesUntrusted, true); f.controller.dispose();
});

test('outside permission unknown ACK preserves request key and does not retry automatically', async () => {
  const inputs: unknown[] = []; let count = 0;
  const f = fixture({locations: async () => ({assets: [location()], locations: [group()], nextCursor: null}), confirm: async input => {inputs.push(input); if (++count === 1) throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: true}); return {confirmedDirectories: ['/outside'], revokedDirectories: []};}});
  await f.controller.refresh(); assert.equal(await f.controller.allowOutside(), false); assert.equal(inputs.length, 1); assert.equal(await f.controller.allowOutside(), true); assert.deepEqual(inputs[0], inputs[1]); f.controller.dispose();
});

test('late owner replacement while applying preserves the old owner and suppresses all current callbacks', async () => {
  const pending = deferred<{assets: AssetMediaDto[]}>(); let signal: AbortSignal | undefined;
  const f = fixture({apply: async (_input, options) => {signal = options?.signal; return pending.promise;}}, choose);
  await f.controller.refresh(); await f.controller.choose(id(1)); const writing = f.controller.apply(); await turn();
  f.setOwner({...owner(), appLibraryScope: 'b'.repeat(64)}); f.controller.update(f.owner); pending.resolve({assets: [dto(1, 2)]}); assert.equal(await writing, false); assert.equal(signal?.aborted, true); assert.deepEqual(f.applied, []); assert.equal(f.controller.canRead(asset()), false); f.controller.dispose();
});

test('all owner identity fields fence same-project state, including an editor session replacement', async () => {
  for (const replacement of [{...owner(), appLibraryScope: 'b'.repeat(64)}, {...owner(), instanceId: id(902)}, owner(2), {...owner(), session: 'new-session'}]) {
    const f = fixture(); await f.controller.refresh(); assert.equal(f.controller.canRead(asset()), true);
    f.setOwner(replacement); assert.equal(f.controller.canRead(asset()), false); f.controller.update(replacement); assert.equal(f.controller.getState().status.kind, 'loading'); f.controller.dispose();
  }
});

test('unbounded or malformed catalogs fail explicitly and never turn into a readable empty state', async () => {
  for (const values of [[asset(), asset()], [asset(1, 0)], Array.from({length: 20_001}, (_, i) => asset(i + 1))]) {
    const f = fixture(); f.setAssets(values); assert.doesNotThrow(() => f.controller.update(f.owner));
    await f.controller.refresh(); assert.equal(f.controller.getState().status.kind, 'error'); assert.equal(f.controller.canRead(asset()), false); assert.equal(f.calls.length, 0); f.controller.dispose();
  }
});

test('the bounded 200-page read refuses endless tiny pages before publishing any status', async () => {
  let count = 0;
  const f = fixture({status: async () => {count++; return {items: [status(count)], nextCursor: id(count)};}});
  f.setAssets(Array.from({length: 201}, (_, i) => asset(i + 1))); f.controller.update(f.owner);
  await f.controller.refreshStatus(); assert.equal(count, 200); assert.equal(f.controller.getState().lastError, 'INSPECTION_BUDGET_EXCEEDED'); assert.equal(f.controller.canRead(asset()), false); f.controller.dispose();
});

const response = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? {ok: true, data} : data), {status, headers: {'content-type': 'application/json'}});

/** Execute the real focus callback, together with the real strict directory
 * owner, browser media transport and controller. The remote metadata alone is
 * controlled; any content or permission operation fails the fixture. */
async function focusFixture() {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const source = extractBetween(app, '    const recheck = () => {', "    window.addEventListener('focus', recheck);");
  let mediaStatus = status(), mediaFailure = false, mediaHold: Promise<Response> | null = null, statusSignal: AbortSignal | undefined;
  const http: {resource: string; operation: string}[] = [], directories: unknown[][] = [];
  const snapshot = projectEntryFixture([{id: projectId}], owner());
  let readDirectory: () => unknown | Promise<unknown> = () => snapshot;
  const identity = projectEntryOwnerFixture(() => readDirectory(), directories);
  await identity.discover();
  const client = createProjectMediaClient({fetcher: async (url, init) => {
    const resource = String(url), raw: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    const operation = raw && typeof raw === 'object' && 'operation' in raw && typeof raw.operation === 'string' ? raw.operation : 'rules';
    http.push({resource, operation});
    if (resource === projectRpcPath(projectId) && operation === 'asset.media.status.list') {
      statusSignal = init?.signal ?? undefined;
      if (mediaHold) return mediaHold;
      return mediaFailure ? response({ok: false, error: {code: 'INTERNAL_ERROR', message: 'synthetic'}}, 500) : response({items: [mediaStatus], nextCursor: null});
    }
    if (resource === projectApiPath(projectId, 'asset-media', 'trusted') && operation === 'asset.media.location.list') return response({assets: [location()], locations: [], nextCursor: null});
    if (resource === projectApiPath(projectId, 'rules') && operation === 'rules') return response(rules);
    assert.fail(`Focus attempted a content or mutation request: ${operation}`);
  }});
  const f = fixture(client); await f.controller.refresh();
  const importSession = {current: {active: true}};
  let refreshes = 0;
  const env = {identity, importSession, sameMediaOwner, readProjectMediaOwner: () => f.owner, projectMedia: {controller: {refresh: () => {refreshes++; return f.controller.refresh();}}}};
  const recheck = Function(...Object.keys(env), stripSourceTypes(source) + ';return recheck;')(...Object.values(env)) as () => void;
  http.length = 0; directories.length = 0;
  return {f, identity, importSession, recheck, http, directories, snapshot, refreshes: () => refreshes,
    setStatus: (value: AssetMediaState) => {mediaStatus = value;}, failMedia: () => {mediaFailure = true;}, holdMedia: (value: Promise<Response>) => {mediaHold = value;}, statusSignal: () => statusSignal,
    readDirectory: (read: () => unknown | Promise<unknown>) => {readDirectory = read;},
    dispose: () => {importSession.current.active = false; f.controller.dispose(); identity.dispose();},
  };
}
const metadataOnly = (calls: readonly {resource: string; operation: string}[]): void => {
  assert.ok(calls.every(call => ['asset.media.status.list', 'asset.media.location.list', 'rules'].includes(call.operation)));
  assert.ok(calls.every(call => !call.resource.includes('/media/')));
};

test('actual App focus rechecks unchanged-reference assets after the strict directory, then closes changed and missing content gates', async () => {
  for (const changed of [status(1, {status: 'changed', reason: 'content'}), status(1, {status: 'missing', reason: 'not-found', readable: false})]) {
    const h = await focusFixture();
    assert.equal(h.f.controller.canRead(asset()), true);
    const held = deferred<unknown>(); h.readDirectory(() => held.promise); h.setStatus(changed); h.recheck();
    await turn(); assert.equal(h.directories.length, 1); assert.equal(h.refreshes(), 0); assert.deepEqual([...h.http], []);
    held.resolve(h.snapshot); await turn();
    assert.equal(h.refreshes(), 1); assert.equal(h.f.controller.canRead(asset()), false);
    const state = h.f.controller.getState(); assert.equal(state.status.kind, 'ready');
    if (state.status.kind === 'ready') assert.deepEqual(state.status.value[id(1)], changed);
    assert.equal(changed.referenceRevision, 1, 'An external file change does not need an asset revision change');
    assert.deepEqual(h.http.map(call => call.operation).sort(), ['asset.media.location.list', 'asset.media.status.list', 'rules']); metadataOnly(h.http); h.dispose();
  }
});

test('actual App held focus cannot refresh a replacement project, epoch, instance, scope or editor session', async () => {
  for (const replacement of [{...owner(), projectId: id(999)}, owner(2), {...owner(), instanceId: id(902)}, {...owner(), appLibraryScope: 'b'.repeat(64)}, {...owner(), session: 'new-session'}]) {
    const h = await focusFixture(), held = deferred<unknown>(); h.readDirectory(() => held.promise); h.recheck(); await turn();
    h.f.setOwner(replacement); h.f.setAssets([{...asset(), projectId: replacement.projectId}]); h.f.controller.update(replacement);
    const changes = h.f.changes.length; held.resolve(h.snapshot); await turn();
    assert.equal(h.refreshes(), 0); assert.deepEqual(h.http, []); assert.equal(h.f.changes.length, changes);
    assert.equal(h.f.controller.getState().status.kind, 'loading'); h.dispose();
  }
});

test('actual App inactive session discards held focus before media refresh or publication', async () => {
  const h = await focusFixture(), held = deferred<unknown>(); h.readDirectory(() => held.promise); h.recheck(); await turn();
  const changes = h.f.changes.length; h.importSession.current.active = false; held.resolve(h.snapshot); await turn();
  assert.equal(h.refreshes(), 0); assert.deepEqual(h.http, []); assert.equal(h.f.changes.length, changes); h.dispose();
});

test('actual App ordinary same-owner directory error never starts media reads or permission writes', async () => {
  for (const read of [() => {throw Error('synthetic unavailable directory');}, () => ({...projectEntryFixture([{id: projectId}], owner()), extra: true})]) {
    const h = await focusFixture(); h.readDirectory(read); const changes = h.f.changes.length; h.recheck(); await turn();
    assert.equal(h.directories.length, 1); assert.equal(h.identity.getState().phase, 'error'); assert.equal(h.identity.getState().identityBlocked, false);
    assert.equal(h.refreshes(), 0); assert.deepEqual(h.http, []); assert.equal(h.f.changes.length, changes); h.dispose();
  }
});

test('actual App same-owner media status failure keeps content unknown and makes no authorization mutation', async () => {
  const h = await focusFixture(); h.failMedia(); h.recheck(); await turn();
  assert.equal(h.refreshes(), 1); assert.equal(h.f.controller.getState().status.kind, 'error'); assert.equal(h.f.controller.canRead(asset()), false);
  metadataOnly(h.http); assert.equal(h.http.filter(call => call.operation === 'asset.media.status.list').length, 1); h.dispose();
});

test('actual App focus already reading media cannot publish after unmount even when the transport ignores abort', async () => {
  const h = await focusFixture(), held = deferred<Response>(); h.holdMedia(held.promise); h.recheck(); await turn();
  assert.equal(h.refreshes(), 1); const calls = h.http.length; h.dispose(); const changes = h.f.changes.length;
  assert.equal(h.statusSignal()?.aborted, true); held.resolve(response({items: [status(1, {status: 'changed', reason: 'content'})], nextCursor: null})); await turn();
  assert.equal(h.f.changes.length, changes); assert.equal(h.http.length, calls); metadataOnly(h.http); assert.equal(h.f.controller.getState().owner, null);
});

test('browser adapter uses only fixed S1/R2 routes with strict bodies, bounded read transport and trusted gesture header', async () => {
  const calls: {resource: string; init: RequestInit | undefined}[] = [];
  const client = createProjectMediaClient({fetcher: async (resource, init) => {calls.push({resource: String(resource), init}); const op = init?.body ? JSON.parse(String(init.body)).operation : 'rules'; return response(op === 'asset.media.status.list' ? {items: [status()], nextCursor: null} : op === 'asset.media.location.list' ? {assets: [location()], locations: [], nextCursor: null} : op === 'asset.media.prepare' ? {assets: [dto(1)]} : op === 'asset.media.relink.preview' ? preview : op === 'asset.media.relink.apply' ? {assets: [dto(1, 2)]} : op === 'asset.media.acceptChanged' ? {asset: dto(10), replacesAssetId: id(1)} : op === 'asset.media.outside.confirm' ? {confirmedDirectories: ['/outside'], revokedDirectories: []} : rules);}});
  await client.status({projectId}); await client.locations({projectId}); await client.prepare({projectId, assets: [{assetId: id(1), referenceRevision: 1}], purpose: 'timeline'}); await client.preview({projectId, assetId: id(1), sourcePath: '/chosen/1.png', expectedReferenceRevision: 1}); await client.apply({projectId, requestId: 'synthetic-apply', previewToken: id(800)}); await client.acceptChanged({projectId, requestId: 'synthetic-new', assetId: id(1), expectedReferenceRevision: 1}); await client.confirm({projectId, requestId: 'synthetic-confirm', locationToken: id(700)}); await client.rules(projectId);
  assert.equal(calls.length, 8);
  for (const call of calls) {assert.ok([projectRpcPath(projectId), projectApiPath(projectId, 'asset-media', 'trusted'), projectApiPath(projectId, 'rules')].includes(call.resource)); assert.equal(call.init?.credentials, 'same-origin'); assert.equal(call.init?.cache, 'no-store'); assert.equal(call.init?.redirect, 'error'); const headers = new Headers(call.init?.headers); assert.equal(headers.get('x-mioon-user-action'), call.resource.endsWith('/trusted') ? 'asset-media' : null);}
});

test('invalid browser inputs never dispatch and strict response DTO refuses metadata/path extras', async () => {
  let calls = 0; const client = createProjectMediaClient({fetcher: async () => {calls++; return response({items: [{...status(), sourcePath: '/private'}], nextCursor: null});}});
  await assert.rejects(client.status({projectId, path: '/private'}), {code: 'VALIDATION_ERROR'}); assert.equal(calls, 0);
  await assert.rejects(client.status({projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('401/403 status and codes survive, status-code mismatches and malformed envelopes fail closed', async () => {
  for (const [code, http] of [['UNAUTHORIZED', 401], ['MEDIA_OUTSIDE_NOT_CONFIRMED', 403]] as const) {
    const client = createProjectMediaClient({fetcher: async () => response({ok: false, error: {code, message: 'synthetic'}}, http)});
    await assert.rejects(client.status({projectId}), {code, status: http});
  }
  for (const bad of [response({ok: false, error: {code: 'UNAUTHORIZED', message: 'synthetic'}}, 403), response({items: [], nextCursor: null, extra: true})]) {
    const client = createProjectMediaClient({fetcher: async () => bad}); await assert.rejects(client.status({projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
});

test('a structured server 500 after a dispatched write is unknown and retains the exact retry identity', async () => {
  const client = createProjectMediaClient({fetcher: async () => response({ok: false, error: {code: 'INTERNAL_ERROR', message: 'synthetic'}}, 500)});
  await assert.rejects(client.acceptChanged({projectId, requestId: 'synthetic-internal', assetId: id(1), expectedReferenceRevision: 1}), {code: 'INTERNAL_ERROR', status: 500, outcomeUnknown: true});
  await assert.rejects(client.status({projectId}), {code: 'INTERNAL_ERROR', status: 500, outcomeUnknown: false});
});

test('deadline and caller abort settle ignored-signal transport; dispatched mutation outcome remains unknown', async () => {
  let signal: AbortSignal | undefined;
  const client = createProjectMediaClient({timeoutMs: 5, fetcher: async (_url, options) => {signal = options?.signal ?? undefined; return new Promise<Response>(() => {});}});
  await assert.rejects(client.status({projectId}), {code: 'TIMEOUT', outcomeUnknown: false}); assert.equal(signal?.aborted, true);
  await assert.rejects(client.acceptChanged({projectId, requestId: 'synthetic-timeout', assetId: id(1), expectedReferenceRevision: 1}), {code: 'TIMEOUT', outcomeUnknown: true});
  const abort = new AbortController(); const pending = client.status({projectId}, {signal: abort.signal}); abort.abort(); await assert.rejects(pending, {code: 'INTERRUPTED'});
});

test('invalid UTF8 and over-budget status bodies are canceled before a DTO can be published', async () => {
  for (const body of [new Uint8Array([0xc3, 0x28]), new Uint8Array(256 * 1024 + 1)]) {
    let canceled = false; const client = createProjectMediaClient({fetcher: async () => new Response(new ReadableStream({start(controller) {controller.enqueue(body);}, cancel() {canceled = true;}}), {headers: {'content-type': 'application/json'}})});
    await assert.rejects(client.status({projectId}), {code: 'BACKEND_PROTOCOL_ERROR'}); assert.equal(canceled, true);
  }
});

const nativeThreePreview = () => nativeRelinkPreviewSchema.parse({
  projectId, assetId: id(1), expectedReferenceRevision: 1, previewToken: id(800), displayPath: '/moved/1.png', outside: true,
  rows: [1, 2, 3].map(value => ({assetId: id(value), name: `${value}.png`, from: `/old/${value}.png`, to: `/moved/${value}.png`,
    outcome: value === 1 ? 'picked' : 'auto', referenceRevision: 1})), foundBy: {name: '1.png', count: 2},
});
const sampledDto = (value: number, revision = 2): AssetMediaDto => ({...dto(value, revision), sha256: null,
  fingerprint: {...dto(value, revision).fingerprint, fullSha256: null}, hashState: 'sampled'});
const nativeThreeReceipt = (sampled = false): NativeRelinkApplyResult => ({status: 'applied',
  assets: [1, 2, 3].map(value => sampled ? sampledDto(value) : dto(value, 2)), confirmedDirectories: ['/moved']});
function nativeThreeFixture(apply: ProjectMediaNativeClient['apply']) {
  const inputs: unknown[] = [], discarded: unknown[] = [];
  const f = fixture({}, undefined, {choose: async () => nativeThreePreview(),
    apply: async (input, options) => {inputs.push(input); return apply(input, options);}, discard: async input => {discarded.push(input);}});
  f.setAssets([asset(1), asset(2), asset(3)]); f.controller.update(f.owner);
  return {...f, inputs, discarded, get assets() {return f.assets;}};
}

test('a native applied receipt survives an App catalog refresh before its acknowledgement without rewinding newer revisions', async () => {
  for (const observedRevision of [2, 4]) {
    const held = deferred<NativeRelinkApplyResult>(), f = nativeThreeFixture(async () => held.promise);
    try {
      await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
      const applying = f.controller.apply(); await turn(); assert.equal(f.inputs.length, 1);
      const observed = [asset(1, observedRevision), asset(2, observedRevision), asset(3, observedRevision)];
      f.setAssets(observed); f.controller.update(f.owner);
      held.resolve(nativeThreeReceipt());
      assert.equal(await applying, true, 'The exact revision-2 receipt proves this operation even if App already observed it or a later revision');
      assert.equal(f.controller.getState().nativeOutcomeUnknown, false);
      assert.equal(f.controller.getState().relinkOpen, false, 'All three preview rows were verified, so the dialog closes');
      assert.equal(f.controller.getState().applyAction.kind, 'idle');
      assert.equal(f.applied.length, 1); assert.deepEqual(f.assets, observed, 'Receipt DTOs must not replace the newer catalog');
      assert.equal(f.inputs.length, 1); assert.deepEqual(f.discarded, []);
    } finally {f.controller.dispose();}
  }
});

test('native outside relink accepts a schema-consistent sampled receipt for all three selected and automatic rows', async () => {
  const f = nativeThreeFixture(async () => nativeThreeReceipt(true));
  try {
    await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
    assert.equal(f.controller.getState().canApply, true);
    assert.equal(await f.controller.apply(), true);
    assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().relinkOpen, false);
    assert.equal(f.applied.length, 1); assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, ['/moved']);
    assert.deepEqual(f.inputs, [{projectId, previewToken: id(800), requestId: 'synthetic-request-1'}]);
    assert.equal(f.controller.getState().canApply, false); assert.deepEqual(f.discarded, []);
  } finally {f.controller.dispose();}
});

test('native acknowledgement still rejects missing, duplicate, foreign, wrong-revision and internally inconsistent hash evidence', async () => {
  const invalidReceipts = [
    {name: 'missing-row', assets: [sampledDto(1), sampledDto(2)]},
    {name: 'duplicate-row', assets: [sampledDto(1), sampledDto(2), sampledDto(2)]},
    {name: 'foreign-project', assets: [sampledDto(1), sampledDto(2), {...sampledDto(3), projectId: id(999), url: projectMediaPath(id(999), id(3))}]},
    {name: 'wrong-revision', assets: [sampledDto(1), sampledDto(2), sampledDto(3, 3)]},
    {name: 'unknown-asset', assets: [sampledDto(1), sampledDto(2), sampledDto(4)]},
    {name: 'inconsistent-full-hash', assets: [sampledDto(1), sampledDto(2), {...sampledDto(3), sha256: hash}]},
    {name: 'inconsistent-hash-state', assets: [sampledDto(1), sampledDto(2), {...dto(3, 2), hashState: 'sampled' as const}]},
  ];
  for (const receipt of invalidReceipts) {
    const f = nativeThreeFixture(async () => ({status: 'applied', assets: receipt.assets, confirmedDirectories: ['/moved']}));
    try {
      await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
      assert.equal(await f.controller.apply(), false, receipt.name);
      assert.equal(f.controller.getState().nativeOutcomeUnknown, true, receipt.name);
      assert.equal(f.controller.getState().relinkOpen, true); assert.equal(f.applied.length, 0);
      assert.equal(f.controller.getState().canChoose, false); assert.equal(f.controller.getState().canApply, true);
      assert.equal(await f.controller.apply(), false, 'A retry cannot turn the same incomplete evidence into success');
      assert.deepEqual(f.inputs[0], f.inputs[1]); assert.equal(f.inputs.length, 2); assert.deepEqual(f.discarded, []);
    } finally {f.controller.dispose();}
  }
});

test('an unknown native operation settles from its committed sampled receipt using only the original key', async () => {
  let committed = false, mutations = 0;
  const f = nativeThreeFixture(async () => {
    if (!committed) {committed = true; mutations++; throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: true});}
    return nativeThreeReceipt(true);
  });
  try {
    await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
    assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
    const observed = [asset(1, 4), asset(2, 4), asset(3, 4)]; f.setAssets(observed); f.controller.update(f.owner);
    assert.equal(await f.controller.apply(), true);
    assert.equal(mutations, 1); assert.deepEqual(f.inputs[0], f.inputs[1]); assert.equal(f.inputs.length, 2);
    assert.deepEqual(f.assets, observed); assert.equal(f.applied.length, 1);
    assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().relinkOpen, false);
    assert.equal(await f.controller.apply(), false); assert.equal(f.inputs.length, 2, 'A settled intent cannot be resubmitted as a new mutation');
  } finally {f.controller.dispose();}
});

test('an unknown uncommitted native operation preserves the original key and respects a definitive backend rejection', async () => {
  let attempts = 0;
  const f = nativeThreeFixture(async () => {
    if (++attempts === 1) throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: true});
    return {status: 'failed', error: {code: 'REVISION_CONFLICT', status: 409}, confirmedDirectories: []};
  });
  try {
    await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
    assert.equal(await f.controller.apply(), false); assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
    assert.equal(await f.controller.apply(), false); assert.deepEqual(f.inputs[0], f.inputs[1]);
    assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().lastError, 'REVISION_CONFLICT');
    assert.equal(f.controller.getState().canApply, false); assert.equal(f.applied.length, 0);
    assert.equal(f.controller.getState().relinkOpen, true); assert.deepEqual(f.controller.getState().nativeConfirmedDirectories, []);
    assert.equal(await f.controller.apply(), false); assert.equal(attempts, 2); assert.deepEqual(f.discarded, []);
  } finally {f.controller.dispose();}
});

test('an unknown uncommitted native operation can commit once on an explicit retry with its original key', async () => {
  let attempts = 0, mutations = 0;
  const f = nativeThreeFixture(async () => {
    if (++attempts === 1) throw new ProjectMediaError('TIMEOUT', {outcomeUnknown: true});
    mutations++; return nativeThreeReceipt(true);
  });
  try {
    await f.controller.refresh(); f.controller.openRelink(); await f.controller.choose(id(1));
    assert.equal(await f.controller.apply(), false); assert.equal(mutations, 0); assert.equal(f.controller.getState().nativeOutcomeUnknown, true);
    await turn(); assert.equal(attempts, 1, 'Unknown work never dispatches an automatic retry');
    assert.equal(await f.controller.apply(), true); assert.equal(mutations, 1);
    assert.deepEqual(f.inputs[0], f.inputs[1]); assert.equal(f.inputs.length, 2);
    assert.equal(f.controller.getState().nativeOutcomeUnknown, false); assert.equal(f.controller.getState().relinkOpen, false);
    assert.equal(f.applied.length, 1); assert.equal(await f.controller.apply(), false); assert.equal(mutations, 1);
  } finally {f.controller.dispose();}
});
