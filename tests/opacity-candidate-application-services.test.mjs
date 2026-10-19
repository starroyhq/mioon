import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Codec transport alone is synthetic. File import, hash/inode fences, SQLite,
// project hydration, the actual timeline mutations and service lifetime run.
let childAttempts = 0;
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) mock.method(cp, name, () => {childAttempts++; throw Error('No native child is permitted in application service tests');});
syncBuiltinESMExports();
const key = Symbol.for('mioon.test.opacity-application-import-codec');
let gate = null, probeCount = 0;
globalThis[key] = {async run(command, argv, options = {}) {
  assert.equal(command, 'ffprobe'); probeCount++;
  options.beforeEffect?.();
  if (gate) await gate(argv.at(-1), options);
  options.beforeEffect?.();
  return JSON.stringify({streams: [{index:0, codec_type:'video', codec_name:'h264', width:64, height:48, pix_fmt:'yuv420p',
    r_frame_rate:'30/1', avg_frame_rate:'30/1', duration:'1', sample_aspect_ratio:'1:1', time_base:'1/30000'}], format:{format_name:'mov,mp4', duration:'1'}});
}};
const runtimeUrl = new URL('../packages/business/src/media-runtime.ts', import.meta.url).href;
const actualUrl = runtimeUrl + '?opacity-application-actual-runtime';
const hook = registerHooks({load(url, context, next) {
  if (url === runtimeUrl) return {format:'module',shortCircuit:true,source:`export * from ${JSON.stringify(actualUrl)};export const run=(...args)=>globalThis[Symbol.for("mioon.test.opacity-application-import-codec")].run(...args);`};
  return next(url, context);
}});
const {openNewOpacityCandidateApplicationStore, openOpacityCandidateStore, isOpacityCandidateApplicationStore} = await import('../packages/business/src/opacity-candidate-store.ts');
const {createOpacityCandidateApplicationServices, createOpacityCandidateServices} = await import('../packages/business/src/opacity-candidate-services.ts');
const {createServices} = await import('../packages/business/src/services.ts');
const {openStore} = await import('../packages/business/src/db.ts');
after(() => {assert.equal(childAttempts,0);hook.deregister();delete globalThis[key];mock.restoreAll();syncBuiltinESMExports();});
const code = expected => error => error?.code === expected;
const bytes = Buffer.concat([Buffer.from([0,0,0,16]),Buffer.from('ftypisom'),Buffer.from('synthetic isolated bytes; never native decoded')]);
const importInput = projectId => ({projectId,name:'Synthetic source.mp4',mimeType:'video/mp4',dataBase64:bytes.toString('base64')});
function fixture(t, {ordinary = false} = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-app-services-')), root = path.join(parent,'new42');
  const store = ordinary ? (fs.mkdirSync(root,{mode:0o700}),openStore(root)) : openNewOpacityCandidateApplicationStore(root);
  const services = ordinary ? createServices(store,new Map()) : createOpacityCandidateApplicationServices(store);
  t.after(async () => {gate=null;await services.drain();store.close();fs.rmSync(parent,{recursive:true,force:true});});
  return {parent,root,store,services};
}
test('application grant requires a newly created exact42 store and cannot be reconstituted', async t => {
  const f = fixture(t);assert.equal(isOpacityCandidateApplicationStore(f.store),true);
  assert.equal(isOpacityCandidateApplicationStore({...f.store}),false);
  assert.throws(() => createOpacityCandidateApplicationServices({...f.store}),code('RESTORE_OPERATION_UNAVAILABLE'));
  assert.throws(() => openNewOpacityCandidateApplicationStore(f.root),{code:'EEXIST'});
  const root = path.join(f.parent,'ordinary42'), store = openOpacityCandidateStore(root);
  try {assert.equal(isOpacityCandidateApplicationStore(store),false);assert.throws(() => createOpacityCandidateApplicationServices(store),code('RESTORE_OPERATION_UNAVAILABLE'));
    await assert.rejects(createOpacityCandidateServices(store).call('project.create',{name:'No grant'}),code('RESTORE_OPERATION_UNAVAILABLE'));
  } finally {store.close();}
});
test('fresh42 actual services create/hydrate project, import managed bytes, add clip, save opacity and undo/redo', async t => {
  const f=fixture(t), project=await f.services.call('project.create',{name:'Isolated candidate'});
  let page=await f.services.call('project.get',{projectId:project.id});
  assert.equal(page.timeline.revision,1);assert.equal(page.timeline.clips.length,0);assert.equal(page.timeline.tracks.length,3);
  assert.deepEqual(page.assets,[]);assert.deepEqual(page.exports,[]);assert.equal(page.timelineHistory.canUndo,false);
  assert.deepEqual(await f.services.call('provider.list',{}),[]);
  const asset=await f.services.call('asset.import',importInput(project.id));
  assert.equal(asset.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(fs.readFileSync(path.join(f.root,asset.relativePath)).equals(bytes),true);
  assert.equal((await f.services.call('asset.get',{assetId:asset.id})).id,asset.id);
  assert.equal((await f.services.call('asset.list',{projectId:project.id})).length,1);
  let timeline=await f.services.call('timeline.clip.add',{projectId:project.id,requestId:randomUUID(),expectedRevision:1,trackId:page.timeline.tracks[0].id,assetId:asset.id,startFrame:0,durationFrames:12});
  const curve={profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:12,opacity:1}]};
  timeline=await f.services.call('timeline.clip.update',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision,clipId:timeline.clips[0].id,patch:{opacityEnvelope:curve}});
  assert.deepEqual(timeline.clips[0].opacityEnvelope,curve);
  timeline=await f.services.call('timeline.undo',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision});assert.equal(Object.hasOwn(timeline.clips[0],'opacityEnvelope'),false);
  timeline=await f.services.call('timeline.redo',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision});assert.deepEqual(timeline.clips[0].opacityEnvelope,curve);
  page=await f.services.call('project.get',{projectId:project.id});assert.deepEqual(page.timeline,timeline);assert.equal(page.assets[0].id,asset.id);
  assert.deepEqual(await f.services.call('export.list',{projectId:project.id}),[]);
  await assert.rejects(f.services.call('generation.submit',{}),code('RESTORE_OPERATION_UNAVAILABLE'));
});
test('a pre-aborted application call cannot create a project or initialize a missing timeline', async t => {
  const f=fixture(t), project=await f.services.call('project.create',{name:'No cancelled writes'}), controller=new AbortController();controller.abort();
  const projects=f.store.list('projects'), timelines=f.store.list('timelines');
  await assert.rejects(f.services.call('project.create',{name:'Must not be created'},{signal:controller.signal}),code('OPERATION_CANCELLED'));
  await assert.rejects(f.services.call('timeline.get',{projectId:project.id},{signal:controller.signal}),code('OPERATION_CANCELLED'));
  assert.deepEqual(f.store.list('projects'),projects);assert.deepEqual(f.store.list('timelines'),timelines);
});
test('shared ordinary48 importer retains successful bytes/type rejection and cleanup without candidate grant', async t => {
  const f=fixture(t,{ordinary:true}), project=await f.services.call('project.create',{name:'Ordinary unchanged default'});
  assert.equal(f.store.db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,48);
  assert.equal(isOpacityCandidateApplicationStore(f.store),false);
  const imported=await f.services.call('asset.import',importInput(project.id));assert.equal(imported.mimeType,'video/mp4');assert.equal(imported.provenance,'user-import');
  const before=probeCount;
  await assert.rejects(f.services.call('asset.import',{...importInput(project.id),mimeType:'image/png'}),code('INVALID_MEDIA'));assert.equal(probeCount,before);
  assert.equal(fs.readdirSync(path.join(f.root,'media')).length,1);
  gate=async()=>{throw Error('synthetic decoder refusal');};
  await assert.rejects(f.services.call('asset.import',importInput(project.id)),code('INVALID_MEDIA'));assert.equal(fs.readdirSync(path.join(f.root,'media')).length,1);
});
test('candidate import refuses project identity replacement before publication and removes its owned source', async t => {
  const f=fixture(t), project=await f.services.call('project.create',{name:'Pinned project'});
  gate=async()=>{f.store.put('projects',{...project,createdAt:'2026-10-16T23:59:59.000Z'});};
  await assert.rejects(f.services.call('asset.import',importInput(project.id)),code('TIMELINE_SOURCE_UNAVAILABLE'));
  assert.equal(f.store.list('assets',project.id).length,0);assert.deepEqual(fs.readdirSync(path.join(f.root,'media')),[]);
});
test('candidate source replacement is refused without deleting another inode', async t => {
  const f=fixture(t), project=await f.services.call('project.create',{name:'Pinned inode'}), replacement=Buffer.from('foreign replacement must remain');
  gate=async file=>{fs.unlinkSync(file);fs.writeFileSync(file,replacement);};
  await assert.rejects(f.services.call('asset.import',importInput(project.id)),code('TIMELINE_SOURCE_UNAVAILABLE'));
  assert.equal(f.store.list('assets',project.id).length,0);
  const leaves=fs.readdirSync(path.join(f.root,'media'));assert.equal(leaves.length,1);assert.equal(fs.readFileSync(path.join(f.root,'media',leaves[0])).equals(replacement),true);
});
test('candidate drain waits for its live import and propagates its cancellation failure', async t => {
  const f=fixture(t), project=await f.services.call('project.create',{name:'Closing import'});
  let entered,release;const atProbe=new Promise(resolve=>{entered=resolve;}), held=new Promise(resolve=>{release=resolve;});
  gate=async()=>{entered();await held;};
  const running=f.services.call('asset.import',importInput(project.id));const observed=assert.rejects(running,error=>typeof error?.code==='string');
  await atProbe;const draining=f.services.drain();const drained=assert.rejects(draining,error=>typeof error?.code==='string');release();
  await Promise.all([observed,drained]);assert.equal(f.store.list('assets',project.id).length,0);assert.deepEqual(fs.readdirSync(path.join(f.root,'media')),[]);
});
