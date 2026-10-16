import test, {mock, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {Readable, Writable} from 'node:stream';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createFreshOpacityCandidateLaunch, closeUnusedOpacityCandidateLaunch, assertOpacityCandidateBuild} from '../apps/server/src/opacity-candidate-launch.ts';
import {parseOpacityCandidateArguments} from '../apps/server/src/opacity-candidate-cli.ts';
import {createOpacityCandidateRequestApplication, startServer} from '../apps/server/src/index.mjs';
import {onMediaProcess} from '../packages/business/src/media-processes.mjs';
import {clipDraftRaw, clipDraftSource} from '../apps/web/src/clip-draft-state.ts';
import {rawOpacityEnvelopeFields} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.js';

// No denied listener is retried. This suite invokes the actual shared HTTP
// handler with streams in memory and forbids every process/listen entrypoint.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++;throw Error('No listener, media or provider subprocess is permitted.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const media = [], unobserve = onMediaProcess(event => media.push(event));
after(() => {unobserve();mock.restoreAll();syncBuiltinESMExports();assert.equal(forbiddenAttempts, 0);assert.deepEqual(media, []);});

const token = 'synthetic-opacity-application-token', stamp = '2026-10-16T00:00:00.000Z';
const curve = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: 0}, {frame: 30, opacity: 1}]};
function base(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'mioon-opacity-app-'));
  t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'new42'), dist = path.join(parent, 'candidate-dist');
  fs.mkdirSync(dist, {mode: 0o700});
  fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
  fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>isolated opacity42 entry</html>');
  fs.writeFileSync(path.join(dist, 'index.html'), '<html>ordinary entry</html>');
  return {parent, root, dist};
}
async function request(app, pathname, {method = 'GET', input, headers: extra = {}, authenticate = true} = {}) {
  const data = input === undefined ? null : Buffer.from(JSON.stringify(input));
  const req = Readable.from(data ? [data] : []);
  Object.assign(req, {method, url: pathname, headers: {host: '127.0.0.1:4319', ...(authenticate ? {authorization: `Bearer ${token}`} : {}),
    ...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), ...extra}});
  const chunks = [], res = new Writable({write(chunk, _encoding, callback) {chunks.push(Buffer.from(chunk));callback();}});
  res.status = 0;res.headers = {};res.headersSent = false;
  res.setHeader = (name, value) => {res.headers[name.toLowerCase()] = value;};
  res.writeHead = (status, headers = {}) => {res.status = status;for (const [name, value] of Object.entries(headers))res.setHeader(name, value);res.headersSent = true;return res;};
  await app.handleRequest(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return {status: res.status, text, headers: res.headers, data: /^application\/json/u.test(res.headers['content-type'] ?? '') ? JSON.parse(text) : null};
}
async function rpc(app, operation, input = {}) {return request(app, '/api/rpc', {method: 'POST', input: {operation, input}});}
async function applyTask(app, projectId, operation, input) {
  const prepared = await request(app, '/api/tasks/prepare', {method: 'POST', input: {projectId, operation, input, origin: 'new'}});
  assert.equal(prepared.data.ok, true, prepared.text);
  const value = prepared.data.data;
  const executed = await request(app, `/api/tasks/${value.task.id}/execute`, {method: 'POST', input: {projectId, digest: value.task.digest, instanceId: value.instanceId}});
  assert.equal(executed.data.ok, true, executed.text);assert.equal(executed.data.data.task.status, 'applied');
  const acknowledged = await request(app, `/api/tasks/${value.task.id}/acknowledge`, {method: 'POST', input: {projectId, digest: value.task.digest, expectedRevision: executed.data.data.task.revision, status: 'applied'}});
  assert.equal(acknowledged.data.ok, true, acknowledged.text);
  return executed.data.data.result;
}
async function fixture(t) {
  const f = base(t), launch = createFreshOpacityCandidateLaunch(f.root);
  const app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: launch, port: 4319, distDir: f.dist, token});
  t.after(async () => {await app.close();});
  return {...f, app};
}

test('candidate launch is explicit, one-shot, fresh-only and requires the isolated build', async t => {
  const f = base(t);
  assert.throws(() => parseOpacityCandidateArguments([]), /new-workspace/);
  assert.throws(() => parseOpacityCandidateArguments(['--new-workspace', 'relative']), /absolute/);
  assert.throws(() => parseOpacityCandidateArguments(['--profile', '42']), /new-workspace/);
  assert.deepEqual(parseOpacityCandidateArguments(['--new-workspace', f.root]), {directory: f.root, port: 4319});
  const launch = createFreshOpacityCandidateLaunch(f.root);
  assert.throws(() => createFreshOpacityCandidateLaunch(f.root), {code: 'EEXIST'});
  for (const copy of [{...launch}, Object.create(launch), JSON.parse(JSON.stringify(launch))])
    await assert.rejects(createOpacityCandidateRequestApplication({opacityCandidateLaunch: copy, port: 4319, distDir: f.dist, token}), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  const app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: launch, port: 4319, distDir: f.dist, token});
  await assert.rejects(createOpacityCandidateRequestApplication({opacityCandidateLaunch: launch, port: 4319, distDir: f.dist, token}), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  await app.close();
  assert.equal(fs.existsSync(path.join(f.root, 'server.lock')), false);
  assert.throws(() => createFreshOpacityCandidateLaunch(f.root), {code: 'EEXIST'});
  fs.unlinkSync(path.join(f.dist, 'mioon-opacity-candidate-entry.json'));
  assert.throws(() => assertOpacityCandidateBuild(f.dist), {code: 'OPACITY_CANDIDATE_BUILD_REQUIRED'});
  const other = createFreshOpacityCandidateLaunch(path.join(f.parent, 'other42'));
  await assert.rejects(createOpacityCandidateRequestApplication({opacityCandidateLaunch: other, port: 4319, distDir: f.dist, token}), {code: 'OPACITY_CANDIDATE_BUILD_REQUIRED'});
  assert.equal(fs.existsSync(path.join(f.parent, 'other42', 'server.lock')), false);
  const invalidDistRoot=path.join(f.parent,'invalid-dist42'), invalidDistLaunch=createFreshOpacityCandidateLaunch(invalidDistRoot);
  await assert.rejects(createOpacityCandidateRequestApplication({opacityCandidateLaunch:invalidDistLaunch,distDir:null,port:4319,token}),TypeError);
  assert.equal(fs.existsSync(path.join(invalidDistRoot,'server.lock')),false);
});

test('actual shared handler serves candidate page, authenticates and excludes provider runtimes', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.app, '/', {authenticate: false})).text, '<html>isolated opacity42 entry</html>');
  assert.equal((await request(f.app, '/editor/project', {authenticate: false})).text, '<html>isolated opacity42 entry</html>');
  assert.equal((await request(f.app, '/health', {authenticate: false})).data.ok, true);
  assert.equal((await request(f.app, '/api/rpc', {method: 'POST', input: {operation: 'project.list'}, authenticate: false})).status, 401);
  assert.equal((await request(f.app, '/health', {headers: {host: 'untrusted.example'}})).status, 403);
  assert.equal((await request(f.app, '/health', {headers: {origin: 'https://untrusted.example'}})).status, 403);
  assert.deepEqual((await rpc(f.app, 'provider.list')).data.data, []);
  for (const route of ['/api/agent/settings', '/api/images/settings', '/api/comfy/settings', '/api/timeline-audio-preview/pcm'])
    assert.equal((await request(f.app, route)).data.error.code, 'RESTORE_OPERATION_UNAVAILABLE');
  for (const name of ['agent-settings', 'image-settings', 'comfy-settings']) assert.equal(fs.existsSync(path.join(f.root, name)), false);
  const closing = f.app.close();assert.equal(f.app.close(), closing);await closing;
  assert.equal((await request(f.app, '/health')).status, 503);
});

test('actual project, timeline, task ACK, v3 draft and delivery endpoints retain opacity', async t => {
  const f = await fixture(t), made = await rpc(f.app, 'project.create', {name: 'Synthetic application project'});
  assert.equal(made.data.ok, true, made.text);
  const project = made.data.data, read = await rpc(f.app, 'project.get', {projectId: project.id});
  assert.equal(read.data.data.project.id, project.id);
  const initial = await rpc(f.app, 'timeline.get', {projectId: project.id});
  assert.equal(initial.data.ok, true, initial.text);
  const timeline = initial.data.data, assetId = randomUUID();
  // Isolated metadata only: no real source, codec, provider or import probe.
  const asset = {id: assetId, projectId: project.id, name: 'Synthetic metadata only.mp4', mimeType: 'video/mp4', duration: 1,
    width: 720, height: 1280, hasVideo: true, hasAudio: true, sha256: 'a'.repeat(64), relativePath: 'media/never-opened.mp4', createdAt: stamp};
  const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
  try {
    db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId, project.id, JSON.stringify(asset));
  } finally {db.close();}
  const source = await rpc(f.app, 'asset.list', {projectId: project.id});assert.equal(source.data.data[0].relativePath, undefined);
  const addedTrack = await applyTask(f.app, project.id, 'timeline.track.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), kind: 'video', name: 'Application video'});
  const trackId = addedTrack.tracks.find(track => track.name === 'Application video').id;
  const seeded = await applyTask(f.app, project.id, 'timeline.clip.add', {projectId: project.id, expectedRevision: addedTrack.revision, requestId: randomUUID(), assetId, trackId, startFrame: 0, durationFrames: 30});
  const clip = seeded.clips[0], clipId = clip.id;
  const input = {projectId: project.id, clipId, expectedRevision: seeded.revision, requestId: randomUUID(), patch: {opacityEnvelope: curve}};
  const prepared = await request(f.app, '/api/tasks/prepare', {method: 'POST', input: {projectId: project.id, operation: 'timeline.clip.update', input, origin: 'new'}});
  assert.equal(prepared.data.ok, true, prepared.text);
  const task = prepared.data.data;
  const executed = await request(f.app, `/api/tasks/${task.task.id}/execute`, {method: 'POST', input: {projectId: project.id, digest: task.task.digest, instanceId: task.instanceId}});
  assert.equal(executed.data.ok, true, executed.text);assert.equal(executed.data.data.task.status, 'applied');
  assert.deepEqual(executed.data.data.result.clips[0].opacityEnvelope, curve);
  const acknowledged = await request(f.app, `/api/tasks/${task.task.id}/acknowledge`, {method: 'POST', input: {projectId: project.id, digest: task.task.digest, expectedRevision: executed.data.data.task.revision, status: 'applied'}});
  assert.equal(acknowledged.data.ok, true, acknowledged.text);
  const current = await rpc(f.app, 'timeline.get', {projectId: project.id});assert.deepEqual(current.data.data.clips[0].opacityEnvelope, curve);
  const draft = await request(f.app, `/api/local-drafts/clip?projectId=${project.id}&timelineId=${timeline.id}&clipId=${clipId}`);
  assert.equal(draft.data.data.supported, true, draft.text);
  const draftValue=draft.data.data, currentTimeline=current.data.data, currentClip=currentTimeline.clips[0];
  const raw={...clipDraftRaw(currentClip),...rawOpacityEnvelopeFields(currentClip)};
  raw.opacityEnvelope.points[0].opacity='.';
  const savedDraft=await request(f.app,'/api/local-drafts/clip',{method:'PUT',input:{projectId:project.id,timelineId:timeline.id,clipId,
    workspaceScope:draftValue.workspaceScope,instanceId:draftValue.instanceId,expectedRevision:draftValue.revision,
    baseRevision:currentTimeline.revision,source:clipDraftSource(currentClip,asset),raw}});
  assert.equal(savedDraft.data.ok,true,savedDraft.text);assert.equal(savedDraft.data.data.draft.raw.opacityEnvelope.points[0].opacity,'.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'local-drafts-v3.json'),'utf8')).version,3);
  const delivery = await request(f.app, `/api/local-delivery?projectId=${project.id}`);
  assert.equal(delivery.data.data.supported, true, delivery.text);
  const deliveryValue=delivery.data.data, authority={projectId:project.id,workspaceScope:deliveryValue.workspaceScope,instanceId:deliveryValue.instanceId};
  const title=await request(f.app,'/api/local-delivery/draft',{method:'PUT',input:{...authority,expectedDraftRevision:0,draftId:randomUUID(),timelineId:timeline.id,baseRevision:currentTimeline.revision,raw:{deliveryName:'Opacity application export'}}});
  assert.equal(title.data.ok,true,title.text);
  const preparedDelivery=await request(f.app,'/api/local-delivery/prepare',{method:'POST',input:{...authority,expectedIntentRevision:0,expectedIntentId:null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:currentTimeline.revision,
    draft:{draftId:title.data.data.draft.draftId,revision:title.data.data.draftRevision,raw:title.data.data.draft.raw},
    input:{projectId:project.id,requestId:randomUUID(),expectedRevision:currentTimeline.revision,purpose:'export',deliveryName:'Opacity application export'}}});
  assert.equal(preparedDelivery.data.ok,true,preparedDelivery.text);assert.equal(preparedDelivery.data.data.intent.outcome.status,'pending');
  const last = await request(f.app, '/api/last-project');assert.equal(last.data.data.supported, true, last.text);
  const preferences = await request(f.app, `/api/workspace-preferences/${project.id}`);assert.equal(preferences.data.ok, true, preferences.text);
  const preferenceState=defaultWorkspaceState();delete preferenceState.shared.assetSearch;preferenceState.activeMode='editing';preferenceState.editing.selectedClipId=clipId;
  const putPreferences=await request(f.app,`/api/workspace-preferences/${project.id}`,{method:'PUT',input:{expectedRevision:0,state:preferenceState}});
  assert.equal(putPreferences.data.ok,true,putPreferences.text);assert.equal(putPreferences.data.data.revision,1);
  const replayPreferences=await request(f.app,`/api/workspace-preferences/${project.id}`,{method:'PUT',input:{expectedRevision:0,state:preferenceState}});
  assert.deepEqual(replayPreferences.data.data,putPreferences.data.data);
  const nextPreferenceState={...preferenceState,editing:{...preferenceState.editing,playhead:3}};
  const nextPreferences=await request(f.app,`/api/workspace-preferences/${project.id}`,{method:'PUT',input:{expectedRevision:1,state:nextPreferenceState}});
  assert.equal(nextPreferences.data.ok,true,nextPreferences.text);assert.equal(nextPreferences.data.data.revision,2);
  assert.equal((await request(f.app,`/api/workspace-preferences/${project.id}`,{method:'PUT',input:{expectedRevision:0,state:preferenceState}})).data.error.code,'PREFERENCES_CONFLICT');
  await f.app.close();
  const closed = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
  try {assert.equal(closed.prepare('SELECT max(version) AS v FROM schema_version').get().v, 42);assert.deepEqual(JSON.parse(closed.prepare('SELECT data FROM timelines WHERE id=?').get(timeline.id).data).clips[0].opacityEnvelope, curve);} finally {closed.close();}
});

test('ordinary startServer rejects forged candidate proof before opening a directory or listening', async t => {
  const f = base(t), target = path.join(f.parent, 'must-not-open');
  await assert.rejects(startServer({dataDir: target, opacityCandidateLaunch: {profileId: 'mioon-workspace-v42'}, port: 4319}), {code: 'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
  assert.equal(fs.existsSync(target), false);
  const unused = createFreshOpacityCandidateLaunch(path.join(f.parent, 'unused'));
  closeUnusedOpacityCandidateLaunch(unused);
  assert.equal(fs.existsSync(path.join(f.parent, 'unused', 'server.lock')), false);
});

test('actual shared file response guards preview and export GET/HEAD/Range and refuses raw exports', async t => {
  const f=await fixture(t), project=(await rpc(f.app,'project.create',{name:'Synthetic playback bytes'})).data.data;
  let timeline=(await rpc(f.app,'timeline.get',{projectId:project.id})).data.data;
  const sourceId=randomUUID(), sourceBytes=Buffer.from('synthetic-import-source-bytes'), source={id:sourceId,projectId:project.id,name:'Synthetic source metadata',mimeType:'video/mp4',duration:1,
    width:720,height:1280,hasVideo:true,hasAudio:false,sha256:createHash('sha256').update(sourceBytes).digest('hex'),relativePath:`media/${sourceId}.mp4`,provenance:'user-import',createdAt:stamp};
  fs.writeFileSync(path.join(f.root,source.relativePath),sourceBytes,{flag:'wx',mode:0o600});
  let db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
  try{db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(sourceId,project.id,JSON.stringify(source));}finally{db.close();}
  const rawSource=await request(f.app,`/media/${sourceId}`);assert.equal(rawSource.status,200,rawSource.text);assert.equal(rawSource.text,sourceBytes.toString());
  const added=await rpc(f.app,'timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:sourceId,
    trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30,opacityEnvelope:curve});
  assert.equal(added.data.ok,true,added.text);timeline=added.data.data;
  for(const purpose of ['preview','export']){
    const response=await rpc(f.app,'timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose});
    assert.equal(response.data.ok,true,response.text);assert.equal(JSON.stringify(response.data).includes('relativePath'),false);
    const queued=response.data.data, assetId=randomUUID(), bytes=Buffer.from(`synthetic-${purpose}-output-bytes`), relativePath=`media/export-${queued.id}-${randomUUID()}.mp4`;
    fs.writeFileSync(path.join(f.root,relativePath),bytes,{flag:'wx',mode:0o600});
    const asset={id:assetId,projectId:project.id,name:'Synthetic output',mimeType:'video/mp4',provenance:'export',relativePath,url:`/media/${assetId}`,
      sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,createdAt:stamp};
    db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
    try{
      const raw=JSON.parse(db.prepare('SELECT data FROM exports WHERE id=?').get(queued.id).data);
      db.prepare('INSERT INTO assets(id,projectId,data) VALUES(?,?,?)').run(assetId,project.id,JSON.stringify(asset));
      db.prepare('UPDATE exports SET data=? WHERE id=?').run(JSON.stringify({...raw,status:'succeeded',assetId,url:asset.url,updatedAt:stamp}),queued.id);
    }finally{db.close();}
    const preview=`/media/${assetId}?preview=1&exportId=${queued.id}`;
    const playback=await request(f.app,preview);assert.equal(playback.status,200,playback.text);assert.equal(playback.text,bytes.toString());assert.equal(playback.headers['content-disposition'],'inline');
    const head=await request(f.app,preview,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');assert.equal(head.headers['content-length'],bytes.length);
    const range=await request(f.app,preview,{headers:{range:'bytes=3-9'}});assert.equal(range.status,206);assert.equal(range.text,bytes.subarray(3,10).toString());assert.equal(range.headers['content-range'],`bytes 3-9/${bytes.length}`);
    assert.equal((await request(f.app,`/media/${assetId}`)).status,404);
    const download=await request(f.app,`/media/${assetId}?download=1&exportId=${queued.id}`);
    assert.equal(download.status,purpose==='export'?200:404);
    if(purpose==='export'){assert.equal(download.text,bytes.toString());assert.match(download.headers['content-disposition'],/^attachment; filename="export-/);}
    db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
    try{db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,provenance:'user-import'}),assetId);}finally{db.close();}
    assert.equal((await request(f.app,`/media/${assetId}`)).status,404,'an export path cannot gain raw access by changing provenance');
    assert.equal((await request(f.app,preview)).status,404);
    const forgedPath=`media/${assetId}.mp4`;fs.copyFileSync(path.join(f.root,relativePath),path.join(f.root,forgedPath));
    db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
    try{db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...asset,relativePath:forgedPath,provenance:'user-import'}),assetId);}finally{db.close();}
    assert.equal((await request(f.app,`/media/${assetId}`)).status,404,'reverse export ownership cannot gain raw import access with a canonical import path');
    db=new DatabaseSync(path.join(f.root,'workbench.sqlite'));
    try{db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),assetId);db.prepare('DELETE FROM timeline_requests WHERE requestId=?').run(queued.requestId);}finally{db.close();}
    assert.equal((await request(f.app,preview)).status,404);
  }
  await f.app.close();
});
