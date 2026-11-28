import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,chmodSync,closeSync,createReadStream,existsSync,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,renameSync,rmSync,statSync,truncateSync,unlinkSync,utimesSync,writeFileSync,writeSync,type BigIntStats} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {realpathSync} from 'node:fs';
import {createProjectFile,openProjectStore} from '../packages/business/src/project-file/index.ts';
import {registerProjectMediaStore,registeredProjectAssetReferences} from '../packages/business/src/project-media-storage.ts';
import {outputFileIdentity,registerProjectOutputAdmission,sameOutputIdentity} from '../packages/business/src/project-output-owner.ts';
import {createOutputArtifactStage,writeOutputArtifact} from '../packages/business/src/output-artifact-storage.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {publishProjectOutput,inspectProjectOutput,readPublishedProjectOutput,markProjectOutputRegistered,assertPublishedProjectOutput,registerVerifiedProjectOutputs,isPublishedProjectOutput,restorePublishedProjectOutput,setProjectOutputPublicationTestHooks,discardUnregisteredFatOutput} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput,PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {png,pngChunk} from './helpers/timeline-image-fixtures.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {canonicalJson} from '../packages/business/src/project-versions/document.ts';
import {mountProjectVolumeFixture} from './helpers/project-volume-fixture.ts';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bytes=png({rgba:false,extra:[pngChunk('tEXt',Buffer.from('comment\0'+'x'.repeat(150000)))]});
function describeOutputStat(info:BigIntStats){
 return {...outputFileIdentity(info),size:String(info.size),nlink:String(info.nlink),mtimeNs:String(info.mtimeNs),ctimeNs:String(info.ctimeNs)};
}
function fixture(t:TestContext,kind:ProjectOutputInput['targetKind']='generated',volume?:string){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-output-pub-'));
 const projectDir=path.join(volume??root,volume?randomUUID():'movie');mkdirSync(projectDir,{mode:0o755});
 const projectFile=path.join(projectDir,'movie.mioon'),projectId=createProjectFile(projectFile);
 const store=openProjectStore({projectFile,locate:()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')})});
 store.put('projects',{id:projectId,name:'Publication fixture',revision:1});const release=registerProjectMediaStore(store);
 t.after(()=>{release();try{store.close();}finally{rmSync(root,{recursive:true,force:true});}});
 const stages=path.join(store.tempDir,'verified-artifacts');ensurePrivateDirectory(stages,{create:true});const stageFile=path.join(stages,`${randomUUID()}.png`);writeFileSync(stageFile,bytes,{mode:0o600});
 const input:ProjectOutputInput={owner:{kind:kind==='exports'?'export':kind==='assets'?'import':'image',id:randomUUID(),requestId:randomUUID(),inputHash:'a'.repeat(64)},assetId:randomUUID(),targetKind:kind,stageFile,mimeType:'image/png',sha256:sha(bytes),sizeBytes:bytes.length};
 const key=()=>({owner:input.owner,assetId:input.assetId});const count=()=>Number(store.db.prepare('SELECT total_changes() AS n').get()!.n);
 const register=(output:PublishedProjectOutput)=>{const{relativePath:_relative,...stored}=output;return store.put('assets',{id:output.publication.assetId,projectId,name:'Published.png',mimeType:input.mimeType,width:64,height:64,...stored,provenance:kind==='exports'?'export':'generated',createdAt:new Date().toISOString()});};
 return{root,projectDir,projectFile,projectId,store,input,key,count,register};
}

function useUmask(t: TestContext, mask: number): void {
 const original = process.umask(mask);
 t.after(() => {process.umask(original);});
}
const permissionBits = (file: string): number => statSync(file).mode & 0o777;

test('staged export artifacts larger than 64 MiB are published with their verified size and hash', async t => {
 const {store, projectDir, input} = fixture(t, 'exports');
 const sizeBytes = 64 * 1024 ** 2 + 1;
 const stageFile = createOutputArtifactStage(store, input.owner, 'export');
 writeFileSync(stageFile, mp4HeaderFixture('Large export'), {mode: 0o600});
 truncateSync(stageFile, sizeBytes);
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(stageFile)) hash.update(chunk);
 const sha256 = hash.digest('hex');
 const artifact = writeOutputArtifact(store, {owner: input.owner, kind: 'export', sourceIdentity: input.owner.inputHash,
  stageFile, info: {sizeBytes, sha256, width: 1280, height: 720, duration: 1800, hasVideo: true, hasAudio: true}}, () => {});
 const output = await publishProjectOutput(store, {...input, assetId: artifact.assetId, publicationId: artifact.publicationId,
  stageFile, mimeType: 'video/mp4', sizeBytes, sha256});
 assert.equal(output.reference.sizeBytes, sizeBytes);
 assert.equal(output.reference.fullSha256, sha256);
 assert.equal(statSync(path.join(projectDir, output.relativePath)).size, sizeBytes);
});

for (const {kind, mask, forceCopy} of [
 {kind: 'exports', mask: 0o022, forceCopy: false},
 {kind: 'generated', mask: 0o022, forceCopy: false},
 {kind: 'generated', mask: 0o002, forceCopy: true},
 {kind: 'assets', mask: 0o002, forceCopy: true},
 {kind: 'exports', mask: 0o077, forceCopy: false},
] as const) test(`${kind} publication honors umask ${mask.toString(8)} with a private stage`, async t => {
 const f = fixture(t, kind), expectedMode = (kind==='assets'?0o644:0o666) & ~mask;
 useUmask(t, mask);
 let createdMode: number | undefined;
 setProjectOutputPublicationTestHooks(f.store, {forceCopy, fault(point, proof, workingFile) {
  if (point === 'after_target_create') {
   const finalFile = path.join(f.projectDir, proof.relativePath);
   if (kind === 'exports') {
    assert.ok(workingFile);
    assert.equal(existsSync(finalFile), false);
   } else assert.equal(workingFile,undefined,'keep the existing ordinary-volume publication path');
   createdMode = permissionBits(workingFile ?? finalFile);
   assert.equal(permissionBits(f.input.stageFile), 0o600);
  }
 }});
 const output = await publishProjectOutput(f.store, f.input);
 const file = path.join(f.projectDir, output.relativePath);
 assert.equal(permissionBits(file), expectedMode);
 assert.equal(permissionBits(f.input.stageFile), 0o600);
 assert.notEqual(statSync(file, {bigint: true}).ino, statSync(f.input.stageFile, {bigint: true}).ino);
 assert.equal(createdMode, expectedMode);
 f.store.tx(() => {assertPublishedProjectOutput(f.store, output.publication); f.register(output);});
 await markProjectOutputRegistered(f.store, output.publication);
 assert.equal(permissionBits(file), expectedMode);
 assert.deepEqual(readFileSync(file), bytes);
});

test('replaying an existing publication preserves its earlier permissions', async t => {
 const f = fixture(t, 'exports');
 useUmask(t, 0o077);
 linkLegacyStage(f);
 const output = await publishProjectOutput(f.store, f.input);
 const file = path.join(f.projectDir, output.relativePath);
 f.register(output);
 await markProjectOutputRegistered(f.store, output.publication);
 assert.equal(permissionBits(file), 0o600);
 process.umask(0o022);
 assert.deepEqual(await publishProjectOutput(f.store, f.input), output);
 assert.equal(permissionBits(file), 0o600);
});

test('restoring a missing export honors the current umask with a private stage', async t => {
 const f = fixture(t, 'exports');
 useUmask(t, 0o077);
 const output = await publishProjectOutput(f.store, f.input), asset = f.register(output);
 await markProjectOutputRegistered(f.store, output.publication);
 const file = path.join(f.projectDir, output.relativePath);
 unlinkSync(file);
 process.umask(0o002);
 const stage = path.join(path.dirname(f.input.stageFile), 'restore.png');
 writeFileSync(stage, bytes, {mode: 0o600});
 let createdMode: number | undefined;
 setProjectOutputPublicationTestHooks(f.store, {fault(point) {
  if (point === 'after_target_create') createdMode = permissionBits(file);
 }});
 const restored = await restorePublishedProjectOutput(f.store, {asset, stageFile: stage});
 assert.deepEqual(restored.publication, output.publication);
 assert.equal(permissionBits(file), 0o664);
 assert.equal(createdMode, 0o664);
 assert.equal(permissionBits(stage), 0o600);
 assertPublishedProjectOutput(f.store, output.publication);
});

function changeCtimeOnly(file: string): void {
 const before = statSync(file, {bigint: true}), mode = Number(before.mode & 0o777n);
 for (let attempt = 0; attempt < 5; attempt++) {
  chmodSync(file, mode ^ 0o200);
  chmodSync(file, mode);
  const after = statSync(file, {bigint: true});
  for (const field of ['dev','ino','birthtimeNs','size','mode','mtimeNs'] as const) assert.equal(after[field], before[field], field);
  if (after.ctimeNs !== before.ctimeNs) return;
  // The read hook fixes the race window. Only a coarse filesystem clock can
  // require waiting for the next metadata timestamp before leaving the hook.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
 }
 assert.fail('the fixture must change ctime');
}

async function outputHandlePrototype(probe: string): Promise<Pick<FileHandle, 'read' | 'sync' | 'write'>> {
 const sample = await open(probe, 'r'), prototype = Object.getPrototypeOf(sample) as Pick<FileHandle, 'read' | 'sync' | 'write'>;
 await sample.close();
 return prototype;
}
function targetInfo(handle: FileHandle, file: string) {
 if (!file) return;
 const info = statSync(file, {bigint: true, throwIfNoEntry: false});
 if (!info) return;
 const opened = fstatSync(handle.fd, {bigint: true});
 if (opened.dev === info.dev && opened.ino === info.ino && opened.birthtimeNs === info.birthtimeNs) return info;
}

/** Run a file change after the last byte of a targeted descriptor read. */
async function afterFullOutputRead(t: TestContext, probe: string, target: () => string, effect: (file: string, buffer: unknown) => void): Promise<void> {
 const prototype = await outputHandlePrototype(probe), original = prototype.read;
 t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
  const result = await Reflect.apply(original, this, args) as {bytesRead: number};
  const file = target(), position = args[3];
  if (typeof position === 'number') {
   const info = targetInfo(this, file);
   if (info && position + result.bytesRead === Number(info.size)) effect(file, args[0]);
  }
  return result;
 });
}

function observePublicationTarget(f: ReturnType<typeof fixture>, afterIntent?: (file: string) => void): () => string {
 let target = '';
 setProjectOutputPublicationTestHooks(f.store, {fault(point, proof) {
  if (point === 'after_intent') {
   target = path.join(f.projectDir, proof.relativePath);
   afterIntent?.(target);
  }
 }});
 return () => target;
}

function linkLegacyStage(f: ReturnType<typeof fixture>): () => string {
 // Simulate the old producer linking its completed stage before target ACK.
 return observePublicationTarget(f, file => linkSync(f.input.stageFile, file));
}

for (const kind of ['exports','generated'] as const) test(`${kind} publication accepts ctime-only changes during the final full read`, async t => {
 const f = fixture(t, kind);
 let target = '', verificationFile = '';
 setProjectOutputPublicationTestHooks(f.store, {fault(point, proof, workingFile) {
  if (point === 'after_intent') target = path.join(f.projectDir, proof.relativePath);
  if (point === 'after_target_create') verificationFile = workingFile ?? target;
 }});
 let changed = false;
 await afterFullOutputRead(t, f.input.stageFile, () => verificationFile, file => {
  if (changed) return;
  if (kind === 'exports') assert.equal(existsSync(target), false);
  changeCtimeOnly(file);
  changed = true;
 });
 const output = await publishProjectOutput(f.store, f.input);
 assert.ok(changed);
 assert.equal(path.join(f.projectDir, output.relativePath), target);
 assert.equal(output.sha256, f.input.sha256);
 assert.deepEqual(readFileSync(target), bytes);
});

test('publication accepts ctime-only changes during the private stage hash', async t => {
 const f = fixture(t);
 let changed = false;
 await afterFullOutputRead(t, f.input.stageFile, () => f.input.stageFile, file => {
  if (changed) return;
  assert.equal(statSync(file).nlink, 1, 'the change must precede publication');
  changeCtimeOnly(file);
  changed = true;
 });
 const output = await publishProjectOutput(f.store, f.input);
 assert.ok(changed);
 assert.deepEqual(readFileSync(path.join(f.projectDir, output.relativePath)), bytes);
});

for (const location of ['stage','final'] as const) test(`publication accepts ctime-only changes during ${location} file sync`, async t => {
 const f = fixture(t, location === 'final' ? 'assets' : 'generated');
 const target = location === 'stage' ? () => f.input.stageFile : observePublicationTarget(f);
 const prototype = await outputHandlePrototype(f.input.stageFile), original = prototype.sync;
 let changed = false;
 t.mock.method(prototype, 'sync', async function(this: FileHandle) {
  await original.call(this);
  const file = target();
  if (!changed && targetInfo(this, file)) {
   changeCtimeOnly(file);
   changed = true;
  }
 });
 const output = await publishProjectOutput(f.store, f.input);
 assert.ok(changed);
 assert.deepEqual(readFileSync(path.join(f.projectDir, output.relativePath)), bytes);
});

test('publication accepts ctime-only changes while computing its media reference', async t => {
 const f = fixture(t), target = observePublicationTarget(f);
 let changed = false;
 await afterFullOutputRead(t, f.input.stageFile, target, (file, buffer) => {
  // Media reference sampling uses Uint8Array, while the publication hash uses Buffer.
  if (changed || Buffer.isBuffer(buffer)) return;
  changeCtimeOnly(file);
  changed = true;
 });
 const output = await publishProjectOutput(f.store, f.input);
 assert.ok(changed);
 assert.equal(output.reference.fullSha256, f.input.sha256);
 assert.equal(output.reference.sampledSha256, f.input.sha256);
});

const frozenTime = 1_700_000_000;
function changeAlreadyReadByte(file: string): void {
 changeCtimeOnly(file);
 const offset = 1024, fd = openSync(file, 'r+');
 try {assert.equal(writeSync(fd, Buffer.from([bytes[offset]! ^ 1]), 0, 1, offset), 1);}
 finally {closeSync(fd);}
}

for (const [change, field] of [['already-read byte','hash'],['size','size'],['same-byte replacement','identity'],['mtime','mtime']] as const)
test(`publication rejects a changed ${change} during the final read`, async t => {
 const f = fixture(t, 'assets'), target = observePublicationTarget(f), changesBefore = f.count();
 utimesSync(f.input.stageFile, frozenTime, frozenTime);
 let changed = false;
 await afterFullOutputRead(t, f.input.stageFile, target, file => {
  if (changed) return;
  changed = true;
  const before = statSync(file, {bigint: true});
  assert.equal(before.mtimeNs, BigInt(frozenTime) * 1_000_000_000n);
  if (change === 'already-read byte') {
   changeAlreadyReadByte(file);
  } else if (change === 'size') {
   appendFileSync(file, Buffer.from([0]));
  } else if (change === 'same-byte replacement') {
   renameSync(file, file + '.replaced');
   writeFileSync(file, bytes);
  }
  // Moving mtime earlier on APFS may also move the creation time.
  utimesSync(file, frozenTime, change === 'mtime' ? frozenTime + 1 : frozenTime);
  const after = statSync(file, {bigint: true});
  assert.equal(after.mtimeNs === before.mtimeNs, change !== 'mtime');
  assert.equal(after.ino === before.ino, change !== 'same-byte replacement');
  if (change !== 'same-byte replacement') assert.equal(after.birthtimeNs, before.birthtimeNs);
  assert.equal(after.size === before.size, change !== 'size');
  assert.equal(readFileSync(file).equals(bytes), change === 'same-byte replacement' || change === 'mtime');
 });
 await assert.rejects(publishProjectOutput(f.store, f.input), {code: 'INVALID_MEDIA', details: {point: 'final-hash', field}});
 assert.ok(changed);
 assert.equal(f.count(), changesBefore);
 assert.equal(f.store.get('assets', f.input.assetId), null);
});

test('publication rejects an output whose ctime keeps changing across complete hashes', async t => {
 const f = fixture(t), target = observePublicationTarget(f);
 let changes = 0;
 await afterFullOutputRead(t, f.input.stageFile, target, file => {
  assert.ok(++changes < 8, 'metadata retries must stop');
  changeCtimeOnly(file);
 });
 await assert.rejects(publishProjectOutput(f.store, f.input), {code: 'INVALID_MEDIA', details: {point: 'final-hash', field: 'ctime'}});
 assert.ok(changes > 1, 'the output must be checked again after ctime changes');
 assert.deepEqual(readFileSync(target()), bytes);
});

for (const changeBytes of [false,true]) test(`reading published bytes ${changeBytes ? 'rejects an already-read byte change with restored mtime' : 'tolerates a ctime-only change'}`, async t => {
 const f = fixture(t, 'assets');
 utimesSync(f.input.stageFile, frozenTime, frozenTime);
 const output = await publishProjectOutput(f.store, f.input), file = path.join(f.projectDir, output.relativePath);
 let changed = false;
 await afterFullOutputRead(t, file, () => file, (target, buffer) => {
  // The bounded read fills a full-size Buffer after the inspection hashes.
  if (changed || !Buffer.isBuffer(buffer) || buffer.length !== bytes.length) return;
  if (changeBytes) {
   changeAlreadyReadByte(target);
   utimesSync(target, frozenTime, frozenTime);
  } else changeCtimeOnly(target);
  changed = true;
 });
 const read = readPublishedProjectOutput(f.store, f.key(), {maxBytes: bytes.length});
 if (changeBytes) await assert.rejects(read, {code: 'INVALID_MEDIA', details: {point: 'read-published', field: 'hash'}});
 else assert.deepEqual(await read, bytes);
 assert.ok(changed);
});

for (const changeBytes of [false,true]) test(`registration after ctime drift ${changeBytes ? 'rejects changed bytes' : 'verifies complete bytes outside the transaction and commits'}`, async t => {
 const f = fixture(t, 'exports'), before = f.count();
 linkLegacyStage(f);
 utimesSync(f.input.stageFile, frozenTime, frozenTime);
 const output = await publishProjectOutput(f.store, f.input), file = path.join(f.projectDir, output.relativePath);
 let attempts = 0, fullHashes = 0;
 await afterFullOutputRead(t, file, () => file, (_target, buffer) => {
  assert.equal(f.store.db.isTransaction, false, 'complete file reads must run after rollback');
  if (Buffer.isBuffer(buffer)) fullHashes++;
 });
 const registration = registerVerifiedProjectOutputs(f.store, {}, () => f.store.tx(() => {
  assert.equal(f.store.db.isTransaction, true);
  if (++attempts === 1) {
   if (changeBytes) {
    changeAlreadyReadByte(file);
    utimesSync(file, frozenTime, frozenTime);
   } else changeCtimeOnly(file);
  }
  assertPublishedProjectOutput(f.store, output.publication);
  f.register(output);
 }));
 if (changeBytes) {
  await assert.rejects(registration, {code: 'INVALID_MEDIA', details: {point: 'final-hash', field: 'hash'}});
  assert.equal(attempts, 1);
  assert.equal(f.count(), before);
  assert.equal(f.store.get('assets', f.input.assetId), null);
 } else {
  await registration;
  assert.equal(attempts, 2);
  assert.ok(f.store.get('assets', f.input.assetId));
  assert.ok(fullHashes > 0);
  await markProjectOutputRegistered(f.store, output.publication);
 }
 assert.ok(fullHashes > 0);
});

test('a single transaction registers multiple outputs that each had a ctime-only change', async t => {
 const f = fixture(t), outputs = [await publishProjectOutput(f.store, f.input)];
 for (let i = 0; i < 2; i++) {
  const assetId = randomUUID(), stageFile = path.join(path.dirname(f.input.stageFile), assetId + '.png');
  writeFileSync(stageFile, bytes, {mode: 0o600});
  outputs.push(await publishProjectOutput(f.store, {...f.input, assetId, stageFile}));
 }
 for (const output of outputs) changeCtimeOnly(path.join(f.projectDir, output.relativePath));
 await registerVerifiedProjectOutputs(f.store, {}, () => f.store.tx(() => {
  for (const output of outputs) assertPublishedProjectOutput(f.store, output.publication);
  for (const output of outputs) f.register(output);
 }));
 assert.equal(f.store.list('assets', f.projectId).length, outputs.length);
});

for(const forceCopy of [false,true])test(`exclusive ${forceCopy?'cross-volume copy':'link'} publishes ordinary files and only removes its registered private stage`,async t=>{
 const kind=forceCopy?'generated':'assets',f=fixture(t,kind),before=f.count();setProjectOutputPublicationTestHooks(f.store,{forceCopy});
 const output=await publishProjectOutput(f.store,f.input);assert.match(output.relativePath,forceCopy?/^生成\//u:/^素材\//u);assert.equal(f.count(),before);
 if(!forceCopy){
  const target=path.join(f.projectDir,output.relativePath);
  assert.equal(statSync(target).nlink,2);
  assert.equal(permissionBits(target),permissionBits(f.input.stageFile));
 }
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);assert.equal(statSync(f.projectDir).mode&0o777,0o755);
 assert.deepEqual(await publishProjectOutput(f.store,f.input),output);assert.deepEqual(await readPublishedProjectOutput(f.store,f.key(),{maxBytes:bytes.length}),bytes);
 const sentinels=[path.join(f.projectDir,'keep.png'),path.join(f.store.localDir,'keep'),path.join(f.store.cacheDir,'keep'),path.join(f.store.tempDir,'keep')];for(const file of sentinels)writeFileSync(file,'untouched',{mode:0o600});
 f.store.tx(()=>{assertPublishedProjectOutput(f.store,output.publication);f.register(output);});await markProjectOutputRegistered(f.store,output.publication);
 assert.equal(existsSync(f.input.stageFile),false);for(const file of sentinels)assert.equal(readFileSync(file,'utf8'),'untouched');
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);
 assert.equal(isPublishedProjectOutput(f.store.get('assets',f.input.assetId),{projectId:f.projectId,owner:f.input.owner,targetKind:kind}),true);
});

for(const sameBytes of [false,true])test(`a preexisting ${sameBytes?'same-byte':'different-byte'} target is preserved rather than claimed`,async t=>{
 const f=fixture(t),hostile=sameBytes?bytes:Buffer.from('user file');let collision='';
 setProjectOutputPublicationTestHooks(f.store,{fault:(point,proof)=>{if(point==='after_intent'){collision=path.join(f.projectDir,proof.relativePath);writeFileSync(collision,hostile,{mode:0o644,flag:'wx'});}}});
 const output=await publishProjectOutput(f.store,f.input);assert.notEqual(path.join(f.projectDir,output.relativePath),collision);assert.deepEqual(readFileSync(collision),hostile);assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);
});

for(const name of ['CON.png','.hidden.png','e\u0301 预演🎬.png','过长'.repeat(100)+'.png'])test(`publication safely bounds and normalizes display name ${name.slice(0,16)}`,async t=>{
 const f=fixture(t),output=await publishProjectOutput(f.store,{...f.input,displayName:name}),base=path.basename(output.relativePath);
 assert.equal(base,base.normalize('NFC'));assert.ok(Buffer.byteLength(base)<=255);assert.ok(!base.startsWith('.'));assert.doesNotMatch(base,/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);
});

for(const point of ['after_intent','after_target_create','after_target_identity','after_copy_chunk','after_final'] as const)test(`durable copy recovery at ${point} never registers or overwrites an uncertain file`,async t=>{
 const f=fixture(t),sentinel=Error(point),before=f.count();let final='';const remove=setProjectOutputPublicationTestHooks(f.store,{forceCopy:true,fault:(seen,proof)=>{final=path.join(f.projectDir,proof.relativePath);if(seen===point)throw sentinel;}});
 await assert.rejects(publishProjectOutput(f.store,f.input),error=>error===sentinel);remove();assert.equal(f.count(),before);assert.equal(f.store.get('assets',f.input.assetId),null);assert.deepEqual(readFileSync(f.input.stageFile),bytes);
 const previous=existsSync(final)?{bytes:readFileSync(final),ino:statSync(final,{bigint:true}).ino}:null;
 setProjectOutputPublicationTestHooks(f.store,{forceCopy:true});const output=await publishProjectOutput(f.store,f.input);
 if(previous){assert.deepEqual(readFileSync(final),previous.bytes);assert.equal(statSync(final,{bigint:true}).ino,previous.ino);if(previous.bytes.length!==bytes.length)assert.notEqual(path.join(f.projectDir,output.relativePath),final);}
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);assert.equal(output.publication.assetId,f.input.assetId);assert.equal(f.count(),before);
});

test('link recovery accepts only its intent-bound nlink=2 file; replacing it with identical bytes fails closed',async t=>{
 const f=fixture(t,'assets'),sentinel=Error('final');const remove=setProjectOutputPublicationTestHooks(f.store,{fault:point=>{if(point==='after_final')throw sentinel;}});
 await assert.rejects(publishProjectOutput(f.store,f.input),e=>e===sentinel);remove();assert.equal(statSync(f.input.stageFile).nlink,2);
 const output=await inspectProjectOutput(f.store,f.key());assert.ok(output);assert.deepEqual(await readPublishedProjectOutput(f.store,f.key(),{maxBytes:bytes.length}),bytes);
 const file=path.join(f.projectDir,output.relativePath),old=file+'.owned';renameSync(file,old);writeFileSync(file,bytes,{mode:0o644});
 await assert.rejects(publishProjectOutput(f.store,f.input));assert.deepEqual(readFileSync(old),bytes);assert.deepEqual(readFileSync(file),bytes);assert.equal(f.store.get('assets',f.input.assetId),null);
});

test('the result transaction rejects in-place byte mutation even when size and inode remain unchanged',async t=>{
 const f=fixture(t),output=await publishProjectOutput(f.store,f.input),file=path.join(f.projectDir,output.relativePath),before=f.count();
 const changed=Buffer.from(bytes);changed[changed.length-20]=changed[changed.length-20]!^1;writeFileSync(file,changed);
 assert.throws(()=>f.store.tx(()=>{assertPublishedProjectOutput(f.store,output.publication);f.register(output);}));assert.equal(f.count(),before);assert.equal(f.store.get('assets',f.input.assetId),null);assert.deepEqual(readFileSync(file),changed);
});

test('owner abort and exact sentinel precede any project effect; directories cannot be silently replaced',async t=>{
 const f=fixture(t),controller=new AbortController(),sentinel=Error('owner aborted');controller.abort(sentinel);const before=f.count();
 await assert.rejects(publishProjectOutput(f.store,f.input,{signal:controller.signal}),e=>e===sentinel);assert.equal(existsSync(path.join(f.projectDir,'生成')),false);assert.equal(f.count(),before);
 setProjectOutputPublicationTestHooks(f.store,{fault:point=>{if(point==='after_intent'){renameSync(path.join(f.projectDir,'生成'),path.join(f.projectDir,'old-generated'));mkdirSync(path.join(f.projectDir,'生成'),{mode:0o755});}}});
 await assert.rejects(publishProjectOutput(f.store,f.input));assert.deepEqual(readdirSync(path.join(f.projectDir,'生成')),[]);assert.deepEqual(readFileSync(f.input.stageFile),bytes);assert.equal(f.count(),before);
});

test('a moved project is paused without creating a replacement project directory',async t=>{
 const f=fixture(t),moved=path.join(f.root,'moved');renameSync(f.projectDir,moved);
 await assert.rejects(publishProjectOutput(f.store,f.input));assert.equal(existsSync(f.projectDir),false);assert.deepEqual(readFileSync(f.input.stageFile),bytes);
});
test('application ownership is rechecked by every asynchronous publisher before project effects',async t=>{
 const f=fixture(t),sentinel=Object.assign(Error('application owner lost'),{code:'ENOENT',syscall:'stat',path:'owner-sentinel-path'}),before=f.count();
 const release=registerProjectOutputAdmission(f.store,()=>{throw sentinel;});
 await assert.rejects(publishProjectOutput(f.store,f.input),error=>error===sentinel);release();
 assert.equal(existsSync(path.join(f.projectDir,'生成')),false);assert.equal(existsSync(path.join(f.store.tempDir,'publications')),false);assert.equal(f.count(),before);assert.deepEqual(readFileSync(f.input.stageFile),bytes);
});

test('held database aliases and insecure stages cannot become outputs',async t=>{
 const f=fixture(t),alias=path.join(path.dirname(f.input.stageFile),'database.png');linkSync(f.projectFile,alias);
 await assert.rejects(publishProjectOutput(f.store,{...f.input,stageFile:alias}));assert.equal(existsSync(path.join(f.projectDir,'生成')),false);assert.equal(f.store.get('assets',f.input.assetId),null);
 unlinkSync(alias);chmodSync(path.dirname(f.input.stageFile),0o755);await assert.rejects(publishProjectOutput(f.store,f.input),{code:'STORAGE_PRIVATE_REQUIRED'});chmodSync(path.dirname(f.input.stageFile),0o700);
});

test('publication collisions are bounded and do not destroy the complete artifact',async t=>{
 const f=fixture(t),remove=setProjectOutputPublicationTestHooks(f.store,{forceCopy:true,fault:(point,proof)=>{if(point==='after_target_create')throw Error('unknown new target');}});
 for(let i=0;i<16;i++)await assert.rejects(publishProjectOutput(f.store,f.input));remove();await assert.rejects(publishProjectOutput(f.store,f.input),{code:'INVALID_MEDIA'});
 assert.equal(readdirSync(path.join(f.projectDir,'生成')).length,16);assert.deepEqual(readFileSync(f.input.stageFile),bytes);assert.equal(f.store.get('assets',f.input.assetId),null);
});

for(const format of ['exFAT','FAT32'] as const)test(`real ${format} media publication replays disk-full and legacy receipts without clobbering`,{timeout:120000},async t=>{
 const volume=await mountProjectVolumeFixture(t,format);
 if(!volume)return;
 for(const kind of ['assets','generated'] as const)await t.test(`${kind} disk full keeps the staged bytes and exact request`,async sub=>{
  const f=fixture(sub,kind,volume.mount);
  let final='',candidate='',assetId='',publicationId='';
  const remove=setProjectOutputPublicationTestHooks(f.store,{fault(point,proof,workingFile){
   if(point!=='after_target_create')return;
   assert.ok(workingFile);
   candidate=workingFile;
   final=path.join(f.projectDir,proof.relativePath);
   ({assetId,publicationId}=proof);
  }});
  const prototype=await outputHandlePrototype(f.input.stageFile),original=prototype.write;
  let diskFull:Error|undefined;
  const patched=sub.mock.method(prototype,'write',async function(this:FileHandle,...args:unknown[]){
   if(Number(args[3])>0&&targetInfo(this,candidate)&&!diskFull){
    assert.equal(statSync(candidate).size,args[3]);
    assert.equal(existsSync(final),false);
    diskFull=Object.assign(Error('Disk is full'),{code:'ENOSPC',path:candidate});
    throw diskFull;
   }
   return Reflect.apply(original,this,args);
  });
  try{
   await assert.rejects(publishProjectOutput(f.store,f.input),error=>error instanceof Error&&diskFull!==undefined&&error.cause===diskFull);
  }finally{patched.mock.restore();remove();}
  assert.equal(f.store.get('assets',f.input.assetId),null);
  assert.deepEqual(readdirSync(path.dirname(final)),[]);
  assert.deepEqual(readdirSync(path.dirname(candidate)),[]);
  assert.deepEqual(readFileSync(f.input.stageFile),bytes);
  const output=await publishProjectOutput(f.store,f.input);
  assert.equal(output.publication.assetId,assetId);
  assert.equal(output.publication.publicationId,publicationId);
  assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);
  f.store.tx(()=>{assertPublishedProjectOutput(f.store,output.publication);f.register(output);});
  await markProjectOutputRegistered(f.store,output.publication);
  assert.equal(f.store.list('assets',f.projectId).length,1);
  assert.deepEqual(await publishProjectOutput(f.store,f.input),output);
 });
 for(const owned of [true,false])await t.test(`legacy ${owned?'owned partial is reclaimed':'mismatching complete image is preserved'}`,async sub=>{
  const f=fixture(sub,owned?'assets':'generated',volume.mount);
  let final='',receiptFile='';
  const stop=Error('Stop before copying a legacy output');
  const remove=setProjectOutputPublicationTestHooks(f.store,{fault(point,proof){
   if(point!=='after_intent')return;
   final=path.join(f.projectDir,proof.relativePath);
   receiptFile=path.join(f.store.tempDir,'publications',`${proof.publicationId}.json`);
   throw stop;
  }});
  try{await assert.rejects(publishProjectOutput(f.store,f.input),stop);}finally{remove();}
  const receipt=JSON.parse(readFileSync(receiptFile,'utf8')) as Record<string,unknown>;
  const payload=owned?bytes.subarray(0,65536):bytes;
  const writeLegacyFile=()=>{
   const fd=openSync(final,'wx',0o644);
   try{
    const empty=fstatSync(fd,{bigint:true});
    writeFileSync(fd,payload);
    const written=fstatSync(fd,{bigint:true});
    fsyncSync(fd);
    const synced=fstatSync(fd,{bigint:true}), visibleWhileOpen=lstatSync(final,{bigint:true});
    return {empty,written,synced,visibleWhileOpen};
   }finally{closeSync(fd);}
  };
  const {empty,written,synced,visibleWhileOpen}=writeLegacyFile();
  // Recovery uses a closed pathname. FAT may report different facts on the
  // still-open writer, so use the closed file to seed the provably owned case.
  const closed=lstatSync(final,{bigint:true});
  const emptyIdentity=outputFileIdentity(empty), closedIdentity=outputFileIdentity(closed);
  const targetIdentity=owned?closedIdentity:sameOutputIdentity(emptyIdentity,closedIdentity)
   ?{...emptyIdentity,ino:String(BigInt(emptyIdentity.ino)-1n)}:emptyIdentity;
  writeFileSync(receiptFile,JSON.stringify({...receipt,phase:'copying',mode:'copy',targetIdentity}));
  const beforeRecovery=lstatSync(final,{bigint:true});
  sub.diagnostic(`legacy ${format} file identity ${JSON.stringify({empty:describeOutputStat(empty),written:describeOutputStat(written),
   synced:describeOutputStat(synced),visibleWhileOpen:describeOutputStat(visibleWhileOpen),closed:describeOutputStat(closed),
   receipt:targetIdentity,beforeRecovery:describeOutputStat(beforeRecovery)})}`);
  assert.equal(beforeRecovery.size,BigInt(payload.length));
  assert.equal(sameOutputIdentity(targetIdentity,outputFileIdentity(beforeRecovery)),owned);
  if(owned){
   const output=await publishProjectOutput(f.store,f.input);
   assert.equal(output.relativePath,path.relative(f.projectDir,final));
   assert.deepEqual(readFileSync(final),bytes);
   assert.deepEqual(readdirSync(path.dirname(final)).filter(name=>!name.startsWith('._')),[path.basename(final)]);
  }else{
   const identity=outputFileIdentity(statSync(final,{bigint:true}));
   await assert.rejects(inspectProjectOutput(f.store,f.key()),{code:'INVALID_MEDIA',details:{publicationFailure:'target-identity'}});
   for(let replay=0;replay<2;replay++)await assert.rejects(publishProjectOutput(f.store,f.input),{code:'INVALID_MEDIA'});
   assert.deepEqual(outputFileIdentity(statSync(final,{bigint:true})),identity);
   assert.deepEqual(readFileSync(final),payload);
   assert.deepEqual(readdirSync(path.dirname(final)).filter(name=>!name.startsWith('._')),[path.basename(final)]);
   assert.equal(JSON.parse(readFileSync(receiptFile,'utf8')).failure,'target-identity');
  }
  assert.equal(f.store.get('assets',f.input.assetId),null);
 });
 await t.test('rollback after private install and before registration',async t=>{
  const f=fixture(t,'generated',volume.mount),published=await publishProjectOutput(f.store,f.input);
  const final=path.join(f.projectDir,published.relativePath);
  let receiptReset=false;
  discardUnregisteredFatOutput(f.store,published.publication,()=>{
   assert.ok(existsSync(final));receiptReset=true;
  });
  assert.equal(receiptReset,true);
  assert.deepEqual(readdirSync(path.dirname(final)),[]);
  assert.deepEqual(readFileSync(f.input.stageFile),bytes);
  const replay=await publishProjectOutput(f.store,f.input);
  assert.deepEqual(replay.publication,published.publication);
  assert.deepEqual(readFileSync(final),bytes);
  f.register(replay);
  discardUnregisteredFatOutput(f.store,replay.publication,()=>assert.fail('a committed asset cannot be rolled back'));
  assert.deepEqual(readFileSync(final),bytes);
 });
});

function videoExport(f: ReturnType<typeof fixture>, displayName: string, payload: Buffer): ProjectOutputInput {
 const assetId = randomUUID(), stageFile = path.join(path.dirname(f.input.stageFile), `${assetId}.mp4`);
 writeFileSync(stageFile, payload, {mode: 0o600, flag: 'wx'});
 return {...f.input, owner: {...f.input.owner, id: randomUUID(), requestId: randomUUID()}, assetId, stageFile,
  mimeType: 'video/mp4', sha256: sha(payload), sizeBytes: payload.length, displayName};
}

test('a disk-full error after the first export copy block leaves no final file or temporary candidate', async t => {
 const f = fixture(t, 'exports');
 const payload = Buffer.concat([mp4HeaderFixture('Export that exceeds the available disk space'), Buffer.alloc(150000, 1)]);
 const input = videoExport(f, 'Mioon混剪', payload);
 let final = '', candidate = '';
 setProjectOutputPublicationTestHooks(f.store, {fault(point, proof, workingFile) {
  if (point === 'after_target_create') {
   assert.ok(workingFile);
   candidate = workingFile;
   final = path.join(f.projectDir, proof.relativePath);
  }
 }});
 const prototype = await outputHandlePrototype(input.stageFile), original = prototype.write;
 let failure: Error | undefined;
 t.mock.method(prototype, 'write', async function(this: FileHandle, ...args: unknown[]) {
  const position = args[3];
  if (typeof position === 'number' && position > 0 && targetInfo(this, candidate)) {
   assert.equal(statSync(candidate).size, position);
   assert.equal(existsSync(final), false);
   failure = Object.assign(Error('Disk is full'), {code: 'ENOSPC', path: candidate});
   throw failure;
  }
  return await Reflect.apply(original, this, args);
 });
 const register = t.mock.fn(f.register);
 await assert.rejects(publishProjectOutput(f.store, input, {}, register), error =>
  error instanceof Error && failure !== undefined && error.cause === failure);
 assert.equal(register.mock.callCount(), 0);
 assert.equal(f.store.get('assets', input.assetId), null);
 assert.deepEqual(readdirSync(path.dirname(final)), []);
 assert.equal(existsSync(candidate), false);
 assert.deepEqual(readFileSync(input.stageFile), payload);
});

for (const replace of [false, true]) test(`export rollback after installation ${replace ? 'preserves a same-byte replacement' : 'removes its own final file'}`, async t => {
 const f = fixture(t, 'exports');
 const payload = mp4HeaderFixture('Verified export before database commit');
 const input = videoExport(f, 'Mioon混剪', payload);
 const sentinel = Error('Fail after installation and before database commit');
 let final = '', candidate = '', replacement: bigint | undefined;
 setProjectOutputPublicationTestHooks(f.store, {fault(point, proof, workingFile) {
  if (point === 'after_final') {
   assert.ok(workingFile);
   candidate = workingFile;
   final = path.join(f.projectDir, proof.relativePath);
   assert.equal(existsSync(final), false);
   assert.deepEqual(readFileSync(candidate), payload);
  }
  if (point === 'after_install') {
   assert.equal(f.store.db.isTransaction, true);
   assert.ok(f.store.get('assets', input.assetId));
   assert.deepEqual(readFileSync(final), payload);
   if (replace) {
    renameSync(final, path.join(f.root, 'displaced-output.mp4'));
    writeFileSync(final, payload, {flag: 'wx'});
    replacement = statSync(final, {bigint: true}).ino;
   }
   throw sentinel;
  }
 }});
 await assert.rejects(publishProjectOutput(f.store, input, {}, f.register), error => error === sentinel);
 assert.equal(f.store.get('assets', input.assetId), null);
 assert.equal(existsSync(candidate), false);
 if (replace) {
  assert.equal(statSync(final, {bigint: true}).ino, replacement);
  assert.deepEqual(readFileSync(final), payload);
 } else assert.deepEqual(readdirSync(path.dirname(final)), []);
 assert.deepEqual(readFileSync(input.stageFile), payload);
});

test('concurrent exports use separate numbered filenames without replacing any existing file', async t => {
 const f = fixture(t, 'exports'), directory = path.join(f.projectDir, '导出');
 mkdirSync(directory);
 const existing = new Map(Array.from({length: 17}, (_, index) => [
  index === 0 ? 'Mioon混剪.mp4' : `Mioon混剪 ${index + 1}.mp4`, Buffer.from(`Existing file ${index + 1}`),
 ] as const));
 for (const [name, payload] of existing) writeFileSync(path.join(directory, name), payload, {flag: 'wx'});
 const payloads = [mp4HeaderFixture('First export bytes'), mp4HeaderFixture('Second export bytes')];
 const inputs = payloads.map(payload => videoExport(f, 'Mioon混剪.mp4', payload));
 const results = await Promise.all(inputs.map(input => publishProjectOutput(f.store, input)));
 assert.deepEqual(new Set(results.map(result => result.relativePath)), new Set(['导出/Mioon混剪 18.mp4', '导出/Mioon混剪 19.mp4']));
 for (const [index, result] of results.entries()) {
  assert.equal(result.reference.path, result.relativePath);
  assert.equal(result.publication.relativePath, result.relativePath);
  assert.deepEqual(result.publication.owner, inputs[index]!.owner);
  assert.deepEqual(readFileSync(path.join(f.projectDir, result.relativePath)), payloads[index]);
 }
 for (const [name, payload] of existing) assert.deepEqual(readFileSync(path.join(directory, name)), payload);
});

test('export filenames sanitize reserved characters and bound Unicode while keeping the suffix', async t => {
 const f = fixture(t, 'exports'), payload = mp4HeaderFixture('Sanitized export bytes');
 const unsafe = await publishProjectOutput(f.store, videoExport(f, 'Cut/\\mid\u0000?:end.v1.MP4', payload));
 assert.equal(unsafe.relativePath, '导出/Cut__mid___end.v1.mp4');
 const reserved = await publishProjectOutput(f.store, videoExport(f, 'CON.mp4', payload));
 assert.equal(reserved.relativePath, '导出/_CON.mp4');
 const longName = '海🌊'.repeat(120) + '.mp4';
 const first = await publishProjectOutput(f.store, videoExport(f, longName, payload));
 const next = await publishProjectOutput(f.store, videoExport(f, longName, payload));
 const ordinal = path.posix.basename(first.relativePath), numbered = path.posix.basename(next.relativePath);
 assert.match(ordinal, /^(?:海🌊)+(?:海)?\.mp4$/u);
 assert.match(numbered, /^(?:海🌊)+(?:海)? 2\.mp4$/u);
 for (const name of [ordinal, numbered]) {
  assert.ok(Buffer.byteLength(name) <= 180);
  assert.ok(name.length <= 160);
 }
});

test('corrupt and oversized private intents are refused without repairing them',async t=>{
 const f=fixture(t),stop=setProjectOutputPublicationTestHooks(f.store,{fault:point=>{if(point==='after_intent')throw Error('stop');}});await assert.rejects(publishProjectOutput(f.store,f.input));stop();
 const directory=path.join(f.store.tempDir,'publications'),name=readdirSync(directory).find(n=>!n.startsWith('key-'))!,file=path.join(directory,name);
 for(const contents of ['{bad',JSON.stringify({version:999}), 'x'.repeat(32769)]){writeFileSync(file,contents,{mode:0o600});await assert.rejects(publishProjectOutput(f.store,f.input));assert.equal(readFileSync(file,'utf8'),contents);}
 assert.equal(f.store.get('assets',f.input.assetId),null);
});

test('explicit export restoration binds a new target inode and preserves a late same-byte replacement',async t=>{
 const f=fixture(t,'exports'),output=await publishProjectOutput(f.store,f.input);const asset=f.register(output);await markProjectOutputRegistered(f.store,output.publication);
 const file=path.join(f.projectDir,output.relativePath);unlinkSync(file);const stage=path.join(path.dirname(f.input.stageFile),'restore.png');writeFileSync(stage,bytes,{mode:0o600});
 const remove=setProjectOutputPublicationTestHooks(f.store,{fault:(point)=>{if(point==='after_final'){renameSync(file,file+'.replaced');writeFileSync(file,bytes,{mode:0o644});}}});
 await assert.rejects(restorePublishedProjectOutput(f.store,{asset,stageFile:stage}));remove();assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(readFileSync(stage),bytes);
 await assert.rejects(restorePublishedProjectOutput(f.store,{asset,stageFile:stage}),{code:'IDEMPOTENCY_CONFLICT'});
});

for (const boundary of ['after_copy_chunk','after_final'] as const) test(`export restoration tolerates ctime-only changes at ${boundary}`, async t => {
 const f = fixture(t, 'exports'), output = await publishProjectOutput(f.store, f.input), asset = f.register(output);
 await markProjectOutputRegistered(f.store, output.publication);
 const file = path.join(f.projectDir, output.relativePath), stage = path.join(path.dirname(f.input.stageFile), 'restore.png');
 unlinkSync(file);
 writeFileSync(stage, bytes, {mode: 0o600});
 let changed = false;
 setProjectOutputPublicationTestHooks(f.store, {fault(point) {
  if (point !== boundary || changed) return;
  changeCtimeOnly(boundary === 'after_copy_chunk' ? stage : file);
  changed = true;
 }});
 const restored = await restorePublishedProjectOutput(f.store, {asset, stageFile: stage});
 assert.ok(changed);
 assert.deepEqual(restored.publication, output.publication);
 assert.deepEqual(readFileSync(file), bytes);
 assertPublishedProjectOutput(f.store, output.publication);
});

test('version-canonicalized publication facts retain strict registration and missing-file restoration authority',async t=>{
 const f=fixture(t,'exports'),output=await publishProjectOutput(f.store,f.input),asset=f.register(output);
 const canonical=JSON.parse(canonicalJson(asset)) as Record<string,unknown>;f.store.put('assets',canonical);
 await markProjectOutputRegistered(f.store,output.publication);
 const file=path.join(f.projectDir,output.relativePath);unlinkSync(file);
 const stage=path.join(path.dirname(f.input.stageFile),'canonical-restore.png');writeFileSync(stage,bytes,{mode:0o600});
 const restored=await restorePublishedProjectOutput(f.store,{asset:canonical,stageFile:stage});
 assert.equal(restored.relativePath,output.relativePath);assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(restored.publication,output.publication);
 const wrong={...canonical,publication:{...output.publication,owner:{...output.publication.owner,id:randomUUID()}}};
 await assert.rejects(markProjectOutputRegistered(f.store,wrong.publication),{code:'INVALID_MEDIA'});assert.deepEqual(readFileSync(file),bytes);
});

test('a registered output keeps its visible inode epoch stable while asynchronous registration work finishes',async t=>{
 const f=fixture(t,'assets'),output=await publishProjectOutput(f.store,f.input);f.register(output);
 const final=path.join(f.projectDir,output.relativePath),registered=markProjectOutputRegistered(f.store,output.publication);
 const ready=statSync(final,{bigint:true}),read=registeredProjectAssetReferences(f.projectDir)!.read(f.input.assetId,{maxBytes:bytes.length,expectedSha256:f.input.sha256,expectedReferenceRevision:1});
 await registered;assert.deepEqual((await read).bytes,bytes);
 const finished=statSync(final,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'] as const)assert.equal(finished[key],ready[key],`a ready result must not acquire a later ${key} change from private cleanup`);
});
