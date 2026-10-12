import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync,copyFileSync,chmodSync,symlinkSync,linkSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {createServices,canonical} from '../packages/business/src/services.mjs';
import {createLocalMutationServices} from '../packages/business/src/local-mutations.mjs';
import {validateImageConsumption} from '../packages/business/src/image-consumption.mjs';
import {createLocalShotText,LOCAL_SHOT_TEXT_FILENAME} from '@mioon/business/local-shot-text';
import {createLocalShotTextDomain} from '@mioon/business/local-shot-text-domain';
import {LOCAL_SHOT_TEXT_LIMITS,createLocalShotTextSchemas} from '@mioon/contracts/local-shot-text';
import {schemas,AppError} from '@mioon/contracts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile} from '@mioon/contracts/private-storage';
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile};
const contract=createLocalShotTextSchemas(value=>schemas['shot.update'].safeParse(value).success);
const code=value=>error=>error.code===value&&!error.message.includes('PRIVATE');
const authority=value=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId,shotId:value.shotId});
const action=value=>({...authority(value),intentId:value.intent.intentId,expectedIntentRevision:value.intentRevision});
async function fixture(t){
  const root=mkdtempSync(path.join(tmpdir(),'mioon-local-shot-text-'));let store=openStore(root),services=createServices(store,new Map()),shotText,fault=()=>{},update,extraGuards={},calls=[];
  const project=await services.call('project.create',{name:'Local text'}),shot=await services.call('shot.create',{projectId:project.id,title:'Original title',prompt:'Original prompt'});
  const originalUpdate=(projectId,input)=>services.updateShotInProject(projectId,input);update=originalUpdate;
  const start=(options={})=>{
    const never=()=>{throw Error('PRIVATE mutator called during read');};
    const replay=createLocalMutationServices(store,{canonical,readOnly:true,check:never,now:never,references:{guardManualUpdate:never}});
    const domain=createLocalShotTextDomain({db:store.db,canonical,replay:(projectId,input)=>replay.updateShotInProject(projectId,input),
      validateAsset:(projectId,asset)=>validateImageConsumption(store.db,asset,projectId),isRevisionConflict:error=>error instanceof AppError&&error.code==='REVISION_CONFLICT',
      updateShotInProject:(projectId,input)=>{calls.push(structuredClone(input));return update(projectId,input);}});
    shotText=createLocalShotText({root,storage,guards:{...domain,ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store)),isShotUpdateInput:value=>schemas['shot.update'].safeParse(value).success,...extraGuards},fault:point=>fault(point),...options});return shotText;
  };start();
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const get=(value=shot)=>shotText.get({projectId:value.projectId,shotId:value.id});
  const put=(value=get(),raw={title:'Changed title',prompt:shot.prompt})=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),baseRevision:value.draft?.baseRevision??store.get('shots',value.shotId).revision,baseText:value.draft?.baseText??{title:store.get('shots',value.shotId).title,prompt:store.get('shots',value.shotId).prompt},raw});
  const prepare=(value=get(),patch={title:value.draft.raw.title})=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),baseRevision:value.draft.baseRevision,baseText:value.draft.baseText,draft:{draftId:value.draft.draftId,revision:value.draftRevision,raw:value.draft.raw},input:{requestId:randomUUID(),shotId:value.shotId,expectedRevision:value.draft.baseRevision,patch}});
  return {root,file:path.join(root,LOCAL_SHOT_TEXT_FILENAME),project,shot,get,put,prepare,start,originalUpdate,get store(){return store;},get services(){return services;},get shotText(){return shotText;},get calls(){return calls;},
    setFault(fn){fault=fn;},setUpdate(fn){update=fn;},setGuards(value){extraGuards=value;start();},
    restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
    receipt(input){return store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId);},
    snapshot(){return JSON.stringify(store.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all())+'\n'+JSON.stringify(['projects','shots','assets','versions','jobs','mutation_requests','asset_range_requests','asset_disposition_requests','subject_requests'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
  };
}

test('GET and independent draft CAS preserve raw/base text without SQLite writes or dispatch',async t=>{
  const f=await fixture(t),before=f.snapshot(),empty=f.get();assert.ok(contract.envelope.safeParse(empty).success);assert.equal(existsSync(f.file),false);
  const input=f.put(empty,{title:' \n\u0000 ',prompt:'invalid raw '.repeat(500)}),saved=f.shotText.put(input);assert.deepEqual(saved.draft.raw,input.raw);assert.deepEqual(saved.draft.baseText,input.baseText);assert.equal(saved.draftRevision,1);assert.equal(saved.draftTargetStatus,'matching');assert.equal(statSync(f.file).mode&0o777,0o600);assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
  assert.deepEqual(f.shotText.put(input),saved);const newer=f.shotText.put(f.put(saved));assert.throws(()=>f.shotText.put(input),code('LOCAL_SHOT_TEXT_CONFLICT'));
  const removed=f.shotText.discard({...authority(newer),expectedDraftRevision:newer.draftRevision,draftId:newer.draft.draftId});assert.equal(removed.draft,null);assert.equal(removed.draftRevision,3);assert.equal(f.snapshot(),before);
});

test('prepare freezes exact keyed patch and requires saved capture; one pending intent spans project shots',async t=>{
  const f=await fixture(t),second=await f.services.call('shot.create',{projectId:f.project.id,title:'Second'}),saved=f.shotText.put(f.put()),input=f.prepare(saved),before=f.snapshot(),prepared=f.shotText.prepare(input);
  assert.equal(prepared.intent.outcome.status,'pending');assert.deepEqual(prepared.intent.input,input.input);assert.deepEqual(prepared.projectPendingIntent,{shotId:f.shot.id,intentId:input.intentId});assert.deepEqual(f.shotText.prepare(input),prepared);assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
  const other=f.shotText.put(f.put(f.get(second),{title:'Second changed',prompt:''}));assert.deepEqual(other.projectPendingIntent,prepared.projectPendingIntent);assert.throws(()=>f.shotText.prepare(f.prepare(other)),code('LOCAL_SHOT_TEXT_CONFLICT'));
  assert.throws(()=>f.shotText.prepare({...input,intentId:randomUUID()}),code('LOCAL_SHOT_TEXT_CONFLICT'));
});

test('actual shared scoped update applies once, clears exact capture and preserves original historical receipt bytes',async t=>{
  const f=await fixture(t),saved=f.shotText.put(f.put()),prepared=f.shotText.prepare(f.prepare(saved)),inputBytes=JSON.stringify(prepared.intent.input);
  const result=await f.shotText.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'applied');assert.equal(result.envelope.draft,null);assert.equal(result.envelope.intentRevision,2);assert.equal(result.envelope.draftRevision,2);assert.ok(contract.execution.safeParse(result).success);assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.calls[0]),inputBytes);
  const bytes=f.receipt(prepared.intent.input).response;assert.equal(JSON.parse(bytes).title,saved.draft.raw.title);
  await f.services.call('shot.update',{shotId:f.shot.id,expectedRevision:result.response.revision,patch:{prompt:'Later prompt'}});
  const replay=await f.shotText.recover(action(f.get()));assert.deepEqual(replay.response,result.response);assert.equal(f.receipt(prepared.intent.input).response,bytes);assert.equal(f.calls.length,1);assert.equal(replay.envelope.intentTargetStatus,'changed');
  assert.throws(()=>f.shotText.execute(action(prepared)),code('LOCAL_SHOT_TEXT_CONFLICT'));
});

test('overlapping execute/recover single-flights while a newer draft survives the exact accepted callback',async t=>{
  const f=await fixture(t),saved=f.shotText.put(f.put()),prepared=f.shotText.prepare(f.prepare(saved)),gate=Promise.withResolvers();
  f.setUpdate(async(projectId,input)=>{await gate.promise;return f.originalUpdate(projectId,input);});
  const first=f.shotText.execute(action(prepared)),second=f.shotText.recover(action(prepared));assert.equal(first,second);await Promise.resolve();assert.equal(f.calls.length,1);
  const newer=f.shotText.put(f.put(f.get(),{title:'Newer unsaved title',prompt:f.shot.prompt}));gate.resolve();const result=await first;assert.equal(result.envelope.intent.outcome.status,'applied');assert.deepEqual(result.envelope.draft,newer.draft);assert.equal(result.envelope.draftRevision,newer.draftRevision);
});

test('lost shared response reconciles receipt without a second update across new instance',async t=>{
  const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));f.setUpdate(async(projectId,input)=>{await f.originalUpdate(projectId,input);throw Error('PRIVATE lost ACK');});
  const result=await f.shotText.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'applied');const bytes=f.receipt(prepared.intent.input).response;
  f.restart();assert.notEqual(f.get().instanceId,prepared.instanceId);const recovered=await f.shotText.recover(action(f.get()));assert.deepEqual(recovered.response,result.response);assert.equal(f.calls.length,1);assert.equal(f.receipt(prepared.intent.input).response,bytes);
});

test('ambiguous failure remains pending through restart and only explicit recover reuses exact original input',async t=>{
  const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));f.setUpdate(async()=>{throw Error('PRIVATE transport');});
  assert.equal((await f.shotText.execute(action(prepared))).envelope.intent.outcome.status,'pending');f.restart();assert.equal(f.get().intent.outcome.status,'pending');assert.equal(f.calls.length,1);
  f.setUpdate(f.originalUpdate);assert.equal((await f.shotText.recover(action(f.get()))).envelope.intent.outcome.status,'applied');assert.deepEqual(f.calls[0],f.calls[1]);
});

test('actual fresh revision rollback settles not_applied and terminal recovery never retries even after restoration',async t=>{
  const f=await fixture(t),saved=f.shotText.put(f.put()),prepared=f.shotText.prepare(f.prepare(saved));f.store.put('shots',{...f.shot,revision:2});
  const result=await f.shotText.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'not_applied');assert.equal(result.envelope.intent.outcome.code,'REVISION_CONFLICT');assert.deepEqual(result.envelope.draft,saved.draft);assert.equal(f.receipt(prepared.intent.input),undefined);
  f.store.put('shots',f.shot);f.restart();assert.equal((await f.shotText.recover(action(f.get()))).envelope.intent.outcome.status,'not_applied');assert.equal(f.calls.length,1);
  const next=f.shotText.prepare(f.prepare(f.get()));assert.notEqual(next.intent.intentId,prepared.intent.intentId);
});

for(const point of ['beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync'])test(`prepare fault ${point} never dispatches`,async t=>{
  const f=await fixture(t),saved=f.shotText.put(f.put()),input=f.prepare(saved),before=f.snapshot();f.setFault(label=>{if(label===point)throw Error('PRIVATE fault');});
  assert.throws(()=>f.shotText.prepare(input));assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before);f.setFault(()=>{});if(f.get().intent)assert.equal(f.get().intent.outcome.status,'pending');
});

for(const point of ['beforeOutcomePersist','beforePersist','afterPersist','beforeDirectorySync','afterDirectorySync'])test(`outcome fault ${point} keeps a reservation until explicit original-key recovery`,async t=>{
  const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));let outcome=false;f.setFault(label=>{if(label==='beforeOutcomePersist')outcome=true;if(outcome&&label===point)throw Error('PRIVATE fault');});
  await assert.rejects(f.shotText.execute(action(prepared)));f.setFault(()=>{});const found=f.get();assert.equal(found.intent.outcome.status,'pending');assert.equal(f.calls.length,1);assert.equal((await f.shotText.recover(action(found))).envelope.intent.outcome.status,'applied');assert.equal(f.calls.length,1);
});

test('postrename not-applied uncertainty never reruns the terminal intent',async t=>{
  const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));f.store.put('shots',{...f.shot,revision:2});let outcome=false;
  f.setFault(point=>{if(point==='beforeOutcomePersist')outcome=true;if(outcome&&point==='afterPersist')throw Error('PRIVATE fault');});await assert.rejects(f.shotText.execute(action(prepared)));f.setFault(()=>{});assert.equal(f.get().intent.outcome.status,'pending');f.store.put('shots',f.shot);
  assert.equal((await f.shotText.recover(action(f.get()))).envelope.intent.outcome.status,'not_applied');assert.equal(f.calls.length,1);
});

test('generic errors and forged acknowledgements cannot establish a terminal result',async t=>{
  for(const kind of ['generic','owner','missing','shape','wrong-shot','wrong-revision','fake-ack']){
    const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));
    f.setUpdate(async(_project,input)=>{if(kind==='fake-ack')return {...f.shot,...input.patch,revision:2};const details={mutationOutcome:'not_applied',requestId:input.requestId,entityId:kind==='wrong-shot'?randomUUID():input.shotId,expectedRevision:kind==='wrong-revision'?9:input.expectedRevision,currentRevision:2};
      if(kind==='shape')throw {code:'REVISION_CONFLICT',status:409,details};throw new AppError(kind==='owner'?'OWNER_REQUIRED':kind==='missing'?'NOT_FOUND':'OTHER','PRIVATE',kind==='owner'?403:409,details);});
    const result=await f.shotText.execute(action(prepared));assert.equal(result.envelope.intent.outcome.status,'pending',kind);assert.equal(result.response,null);
  }
});

test('corrupt, oversized, wrong-aftertext and cross-table receipts fail closed without altering legacy bytes',async t=>{
  for(const kind of ['malformed','oversize','title','prompt','revision','cross-table','duplicate']){
    const f=await fixture(t),prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));await f.originalUpdate(f.project.id,prepared.intent.input);const prior=f.receipt(prepared.intent.input);
    // Deliberately damaged-database fixture: normal writes cannot alter retained receipts.
    f.store.db.exec('PRAGMA ignore_check_constraints=ON; DROP TRIGGER immutable_mutation_requests; DROP TRIGGER retain_mutation_requests; DROP TRIGGER reject_asset_range_cross_request;');
    if(kind==='cross-table'||kind==='duplicate'){
      f.store.db.prepare('INSERT INTO asset_range_requests(requestId,operation,projectId,canonicalInput,response) VALUES(?,?,?,?,?)').run(prior.requestId,prior.operation,prior.projectId,prior.canonicalInput,prior.response);if(kind==='cross-table')f.store.db.prepare('DELETE FROM mutation_requests WHERE requestId=?').run(prior.requestId);
    }else{const response=JSON.parse(prior.response);if(kind==='title')response.title='Wrong';if(kind==='prompt')response.prompt='Wrong';if(kind==='revision')response.revision++;f.store.db.prepare('UPDATE mutation_requests SET response=? WHERE requestId=?').run(kind==='malformed'?'{':kind==='oversize'?'x'.repeat(LOCAL_SHOT_TEXT_LIMITS.shotResponseBytes+1):JSON.stringify(response),prior.requestId);}
    const before=f.snapshot();assert.throws(f.get,code('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE'));await assert.rejects(Promise.resolve().then(()=>f.shotText.recover(action(prepared))));assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
  }
});

test('relational and JSON ownership checks cover current and historical references without foreign responses',async t=>{
  for(const kind of ['shot-relational','shot-json','asset-relational','historical-asset']){
    const f=await fixture(t),foreign=await f.services.call('project.create',{name:'PRIVATE foreign'}),assetId=randomUUID();
    f.store.put('assets',{id:assetId,projectId:f.project.id,name:'Reference',mimeType:'image/png',provenance:'user-import'});f.store.put('shots',{...f.shot,referenceAssetIds:[assetId]});
    const prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put())));await f.originalUpdate(f.project.id,prepared.intent.input);
    if(kind==='shot-relational')f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(foreign.id,f.shot.id);
    if(kind==='shot-json')f.store.put('shots',{...f.store.get('shots',f.shot.id),projectId:foreign.id});
    if(kind==='asset-relational'||kind==='historical-asset'){if(kind==='historical-asset')f.store.put('shots',{...f.store.get('shots',f.shot.id),referenceAssetIds:[]});f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign.id,assetId);}
    assert.throws(f.get,code('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE'));assert.equal(f.calls.length,0);
  }
});

test('late owner reassignment, lease loss, abort and restored transition cannot persist a terminal result',async t=>{
  for(const kind of ['owner','lease','abort','restored']){
    const f=await fixture(t),controller=new AbortController();let restored=false;f.setGuards({isRestored:()=>restored});f.start({signal:controller.signal});const prepared=f.shotText.prepare(f.prepare(f.shotText.put(f.put()))),gate=Promise.withResolvers(),entered=Promise.withResolvers();
    f.setUpdate(async(projectId,input)=>{const result=await f.originalUpdate(projectId,input);entered.resolve();await gate.promise;return result;});const pending=f.shotText.execute(action(prepared));await entered.promise;
    if(kind==='owner'){const foreign=await f.services.call('project.create',{name:'Foreign'});f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(foreign.id,f.shot.id);}
    if(kind==='lease'){unlinkSync(path.join(f.root,'server.lock'));writeFileSync(path.join(f.root,'server.lock'),'0',{mode:0o600});}
    if(kind==='abort')controller.abort();if(kind==='restored')restored=true;gate.resolve();await assert.rejects(pending);assert.equal(JSON.parse(readFileSync(f.file)).entries[0].intent.outcome.status,'pending');
  }
});

test('maximum legal multibyte/control text survives draft, intent, receipt and new-instance recovery',async t=>{
  const f=await fixture(t),title='\u0000'.repeat(150),prompt='\u0001'.repeat(5000);f.store.put('shots',{...f.shot,title,prompt});
  const raw={title:'文'.repeat(150),prompt:'🙂'.repeat(2500)},saved=f.shotText.put(f.put(f.get(),raw)),prepared=f.shotText.prepare(f.prepare(saved,raw));assert.ok(Buffer.byteLength(JSON.stringify(prepared))<LOCAL_SHOT_TEXT_LIMITS.httpBytes);
  const result=await f.shotText.execute(action(prepared));assert.equal(result.response.title,raw.title);assert.equal(result.response.prompt,raw.prompt);f.restart();assert.deepEqual((await f.shotText.recover(action(f.get()))).response,result.response);
});

test('tombstones count toward capacity and never evict existing keys',async t=>{
  const f=await fixture(t),empty=f.get(),entries=Array.from({length:LOCAL_SHOT_TEXT_LIMITS.slots},()=>({projectId:randomUUID(),shotId:randomUUID(),draftRevision:1,draft:null,intentRevision:0,intent:null}));
  writeFileSync(f.file,JSON.stringify({version:1,workspaceScope:empty.workspaceScope,entries}),{mode:0o600});const bytes=readFileSync(f.file);assert.throws(()=>f.shotText.put(f.put(empty)),code('LOCAL_SHOT_TEXT_CAPACITY'));assert.deepEqual(readFileSync(f.file),bytes);
});

test('stale instances, copied scopes, malformed and unsafe private companions never repair or reset',async t=>{
  const f=await fixture(t),saved=f.shotText.put(f.put()),old=f.put(saved);f.restart();assert.throws(()=>f.shotText.put(old),code('LOCAL_SHOT_TEXT_STALE_INSTANCE'));const bytes=readFileSync(f.file);
  f.start({channel:'production'});assert.throws(f.get,code('LOCAL_SHOT_TEXT_SCOPE_MISMATCH'));f.start();const other=await fixture(t);copyFileSync(f.file,other.file);chmodSync(other.file,0o600);assert.throws(other.get,code('LOCAL_SHOT_TEXT_SCOPE_MISMATCH'));
  for(const raw of ['{','null',Buffer.from([0xff]),'x'.repeat(LOCAL_SHOT_TEXT_LIMITS.envelopeBytes+1)]){writeFileSync(f.file,raw);assert.throws(f.get,code('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE'));assert.deepEqual(readFileSync(f.file),Buffer.from(raw));}
  rmSync(f.file);const target=path.join(f.root,'private-target');writeFileSync(target,'PRIVATE',{mode:0o600});symlinkSync(target,f.file);assert.throws(f.get);rmSync(f.file);linkSync(target,f.file);assert.throws(f.get);rmSync(f.file);writeFileSync(f.file,bytes,{mode:0o644});assert.throws(f.get);assert.equal(statSync(f.file).mode&0o777,0o644);
});

test('reentrant before-persist write trips full-file CAS while malformed inputs never evaluate getters',async t=>{
  const f=await fixture(t),empty=f.get(),outer=f.put(empty),inner=f.put(empty,{title:'Inner',prompt:f.shot.prompt});let entered=false;
  f.setFault(point=>{if(point==='beforePersist'&&!entered){entered=true;f.shotText.put(inner);}});assert.throws(()=>f.shotText.put(outer),code('LOCAL_SHOT_TEXT_CONFLICT'));f.setFault(()=>{});assert.equal(f.get().draft.raw.title,'Inner');
  let touched=0;const getter={...f.put()};Object.defineProperty(getter,'raw',{enumerable:true,get(){touched++;return outer.raw;}});assert.throws(()=>f.shotText.put(getter),code('LOCAL_SHOT_TEXT_VALIDATION'));assert.throws(()=>f.shotText.put(new Proxy(outer,{})),code('LOCAL_SHOT_TEXT_VALIDATION'));assert.equal(touched,0);
});

test('restored workspace is unsupported before sidecar, lock, ownership or mutation I/O',async()=>{
  const never=()=>{throw Error('PRIVATE never');},shotText=createLocalShotText({root:'/unread',storage:{validatePrivateDirectory:never,validateManagedFile:never,readPrivateFile:never,writePrivateFileAtomic:never},guards:{ownsLock:never,isRestored:()=>true,readShot:never,readReceipt:never,isShotUpdateInput:never,isNotApplied:never,update:never}});
  for(const method of ['get','put','discard','prepare'])assert.deepEqual(shotText[method]({}),{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'});
  for(const method of ['execute','recover'])assert.deepEqual(await shotText[method]({}),{envelope:{supported:false,reason:'RESTORED_WORKSPACE_UNSUPPORTED'},response:null});
});


test('successful same-CAS retry checkpoints prepublication storage failure before prepare',async t=>{
  const f=await fixture(t);let failed=false;
  f.start({storage:{...storage,writePrivateFileAtomic(...args){if(!failed){failed=true;throw Error('PRIVATE before publication');}return writePrivateFileAtomic(...args);}}});
  const input=f.put();assert.throws(()=>f.shotText.put(input),code('LOCAL_SHOT_TEXT_STORAGE_UNAVAILABLE'));assert.equal(existsSync(f.file),false);
  const saved=f.shotText.put(input);assert.equal(saved.draftRevision,1);assert.equal(f.shotText.prepare(f.prepare(saved)).intent.outcome.status,'pending');assert.equal(f.calls.length,0);
});
