import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {SUBJECT_REFERENCE_PROFILE_VERSION} from '@mioon/contracts';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';

// Entirely synthetic parser/byte fixtures. No renderer, credentials, or live HTTP.
function png(width=480,height=480){
 const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
function jpeg(width=480,height=480){
 // Synthetic JPEG SOF marker used only by the existing supported-byte parser.
 const bytes=Buffer.from([255,216,255,192,0,11,8,0,0,0,0,1,1,17,0,255,217]);
 bytes.writeUInt16BE(height,7);bytes.writeUInt16BE(width,9);return bytes;
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function fixture(t,{providerId='ark',mimeType='image/png',width=480,height=480,approved=true,reply,parameters={}}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subject-provider-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const bytes=mimeType==='image/jpeg'?jpeg(width,height):png(width,height),file=path.join(root,'synthetic-image');await writeFile(file,bytes);
 const projectId=randomUUID(),asset={id:randomUUID(),projectId,path:file,mimeType,sha256:sha(bytes),sizeBytes:bytes.length,width,height,role:'subject_reference'};
 const subjectVersion={id:randomUUID(),projectId,subjectId:randomUUID(),number:1,assetId:asset.id,sha256:asset.sha256,mimeType,width,height,provenance:{kind:'synthetic-mock',versionId:null,shotId:null,jobId:null},createdAt:'2026-10-11T00:00:00.000Z'};
 const model=providerId==='ark'?'doubao-seedance-2-5-260628':'mock-motion-v1';
 const snapshot={projectId,providerId,model,prompt:'  Synthetic object turns slowly. 保持原提示词。  ',aspectRatio:'9:16',duration:4,parameters,
  inputProfileId:`${providerId}:${model}:v3`,inputProfileVersion:SUBJECT_REFERENCE_PROFILE_VERSION,providerRegion:providerId==='ark'?'cn-beijing':'local',
  referenceAssetIds:[asset.id],referenceAssets:[asset],referenceBindings:[{role:'subject_reference',assetId:asset.id,sha256:asset.sha256}],referenceConnections:[],
  subjectReference:{subjectVersionId:subjectVersion.id,subjectName:'Synthetic object',subjectKind:'product',subjectVersion}};
 const calls=[],env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'INERT-SUBJECT-FIXTURE',ARK_APPROVED_ASSET_SHA256:approved?asset.sha256:''};
 let db,provider;
 if(providerId==='mock'){db=new DatabaseSync(':memory:');t.after(()=>db.close());provider=createMockProvider({root,db,now:()=>0});}
 else provider=createArkProvider({root,env,fetchImpl:async(url,options)=>{calls.push({url,options});return reply?reply(url,options):json({id:'offline-subject-task'});}});
 return {root,bytes,file,asset,subjectVersion,snapshot,calls,provider,db};
}

for(const aspectRatio of ['9:16','16:9'])for(const duration of [4,8])test(`Ark subject sends explicit ${aspectRatio}, ${duration}s, reference mode with unchanged prompt`,async t=>{
 const f=await fixture(t);Object.assign(f.snapshot,{aspectRatio,duration});let checks=0,fences=0;
 assert.equal(f.provider.validate(f.snapshot),true);
 assert.deepEqual(await f.provider.submit(f.snapshot,{validateReferenceState:()=>{checks++;},beforeSubmit:()=>{fences++;assert.equal(checks,5);}}),{providerJobId:'offline-subject-task'});
 assert.equal(fences,1);assert.equal(f.calls.length,1);const {url,options}=f.calls[0];
 assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
 assert.deepEqual(JSON.parse(options.body),{model:'doubao-seedance-2-5-260628',content:[{type:'text',text:f.snapshot.prompt},{type:'image_url',image_url:{url:`data:image/png;base64,${f.bytes.toString('base64')}`},role:'reference_image'}],duration,ratio:aspectRatio,omni_reference_task_type:'reference',resolution:'720p',output_format:'mp4',generate_audio:false});
 assert.equal(options.headers.Authorization,'Bearer INERT-SUBJECT-FIXTURE');assert.equal(options.headers['Idempotency-Key'],undefined);
 assert.doesNotMatch(JSON.stringify(f.provider.capabilities),/INERT-SUBJECT-FIXTURE/);assert.equal(f.provider.capabilities.liveVerified,false);
});

test('Ark subject JPEG bytes are transmitted as the approved JPEG data URI',async t=>{
 const f=await fixture(t,{mimeType:'image/jpeg'});await f.provider.submit(f.snapshot);
 assert.equal(JSON.parse(f.calls[0].options.body).content[1].image_url.url,`data:image/jpeg;base64,${f.bytes.toString('base64')}`);
});

for(const [width,height] of [[300,750],[750,300],[6000,6000]])test(`Ark subject metadata accepts inclusive image limits ${width}x${height}`,async t=>{
 const f=await fixture(t);Object.assign(f.asset,{width,height});Object.assign(f.subjectVersion,{width,height});assert.equal(f.provider.validate(f.snapshot),true);assert.equal(f.calls.length,0);
});
for(const [width,height,code] of [[299,480,'INVALID_REFERENCE_MANIFEST'],[480,6001,'INVALID_REFERENCE_MANIFEST'],[300,751,'INVALID_REFERENCE_MANIFEST'],[751,300,'INVALID_REFERENCE_MANIFEST']])test(`Ark rejects subject geometry ${width}x${height} before dispatch`,async t=>{
 const f=await fixture(t);Object.assign(f.asset,{width,height});Object.assign(f.subjectVersion,{width,height});await assert.rejects(f.provider.submit(f.snapshot),{code});assert.equal(f.calls.length,0);
});

const malformed={
 'missing subject record':s=>{delete s.subjectReference;},
 'null subject record':s=>{s.subjectReference=null;},
 'unknown subject field':s=>{s.subjectReference.externalUrl='https://example.test/input';},
 'unknown version field':s=>{s.subjectReference.subjectVersion.externalUrl='https://example.test/input';},
 'planning-only look kind':s=>{s.subjectReference.subjectKind='look';},
 'blank subject name':s=>{s.subjectReference.subjectName='   ';},
 'unfrozen request version field':s=>{s.subjectVersionId=s.subjectReference.subjectVersionId;},
 'incomplete provenance':s=>{delete s.subjectReference.subjectVersion.provenance;},
 'invalid provenance identities':s=>{s.subjectReference.subjectVersion.provenance.jobId=randomUUID();},
 'invalid version identity':s=>{s.subjectReference.subjectVersionId=randomUUID();},
 'foreign subject project':s=>{s.subjectReference.subjectVersion.projectId=randomUUID();},
 'different subject asset':s=>{s.subjectReference.subjectVersion.assetId=randomUUID();},
 'different subject hash':s=>{s.subjectReference.subjectVersion.sha256='1'.repeat(64);},
 'different subject MIME':s=>{s.subjectReference.subjectVersion.mimeType='image/jpeg';},
 'different subject dimensions':s=>{s.subjectReference.subjectVersion.width=640;},
 'missing profile version':s=>{delete s.inputProfileVersion;},
 'missing profile ID':s=>{delete s.inputProfileId;},
 'older profile':s=>{s.inputProfileVersion='mioon-input-profiles/2';s.inputProfileId=s.inputProfileId.replace(':v3',':v2');},
 'foreign region':s=>{s.providerRegion='global';},
 'unimplemented provider':s=>{s.providerId='runway';},
 'missing IDs':s=>{delete s.referenceAssetIds;},
 'different ID list':s=>{s.referenceAssetIds=[randomUUID()];},
 'missing binding':s=>{delete s.referenceBindings;},
 'extra binding field':s=>{s.referenceBindings[0].position=0;},
 'different binding hash':s=>{s.referenceBindings[0].sha256='1'.repeat(64);},
 'untyped asset':s=>{delete s.referenceAssets[0].role;},
 'first-frame asset':s=>{s.referenceAssets[0].role='first_frame';},
 'provider wire role':s=>{s.referenceAssets[0].role='reference_image';},
 'mixed first frame':s=>{s.referenceAssets.push({...s.referenceAssets[0],id:randomUUID(),role:'first_frame'});},
 'last-frame selection':s=>{s.lastFrameAssetId=randomUUID();},
 'first-frame connection':s=>{s.referenceConnections=[{role:'first_frame',sourceAssetId:s.referenceAssetIds[0]}];},
 'missing size':s=>{delete s.referenceAssets[0].sizeBytes;},
 'invalid size':s=>{s.referenceAssets[0].sizeBytes=0;},
};
for(const providerId of ['ark','mock'])for(const [name,change] of Object.entries(malformed))test(`${providerId} rejects ${name} without any submission`,async t=>{
 const f=await fixture(t,{providerId}),snapshot=structuredClone(f.snapshot);change(snapshot);
 await assert.rejects(f.provider.submit(snapshot,{requestId:`invalid-${name}`}));assert.equal(f.calls.length,0);if(f.db)assert.equal(f.provider.stats().submissionCount,0);
});

for(const providerId of ['ark','mock'])test(`${providerId} v3 cannot fall back to an omitted first-frame role`,async t=>{
 const f=await fixture(t,{providerId,width:360,height:640}),snapshot=f.snapshot;delete snapshot.subjectReference;delete snapshot.referenceAssets[0].role;snapshot.referenceBindings[0].role='first_frame';
 await assert.rejects(f.provider.submit(snapshot,{requestId:'no-role-fallback'}));assert.equal(f.calls.length,0);if(f.db)assert.equal(f.provider.stats().submissionCount,0);
});
for(const version of [1,2])test(`Ark archived v${version} untyped first frame preserves adaptive request and exact aspect checking`,async t=>{
 const f=await fixture(t,{width:360,height:640});delete f.snapshot.subjectReference;delete f.asset.role;delete f.snapshot.referenceBindings;
 f.snapshot.inputProfileVersion=`mioon-input-profiles/${version}`;f.snapshot.inputProfileId=f.snapshot.inputProfileId.replace(':v3',`:v${version}`);
 await f.provider.submit(f.snapshot);const body=JSON.parse(f.calls[0].options.body);assert.equal(body.ratio,'adaptive');assert.equal(body.content[1].role,'first_frame');assert.equal(body.omni_reference_task_type,undefined);
 f.asset.width=480;f.asset.height=480;await assert.rejects(f.provider.submit(f.snapshot),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});assert.equal(f.calls.length,1);
});

test('Ark v3 explicit first frame keeps adaptive ratio and does not gain subject geometry rules',async t=>{
 const f=await fixture(t,{width:360,height:640});delete f.snapshot.subjectReference;f.asset.role='first_frame';f.snapshot.referenceBindings[0].role='first_frame';
 await f.provider.submit(f.snapshot);const body=JSON.parse(f.calls[0].options.body);assert.equal(body.ratio,'adaptive');assert.equal(body.omni_reference_task_type,undefined);
 f.asset.width=480;f.asset.height=480;await assert.rejects(f.provider.submit(f.snapshot),{code:'REFERENCE_ASPECT_RATIO_MISMATCH'});assert.equal(f.calls.length,1);
});

test('Ark subject still requires the exact approved hash even for claimed generated provenance',async t=>{
 const f=await fixture(t,{approved:false});f.subjectVersion.provenance.kind='generated';
 await assert.rejects(f.provider.submit(f.snapshot),{code:'REFERENCE_NOT_APPROVED'});assert.equal(f.calls.length,0);
});
test('Ark subject metadata never enables construction-time or disabled-provider HTTP',async t=>{
 const f=await fixture(t),provider=createArkProvider({root:f.root,env:{ARK_API_KEY:'INERT-SUBJECT-FIXTURE',ARK_APPROVED_ASSET_SHA256:f.asset.sha256},fetchImpl:()=>assert.fail('Network forbidden')});
 assert.equal(provider.capabilities.enabled,false);assert.equal(provider.validate(f.snapshot),true);await assert.rejects(provider.submit(f.snapshot),{code:'PROVIDER_DISABLED'});
});
for(const [name,alter,code] of [
 ['changed bytes',async f=>{const bytes=Buffer.from(f.bytes);bytes[bytes.length-1]^=1;await writeFile(f.file,bytes);},'REFERENCE_CHANGED'],
 ['false MIME',async f=>{f.asset.mimeType=f.subjectVersion.mimeType='image/jpeg';},'INVALID_REFERENCE_TYPE'],
 ['oversize file',async f=>writeFile(f.file,Buffer.alloc(10*1024*1024+1)),'REFERENCE_TOO_LARGE'],
 ['oversize metadata',async f=>{f.asset.sizeBytes=10*1024*1024+1;},'INVALID_REFERENCE_MANIFEST'],
 ['actual dimensions differ',async f=>{f.asset.width=f.subjectVersion.width=500;},'REFERENCE_CHANGED'],
 ['asset URL',async f=>{f.asset.path='asset://not-a-managed-local-image';},'REFERENCE_UNAVAILABLE'],
 ['remote URL',async f=>{f.asset.path='https://example.test/private-image';},'REFERENCE_UNAVAILABLE'],
])test(`Ark subject ${name} is rejected before HTTP`,async t=>{const f=await fixture(t);await alter(f);await assert.rejects(f.provider.submit(f.snapshot),{code});assert.equal(f.calls.length,0);});

test('Ark subject managed storage cannot be escaped with a symlink',async t=>{
 const f=await fixture(t),outside=await mkdtemp(path.join(tmpdir(),'mioon-subject-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 const file=path.join(outside,'image.png');await writeFile(file,f.bytes);const link=path.join(f.root,'linked.png');await symlink(file,link);f.asset.path=link;
 await assert.rejects(f.provider.submit(f.snapshot),{code:'UNSAFE_REFERENCE_PATH'});assert.equal(f.calls.length,0);
});

for(const code of ['INVALID_REFERENCE_OWNERSHIP','PROVIDER_REGION_CHANGED','MODEL_LIFECYCLE_REVALIDATION_REQUIRED'])for(const boundary of [1,2,3,4,5])test(`Ark subject ${code} at image fence ${boundary} prevents POST`,async t=>{
 const f=await fixture(t);let checks=0;await assert.rejects(f.provider.submit(f.snapshot,{validateReferenceState:()=>{if(++checks===boundary)throw Object.assign(Error('Changed current state'),{code});}}),{code});assert.equal(f.calls.length,0);
});
for(const code of ['GENERATION_STATE_CHANGED','INVALID_REFERENCE_OWNERSHIP','PROVIDER_REGION_CHANGED','MODEL_LIFECYCLE_REVALIDATION_REQUIRED'])test(`Ark subject final synchronous ${code} fence prevents POST`,async t=>{
 const f=await fixture(t);await assert.rejects(f.provider.submit(f.snapshot,{beforeSubmit:()=>{throw Object.assign(Error('Changed before dispatch'),{code});}}),{code});assert.equal(f.calls.length,0);
});
for(const boundary of [1,2,3,4,5])test(`Ark subject abort at image fence ${boundary} is definitely before dispatch`,async t=>{
 const f=await fixture(t),controller=new AbortController();let checks=0;
 await assert.rejects(f.provider.submit(f.snapshot,{signal:controller.signal,validateReferenceState:()=>{if(++checks===boundary)controller.abort();}}),error=>error.code==='OPERATION_CANCELLED'&&error.beforeDispatch===true&&!error.uncertain);assert.equal(f.calls.length,0);
});

test('Ark subject abort in final synchronous fence is unsubmitted',async t=>{
 const f=await fixture(t),controller=new AbortController();await assert.rejects(f.provider.submit(f.snapshot,{signal:controller.signal,beforeSubmit:()=>controller.abort()}),error=>error.code==='OPERATION_CANCELLED'&&error.beforeDispatch===true&&!error.uncertain);assert.equal(f.calls.length,0);
});
test('Ark subject post-dispatch abort remains ambiguous with exactly one POST',async t=>{
 const controller=new AbortController(),f=await fixture(t,{reply:()=>{controller.abort();throw Error('Response lost after dispatch');}});
 await assert.rejects(f.provider.submit(f.snapshot,{signal:controller.signal}),error=>error.code==='SUBMISSION_UNKNOWN'&&error.uncertain===true);assert.equal(f.calls.length,1);
});
for(const [name,reply,uncertain] of [['lost response',()=>{throw Error('INERT-SUBJECT-FIXTURE');},true],['HTTP 500',()=>json({message:'INERT-SUBJECT-FIXTURE'},500),true],['HTTP 400',()=>json({},400),false],['missing receipt',()=>json({accepted:true}),true]])test(`Ark subject ${name} never causes a retry or raw-provider disclosure`,async t=>{
 const f=await fixture(t,{reply});await assert.rejects(f.provider.submit(f.snapshot),error=>Boolean(error.uncertain)===uncertain&&!error.message.includes('INERT-SUBJECT-FIXTURE'));assert.equal(f.calls.length,1);
 assert.equal(await f.provider.reconcile('unresolved-subject'),null);assert.equal((await f.provider.cancel('unresolved-subject')).remoteCancelled,false);assert.equal(f.calls.length,1);
});

test('Mock persists the full subject snapshot and advertises a metadata-only test pattern',async t=>{
 const f=await fixture(t,{providerId:'mock',parameters:{delayMs:0}});f.asset.path=path.join(f.root,'does-not-exist');
 const receipt=await f.provider.submit(f.snapshot,{requestId:'mock-subject-ledger'});const saved=f.db.prepare('SELECT snapshot_json FROM mock_provider_tasks WHERE provider_job_id=?').get(receipt.providerJobId);
 assert.deepEqual(JSON.parse(saved.snapshot_json),f.snapshot);assert.equal(f.provider.capabilities.referenceSimulation,'metadata-only');assert.equal(f.provider.capabilities.depictsPromptOrReferences,false);
 assert.equal((await f.provider.poll(receipt.providerJobId)).status,'succeeded');assert.deepEqual(await f.provider.reconcile('mock-subject-ledger'),receipt);assert.equal(f.provider.stats().submissionCount,1);assert.equal(f.calls.length,0);
});
test('Mock subject metadata permits positive dimensions and enforces PNG/JPEG with a 10 MiB limit',async t=>{
 const f=await fixture(t,{providerId:'mock'});f.asset.width=f.subjectVersion.width=1;f.asset.height=f.subjectVersion.height=10000;
 assert.equal(f.provider.validate(f.snapshot),true);f.asset.sizeBytes=10*1024*1024+1;await assert.rejects(f.provider.submit(f.snapshot,{requestId:'oversize-mock-subject'}),{code:'INVALID_REFERENCE_MANIFEST'});
 f.asset.sizeBytes=f.bytes.length;f.asset.mimeType=f.subjectVersion.mimeType='image/webp';await assert.rejects(f.provider.submit(f.snapshot,{requestId:'webp-mock-subject'}),{code:'INVALID_REFERENCE_MANIFEST'});assert.equal(f.provider.stats().submissionCount,0);
});
test('Mock accepted subject with lost response reconciles the same durable record',async t=>{
 const f=await fixture(t,{providerId:'mock',parameters:{scenario:'accepted_then_response_lost'}});
 await assert.rejects(f.provider.submit(f.snapshot,{requestId:'mock-subject-unknown'}),error=>error.code==='SUBMISSION_UNKNOWN'&&error.uncertain===true);
 const receipt=await f.provider.reconcile('mock-subject-unknown');assert.ok(receipt.providerJobId);assert.equal(f.provider.stats().submissionCount,1);assert.equal(f.provider.stats().taskCount,1);
 const saved=JSON.parse(f.db.prepare('SELECT snapshot_json FROM mock_provider_tasks WHERE provider_job_id=?').get(receipt.providerJobId).snapshot_json);assert.deepEqual(saved.subjectReference,f.snapshot.subjectReference);
});
test('Mock final subject fence stops before any provider ledger mutation',async t=>{
 const f=await fixture(t,{providerId:'mock'});await assert.rejects(f.provider.submit(f.snapshot,{requestId:'mock-subject-fence',beforeSubmit:()=>{throw Object.assign(Error('Subject version changed'),{code:'REFERENCE_CHANGED'});}}),{code:'REFERENCE_CHANGED'});assert.equal(f.provider.stats().submissionCount,0);
});
