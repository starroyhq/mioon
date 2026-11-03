import {mediaFingerprintToken} from '../packages/business/src/project-asset-references.ts';
import {mediaReferenceSchema} from '../packages/contracts/src/media-reference.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {openStore,registerProjectTransactionObserver} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectHomeServices,readProjectCover} from '../packages/business/src/project-home.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {runStreaming} from '../packages/business/src/media-runtime.ts';
import {previsJpegSize} from '../packages/business/src/previs.ts';
import {createProjectCoverPublisher} from '../apps/server/src/project-host/cover-publisher.ts';
import {PROJECT_COVER_LIMITS, parseProjectCoverMetadata, readProjectCoverCache} from '../apps/server/src/project-host/covers.ts';
import type {ProjectHostSummary} from '../apps/server/src/project-host/host.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {readProjectState} from './helpers/project-state.ts';

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
function summary(store: ProjectStore): ProjectHostSummary {
  const value = createProjectHomeServices(store).handlers['project.summary.list']()[0]; assert.ok(value);
  const {id: _id, name, lastOpenedAt: _opened, cover, ...rest} = value;
  return {name, summary: {...rest, cover: cover ? {assetId: cover.assetId, mimeType: cover.mimeType} : null}};
}
function pair(store: ProjectStore) {
  const jpeg = readFileSync(path.join(store.cacheDir, 'cover.jpg')), raw = readFileSync(path.join(store.cacheDir, 'cover.json'));
  return {jpeg, raw, metadata: parseProjectCoverMetadata(JSON.parse(raw.toString('utf8')))};
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-cover-publisher-'));
  let store = openStore(root), services = createServices(store, new Map());
  const publishers: {publisher: ReturnType<typeof createProjectCoverPublisher>; controller: AbortController}[] = [], releases: (() => void)[] = [];
  const close = async () => {
    for (const owned of publishers) owned.controller.abort();
    for (const release of releases) release();
    await Promise.all(publishers.map(owned => owned.publisher.drain()));
    await services.drain(); store.close();
  };
  t.after(async () => {await close(); rmSync(root, {recursive: true, force: true});});
  await services.call('project.create', {name: 'Actual cover publisher'});
  let pixelSeed = 0;
  const addAsset = async () => {
    const red = 64 + pixelSeed++;
    const pixels = png({width: 32, height: 24, pixel: () => [red, 128, 128, 255]});
    const value = record(await services.call('asset.import', {projectId: store.projectId, name: 'Synthetic actual PNG', mimeType: 'image/png', dataBase64: pixels.toString('base64')}));
    assert.equal(value.mimeType, 'image/png'); assert.equal(value.sha256, hash(pixels));
    assert.equal(typeof value.id, 'string');
    const held = record(store.get('assets', String(value.id)));
    const reference=mediaReferenceSchema.parse(held.reference);assert.equal(held.relativePath,undefined);
    return {id: String(value.id), mimeType: 'image/png' as const, sha256: String(value.sha256), reference, relativePath: reference.path};
  };
  const original = await addAsset(), timeline = record(await services.call('timeline.get', {projectId: store.projectId}));
  assert.ok(Array.isArray(timeline.tracks));
  const saved = record(await services.call('timeline.clip.add', {projectId: store.projectId, requestId: randomUUID(), expectedRevision: timeline.revision,
    assetId: original.id, trackId: record(timeline.tracks[0]).id, startFrame: 0, durationFrames: 30}));
  const timelineId = String(saved.id);
  const makePublisher = (render?: typeof runStreaming,readCover=()=>readProjectCover(store,store.projectId)) => {
    const selected = store, controller = new AbortController(), publisher = createProjectCoverPublisher({store: selected, readCover, signal: controller.signal, ...(render ? {render} : {})});
    publishers.push({publisher, controller}); return {publisher, controller};
  };
  return {root, original, addAsset, makePublisher, get store() {return store;},
    async renderActual() {
      const {publisher} = makePublisher(); publisher.refresh(); await publisher.drain();
      assert.equal(publisher.lastFailure(), undefined, 'the actual FFmpeg production path must generate a cover');
      assert.equal(publisher.isBusy(), false); return pair(store);
    },
    switchCover(assetId: string) {
      store.tx(() => {
        const current = record(store.get('timelines', timelineId)); assert.ok(Array.isArray(current.clips));
        store.put('timelines', {...current, revision: Number(current.revision) + 1, clips: current.clips.map(clip => ({...record(clip), assetId}))});
      });
    },
    async reopen() {await close(); store = openStore(root); services = createServices(store, new Map());},
    delayedRender(jpeg: Buffer) {
      const entered = deferred(), finish = deferred(); releases.push(finish.resolve);
      const render: typeof runStreaming = async (_command, _args, options = {}) => {
        options.beforeSpawn?.(); options.beforeEffect?.(); entered.resolve(); await finish.promise;
        // A valid result from an admitted media call arrives late. The actual
        // publisher must recheck its store and signal before cache publication.
        options.onStdout?.(jpeg); return {stdoutBytes: jpeg.length};
      };
      const owned = makePublisher(render); owned.publisher.refresh();
      return {...owned, entered: entered.promise, finish: finish.resolve};
    },
  };
}

test('actual FFmpeg publishes a bounded JPEG/hash pair and reopening the same source reuses the cache', {timeout: 60_000}, async t => {
  const f = await fixture(t), before = readProjectState(f.store.db), cache = await f.renderActual(), size = previsJpegSize(cache.jpeg);
  assert.ok(size); assert.ok(size.width > 0 && size.height > 0);
  assert.ok(Math.max(size.width, size.height) <= PROJECT_COVER_LIMITS.maxEdge); assert.ok(cache.jpeg.length <= PROJECT_COVER_LIMITS.jpegBytes);
  assert.deepEqual(cache.metadata, {version: 2, assetId: f.original.id, mimeType: 'image/png', sourceFingerprint: mediaFingerprintToken(mediaReferenceSchema.parse(f.original.reference)), jpegSha256: hash(cache.jpeg)});
  assert.deepEqual(readProjectCoverCache(f.store.cacheDir, {...f.original, assetId: f.original.id, sourceFingerprint: mediaFingerprintToken(mediaReferenceSchema.parse(f.original.reference))}), cache.jpeg);
  assert.equal(readProjectCoverCache(f.store.cacheDir, {assetId: f.original.id, mimeType: 'image/png', sourceFingerprint: 'f'.repeat(64)}), null);
  assert.deepEqual(readProjectState(f.store.db), before, 'cover generation writes no project/history/cache SQL rows');
  await f.reopen();
  let renders = 0;
  const failRender: typeof runStreaming = async () => {renders++; assert.fail('an unchanged source must reuse its real persisted JPEG');};
  const {publisher} = f.makePublisher(failRender); publisher.refresh(); await publisher.drain();
  assert.equal(renders, 0); assert.equal(publisher.lastFailure(), undefined); assert.deepEqual(pair(f.store), cache);
});

test('switching or deleting the actual source during an admitted render preserves the preceding cache pair', {timeout: 60_000}, async t => {
  for (const mutation of ['switch', 'delete'] as const) {
    const f = await fixture(t), cache = await f.renderActual(), next = await f.addAsset(); f.switchCover(next.id);
    const render = f.delayedRender(cache.jpeg); await render.entered;
    assert.equal(render.publisher.isBusy(), true);assert.equal(render.publisher.isRendering(),true,'admitted media still blocks exclusive close');
    const sourceFile = path.join(f.root, next.relativePath), source = readFileSync(sourceFile);
    if (mutation === 'switch') f.switchCover(f.original.id);
    else rmSync(sourceFile);
    const afterMutation = readProjectState(f.store.db);
    render.finish(); await render.publisher.drain();
    assert.equal(render.publisher.isBusy(), false); assert.deepEqual(pair(f.store), cache);
    assert.equal(readProjectCoverCache(f.store.cacheDir, {assetId: next.id, mimeType: next.mimeType, sourceFingerprint: mediaFingerprintToken(mediaReferenceSchema.parse(next.reference))}), null);
    assert.deepEqual(readProjectState(f.store.db), afterMutation, 'the late render cannot repair or publish database records');
    if (mutation === 'switch') assert.deepEqual(readFileSync(sourceFile), source);
    else assert.throws(() => readFileSync(sourceFile), {code: 'ENOENT'}, 'late cover work cannot recreate a removed source');
    if (mutation === 'switch') assert.equal(render.publisher.lastFailure(), undefined);
    else assert.ok(render.publisher.lastFailure() instanceof Error);
  }
});

test('abort waits for an admitted late media result and publishes no cache, SQL or source changes', {timeout: 60_000}, async t => {
  const f = await fixture(t), cache = await f.renderActual(), next = await f.addAsset(); f.switchCover(next.id);
  const library = testProjectAppLibrary(f.store); assert.ok(library);
  const before = readProjectState(f.store.db), changes = [f.store.db, library.db].map(db => db.prepare('SELECT total_changes() AS n').get());
  const media = readdirSync(path.join(f.root, 'media')).sort().map(name => [name, readFileSync(path.join(f.root, 'media', name))]);
  const render = f.delayedRender(cache.jpeg); await render.entered;
  let drained = false;
  const draining = render.publisher.drain().then(() => {drained = true;});
  render.controller.abort(); await setImmediate();
  assert.equal(drained, false, 'drain cannot resolve before the admitted media invocation settles');
  assert.equal(render.publisher.isRendering(),true,'abort cannot claim that admitted media has already drained');
  render.finish(); await draining;
  assert.equal(drained, true); assert.equal(render.publisher.isBusy(), false);assert.equal(render.publisher.isRendering(),false); assert.ok(render.publisher.lastFailure() instanceof Error);
  assert.deepEqual(pair(f.store), cache); assert.deepEqual(readProjectState(f.store.db), before);
  assert.deepEqual([f.store.db, library.db].map(db => db.prepare('SELECT total_changes() AS n').get()), changes);
  assert.deepEqual(readdirSync(path.join(f.root, 'media')).sort().map(name => [name, readFileSync(path.join(f.root, 'media', name))]), media);
});


test('real committed bursts schedule one cover-only read and no synchronous summary work', {timeout:60000}, async t=>{
  const f=await fixture(t),cache=await f.renderActual();
  assert.deepEqual(readProjectCover(f.store,f.store.projectId),{...summary(f.store).summary!.cover!,url:`/api/project-covers/${f.store.projectId}`});
  let reads=0,prepared=0;
  const originalPrepare=f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db,'prepare',((sql:string)=>{
    prepared++;
    assert.doesNotMatch(sql,/SELECT[\s\S]*FROM (?:nodes|edges)\b/iu,'cover refresh never runs the complete project summary');
    return originalPrepare(sql);
  }) as typeof f.store.db.prepare);
  const owned=f.makePublisher(undefined,()=>{reads++;return readProjectCover(f.store,f.store.projectId);});
  const remove=registerProjectTransactionObserver(f.store.db,()=>{
    const before=prepared;owned.publisher.refresh();assert.equal(prepared,before,'transaction observer performs no SQL or row parsing');
  });t.after(remove);
  t.mock.timers.enable({apis:['setTimeout']});
  const nodeId=randomUUID();
  for(let i=0;i<20;i++){
    f.store.tx(()=>f.store.put('nodes',{id:nodeId,projectId:f.store.projectId,type:'text',text:String(i),position:{x:0,y:0}}));
    await Promise.resolve();
  }
  await Promise.resolve();assert.equal(reads,0,'post-COMMIT microtasks do not read a project-size summary');
  assert.equal(owned.publisher.isBusy(),true);assert.equal(owned.publisher.isRendering(),false,'an unadmitted delayed refresh does not block exclusive project close');
  t.mock.timers.tick(1999);await Promise.resolve();assert.equal(reads,0,'the burst waits for the batching delay');
  t.mock.timers.tick(1);await owned.publisher.drain();
  assert.equal(reads,1,'twenty unrelated commits share one narrow candidate read');assert.equal(owned.publisher.isBusy(),false);
  assert.deepEqual(pair(f.store),cache);
  f.store.tx(()=>{const current=record(f.store.get('assets',f.original.id));f.store.put('assets',{...current,name:'Related committed metadata'});});
  assert.equal(reads,1,'a related commit also returns before the candidate read');
  await owned.publisher.drain();assert.equal(reads,2,'close drain flushes the queued related refresh without waiting two seconds');
  assert.deepEqual(pair(f.store),cache);assert.equal(owned.publisher.lastFailure(),undefined);
});

test('abort cancels a queued refresh before source inspection and drain returns with no pending timer',async t=>{
  const f=await fixture(t),cache=await f.renderActual();let reads=0;
  const owned=f.makePublisher(undefined,()=>{reads++;return readProjectCover(f.store,f.store.projectId);});
  t.mock.timers.enable({apis:['setTimeout']});owned.publisher.refresh();assert.equal(owned.publisher.isBusy(),true);
  owned.controller.abort();await owned.publisher.drain();t.mock.timers.tick(2000);await Promise.resolve();
  assert.equal(reads,0);assert.equal(owned.publisher.isBusy(),false);assert.equal(owned.publisher.isRendering(),false);assert.deepEqual(pair(f.store),cache);
});
