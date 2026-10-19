import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {isSubjectGenerationResponse} from '@mioon/contracts';
import {fixture,rowBytes} from './subject-video-fixture.mjs';

for(const kind of ['character','product','location'])test(`explicit ${kind} version freezes the full immutable manifest without editing the shot`,async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a,kind),shot=await f.shot(),before=rowBytes(f,'shots',shot.id),input=f.input(shot,subject.headVersionId),job=await f.call('generation.submit',input),saved=f.store.get('jobs',job.id);
 assert.equal(isSubjectGenerationResponse('generation.submit',input,job,{projectId:f.project.id}),true);
 assert.deepEqual(saved.snapshot.subjectReference,{subjectVersionId:subject.headVersionId,subjectName:subject.name,subjectKind:kind,subjectVersion:subject.headVersion});
 assert.deepEqual(saved.snapshot.referenceAssetIds,[a.id]);assert.deepEqual(saved.snapshot.referenceBindings,[{role:'subject_reference',assetId:a.id,sha256:a.sha256}]);assert.equal(saved.snapshot.referenceAssets[0].role,'subject_reference');
 assert.equal(saved.snapshot.inputProfileVersion,'mioon-input-profiles/3');assert.equal(saved.snapshot.inputProfileId,'mock:mock-motion-v1:v3');assert.equal(saved.snapshot.prompt,shot.prompt);assert.deepEqual(saved.snapshot.referenceConnections,[]);assert.equal(rowBytes(f,'shots',shot.id),before);
 await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id).status,'running');assert.equal(f.providers.get('mock').stats(input.requestId).submissionCount,1);
 const ledger=JSON.parse(f.store.db.prepare('SELECT snapshot_json FROM mock_provider_tasks WHERE request_id=?').get(input.requestId).snapshot_json);assert.equal(ledger.referenceAssets[0].role,'subject_reference');assert.deepEqual(ledger.subjectReference,saved.snapshot.subjectReference);
});

test('planning subject/style bindings never feed generation implicitly',async t=>{
 const f=await fixture(t),shot=await f.shot();for(const kind of ['product','look']){const subject=await f.subject(await f.asset(),kind);await f.call('subject.binding.set',{projectId:f.project.id,subjectId:subject.id,shotId:shot.id,role:kind==='look'?'style':'subject',subjectVersionId:subject.headVersionId,expectedRevision:0,expectedSubjectRevision:1,requestId:randomUUID()});}
 const job=await f.submit(shot);assert.deepEqual(job.snapshot.referenceAssetIds,[]);assert.equal(Object.hasOwn(job.snapshot,'subjectReference'),false);assert.deepEqual(f.store.get('shots',shot.id).referenceAssetIds,[]);
});

for(const type of ['first','tail','both','reference-edge','corrupt-edge','malformed-edge','null-edge','foreign-edge'])test(`subject selection rejects saved ${type} without deleting inputs`,async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),patch=type==='first'?{referenceAssetIds:[a.id]}:type==='tail'?{lastFrameAssetId:a.id}:type==='both'?{referenceAssetIds:[a.id],lastFrameAssetId:a.id}:{},shot=await f.shot(patch),node=await f.call('node.create',{projectId:f.project.id,type:'image',assetId:a.id,position:{x:0,y:0}});
 if(type.includes('edge')){const edge={id:randomUUID(),projectId:f.project.id,source:node.id,target:shot.id,kind:'reference',role:'first_frame',sourceAssetId:a.id};f.store.put('edges',edge);if(type==='corrupt-edge')f.store.put('edges',{...edge,kind:'decorative'});if(type==='malformed-edge')f.store.db.prepare('UPDATE edges SET data=? WHERE id=?').run('{private broken',edge.id);if(type==='null-edge')f.store.db.prepare('UPDATE edges SET data=? WHERE id=?').run('null',edge.id);if(type==='foreign-edge')f.store.db.prepare('UPDATE edges SET projectId=? WHERE id=?').run(f.other.id,edge.id);}
 const before=rowBytes(f,'shots',shot.id),edges=f.store.db.prepare('SELECT * FROM edges').all();await assert.rejects(f.submit(shot,subject.headVersionId),{code:'REFERENCE_STATE_CONFLICT'});assert.equal(rowBytes(f,'shots',shot.id),before);assert.deepEqual(f.store.db.prepare('SELECT * FROM edges').all(),edges);assert.equal(f.store.list('jobs').length,0);
});

test('ordinary owned decorative edge does not imply an image input',async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),shot=await f.shot(),source=await f.shot();await f.call('edge.create',{projectId:f.project.id,source:source.id,target:shot.id});assert.equal((await f.submit(shot,subject.headVersionId)).snapshot.subjectReference.subjectVersionId,subject.headVersionId);
});

test('style, absent, foreign, caller manifest and unsupported provider selectors fail closed',async t=>{
 const f=await fixture(t),shot=await f.shot(),a=await f.asset(),look=await f.subject(a,'look'),foreign=await f.subject(await f.asset({projectId:f.other.id}));
 await assert.rejects(f.submit(shot,look.headVersionId),{code:'UNSUPPORTED_SUBJECT_KIND'});await assert.rejects(f.submit(shot,randomUUID()));await assert.rejects(f.submit(shot,foreign.headVersionId));
 await assert.rejects(f.call('generation.submit',{...f.input(shot,look.headVersionId),subjectReference:{}}),{code:'VALIDATION_ERROR'});
 const subject=await f.subject(a);await assert.rejects(f.submit(shot,subject.headVersionId,{providerId:'runway'}),{code:'UNSUPPORTED_INPUT_ROLE'});assert.equal(f.store.list('jobs').length,0);
});

test('exact replay and retry retain the old selected version after head advancement and unhealthy new media',async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),shot=await f.shot(),input=f.input(shot,subject.headVersionId),job=await f.call('generation.submit',input),snapshot=JSON.stringify(job.snapshot),newAsset=await f.asset();
 await f.call('subject.version.add',{projectId:f.project.id,subjectId:subject.id,expectedRevision:1,assetId:newAsset.id,requestId:randomUUID()});f.store.put('assets',{...newAsset,sha256:'f'.repeat(64)});
 const historicalPage=await f.call('subject.version.list',{projectId:f.project.id,subjectId:subject.id,limit:1});assert.equal(historicalPage.items[0].id,subject.headVersionId);
 await f.call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{prompt:'Later prompt',referenceAssetIds:[a.id]},requestId:randomUUID()});
 assert.deepEqual(await f.call('generation.submit',input),job);await assert.rejects(f.call('generation.submit',{...input,subjectVersionId:randomUUID()}),{code:'IDEMPOTENCY_CONFLICT'});
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'failed'});const retryInput={jobId:job.id,requestId:randomUUID()},retry=await f.call('job.retry',retryInput);assert.equal(JSON.stringify(retry.snapshot),snapshot);assert.equal(retry.snapshot.subjectReference.subjectVersionId,subject.headVersionId);assert.equal(retry.retryOfJobId,job.id);assert.deepEqual(await f.call('job.retry',retryInput),retry);
});

test('subject exact replay/read disclosure does not re-evaluate clock, quota, credentials or current shot inputs',async t=>{
 const f=await fixture(t),a=await f.asset(),subject=await f.subject(a),shot=await f.shot();f.ark();const input=f.input(shot,subject.headVersionId,{providerId:'ark'}),job=await f.call('generation.submit',input);
 f.setDate('2099-01-01T00:00:00Z');f.providers.set('ark',{...f.providers.get('ark'),capabilities:{...f.providers.get('ark').capabilities,enabled:false}});
 assert.deepEqual(await f.call('generation.submit',input),job);assert.deepEqual(await f.call('job.get',{jobId:job.id}),job);assert.equal((await f.call('job.list',{projectId:f.project.id}))[0].id,job.id);assert.equal(f.posts(),0);
});

test('unknown subject submission never auto-posts again or permits retry',async t=>{
 const f=await fixture(t),subject=await f.subject(await f.asset()),shot=await f.shot(),job=await f.submit(shot,subject.headVersionId,{parameters:{scenario:'unknown'}});await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id).status,'submission_unknown');
 f.store.put('jobs',{...f.store.get('jobs',job.id),nextPollAt:0});await f.tick();await f.stop();await assert.rejects(f.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});await f.call('job.reconcile',{jobId:job.id});assert.equal(f.providers.get('mock').stats(job.requestId).submissionCount,1);assert.equal(f.store.list('jobs').length,1);
});
