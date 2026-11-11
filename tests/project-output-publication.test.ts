import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,chmodSync,closeSync,existsSync,fstatSync,linkSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,renameSync,rmSync,statSync,unlinkSync,utimesSync,writeFileSync,writeSync} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {realpathSync} from 'node:fs';
import {createProjectFile,openProjectStore} from '../packages/business/src/project-file/index.ts';
import {registerProjectMediaStore,registeredProjectAssetReferences} from '../packages/business/src/project-media-storage.ts';
import {registerProjectOutputAdmission} from '../packages/business/src/project-output-owner.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {publishProjectOutput,inspectProjectOutput,readPublishedProjectOutput,markProjectOutputRegistered,assertPublishedProjectOutput,registerVerifiedProjectOutputs,isPublishedProjectOutput,restorePublishedProjectOutput,setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput,PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {png,pngChunk} from './helpers/timeline-image-fixtures.ts';
import {canonicalJson} from '../packages/business/src/project-versions/document.ts';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bytes=png({rgba:false,extra:[pngChunk('tEXt',Buffer.from('comment\0'+'x'.repeat(150000)))]});
function fixture(t:TestContext,kind:ProjectOutputInput['targetKind']='generated'){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-output-pub-')),projectDir=path.join(root,'movie');mkdirSync(projectDir,{mode:0o755});
 const projectFile=path.join(projectDir,'movie.mioon'),projectId=createProjectFile(projectFile);
 const store=openProjectStore({projectFile,locate:()=>({localDir:path.join(root,'local'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')})});
 store.put('projects',{id:projectId,name:'Publication fixture',revision:1});const release=registerProjectMediaStore(store);
 t.after(()=>{release();try{store.close();}finally{rmSync(root,{recursive:true,force:true});}});
 const stages=path.join(store.tempDir,'verified-artifacts');ensurePrivateDirectory(stages,{create:true});const stageFile=path.join(stages,`${randomUUID()}.png`);writeFileSync(stageFile,bytes,{mode:0o600});
 const input:ProjectOutputInput={owner:{kind:kind==='exports'?'export':'image',id:randomUUID(),requestId:randomUUID(),inputHash:'a'.repeat(64)},assetId:randomUUID(),targetKind:kind,stageFile,mimeType:'image/png',sha256:sha(bytes),sizeBytes:bytes.length};
 const key=()=>({owner:input.owner,assetId:input.assetId});const count=()=>Number(store.db.prepare('SELECT total_changes() AS n').get()!.n);
 const register=(output:PublishedProjectOutput)=>{const{relativePath:_relative,...stored}=output;return store.put('assets',{id:output.publication.assetId,projectId,name:'Published.png',mimeType:input.mimeType,width:64,height:64,...stored,provenance:kind==='exports'?'export':'generated',createdAt:new Date().toISOString()});};
 return{root,projectDir,projectFile,projectId,store,input,key,count,register};
}

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

async function outputHandlePrototype(probe: string): Promise<Pick<FileHandle, 'read' | 'sync'>> {
 const sample = await open(probe, 'r'), prototype = Object.getPrototypeOf(sample) as Pick<FileHandle, 'read' | 'sync'>;
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

function observePublicationTarget(f: ReturnType<typeof fixture>): () => string {
 let target = '';
 setProjectOutputPublicationTestHooks(f.store, {fault(point, proof) {
  if (point === 'after_intent') target = path.join(f.projectDir, proof.relativePath);
 }});
 return () => target;
}

for (const kind of ['exports','generated'] as const) test(`${kind} publication accepts ctime-only changes during the final full read`, async t => {
 const f = fixture(t, kind), target = observePublicationTarget(f);
 let changed = false;
 await afterFullOutputRead(t, f.input.stageFile, target, file => {
  if (changed) return;
  changeCtimeOnly(file);
  changed = true;
 });
 const output = await publishProjectOutput(f.store, f.input);
 assert.ok(changed);
 assert.equal(path.join(f.projectDir, output.relativePath), target());
 assert.equal(output.sha256, f.input.sha256);
 assert.deepEqual(readFileSync(target()), bytes);
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
 const f = fixture(t), target = location === 'stage' ? () => f.input.stageFile : observePublicationTarget(f);
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
 const f = fixture(t), target = observePublicationTarget(f), changesBefore = f.count();
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
 const f = fixture(t);
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
 const f=fixture(t),before=f.count();setProjectOutputPublicationTestHooks(f.store,{forceCopy});
 const output=await publishProjectOutput(f.store,f.input);assert.match(output.relativePath,/^生成\//u);assert.equal(f.count(),before);
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);assert.equal(statSync(f.projectDir).mode&0o777,0o755);
 assert.deepEqual(await publishProjectOutput(f.store,f.input),output);assert.deepEqual(await readPublishedProjectOutput(f.store,f.key(),{maxBytes:bytes.length}),bytes);
 const sentinels=[path.join(f.projectDir,'keep.png'),path.join(f.store.localDir,'keep'),path.join(f.store.cacheDir,'keep'),path.join(f.store.tempDir,'keep')];for(const file of sentinels)writeFileSync(file,'untouched',{mode:0o600});
 f.store.tx(()=>{assertPublishedProjectOutput(f.store,output.publication);f.register(output);});await markProjectOutputRegistered(f.store,output.publication);
 assert.equal(existsSync(f.input.stageFile),false);for(const file of sentinels)assert.equal(readFileSync(file,'utf8'),'untouched');
 assert.deepEqual(readFileSync(path.join(f.projectDir,output.relativePath)),bytes);
 assert.equal(isPublishedProjectOutput(f.store.get('assets',f.input.assetId),{projectId:f.projectId,owner:f.input.owner,targetKind:'generated'}),true);
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
 const f=fixture(t),sentinel=Error('final');const remove=setProjectOutputPublicationTestHooks(f.store,{fault:point=>{if(point==='after_final')throw sentinel;}});
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
 const f=fixture(t),output=await publishProjectOutput(f.store,f.input);f.register(output);
 const final=path.join(f.projectDir,output.relativePath),registered=markProjectOutputRegistered(f.store,output.publication);
 const ready=statSync(final,{bigint:true}),read=registeredProjectAssetReferences(f.projectDir)!.read(f.input.assetId,{maxBytes:bytes.length,expectedSha256:f.input.sha256,expectedReferenceRevision:1});
 await registered;assert.deepEqual((await read).bytes,bytes);
 const finished=statSync(final,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs','nlink'] as const)assert.equal(finished[key],ready[key],`a ready result must not acquire a later ${key} change from private cleanup`);
});
