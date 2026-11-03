import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {realpathSync} from 'node:fs';
import {createProjectFile,openProjectStore} from '../packages/business/src/project-file/index.ts';
import {registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {registerProjectOutputAdmission} from '../packages/business/src/project-output-owner.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {publishProjectOutput,inspectProjectOutput,readPublishedProjectOutput,markProjectOutputRegistered,assertPublishedProjectOutput,isPublishedProjectOutput,restorePublishedProjectOutput,setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputInput,PublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import {png,pngChunk} from './helpers/timeline-image-fixtures.ts';

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
 const register=(output:PublishedProjectOutput)=>{const{relativePath:_relative,...stored}=output;return store.put('assets',{id:input.assetId,projectId,name:'Published.png',mimeType:input.mimeType,width:64,height:64,...stored,provenance:kind==='exports'?'export':'generated',createdAt:new Date().toISOString()});};
 return{root,projectDir,projectFile,projectId,store,input,key,count,register};
}

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
