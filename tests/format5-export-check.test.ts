import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hasRequestNotAppliedProof,isExportPreflightResponse} from '@mioon/contracts';
import {createBoardUiWireFixture, BOARD_IDS} from './helpers/board-ui-wire-fixture.ts';
import {freezeFormat5RenderSnapshot, readFormat5AudioProjection, readFormat5RenderProjection} from '../packages/business/src/format5-timeline-render.ts';
import {prepareTimelineReferenceHashes} from '../packages/business/src/timeline-reference-prepare.ts';

/** WT-1-05: a saved Format-5 timeline whose native rows are not a legacy
 * TimelineRecord must still reach the export capability/preflight boundary.
 * The old boundary read the native clip rows through the Format-3/4 recovery
 * validator, so `mainTrack`/`sequenceSource` made every clean project report
 * INVALID_TIMELINE_SNAPSHOT before any export could start. */
test('format-5 capability check accepts a saved timeline and blocks placeholders by code', async () => {
  const f = await createBoardUiWireFixture();
  const projectId = f.projectId;
  const settings = {profileId: 'mp4_h264_v1', resolution: 'native', rateControl: {mode: 'crf', quality: 'standard'}};
  const before: any = await f.services.call('timeline.export.capabilities',
    {projectId, expectedRevision: 1, exportSettings: settings});
  assert.equal(before.status, 'blocked');
  assert.equal(before.issues[0]?.code, 'PLACEHOLDER_CLIP', 'a placeholder is still a product blocker');

  // The board fixture carries synthetic asset rows; add the same relative
  // locator a managed import carries so the audio projection can resolve it.
  f.store.tx(() => {
    const asset = f.store.get('assets', BOARD_IDS.assetA) as any;
    f.store.put('assets', {...asset, sizeBytes: 1024, reference: {pathForm: 'relative', path: 'media/a.mp4',
      volume: null, sizeBytes: 1024, mtimeMs: 0, sampledSha256: 'a'.repeat(64), fullSha256: 'a'.repeat(64)}});
  });
  // Whole-timeline audio reads omit the placeholder instead of rejecting every
  // clip; render admission still reports the exact shot title.
  const audio = readFormat5AudioProjection(f.store)!;
  assert.deepEqual(audio.legacy.clips.map(clip => clip.id), [BOARD_IDS.clipA]);
  const render = readFormat5RenderProjection(f.store)!;
  assert.equal(render.legacy.clips.length, 2);
  assert.throws(() => freezeFormat5RenderSnapshot(f.store),
    (error: {code?: string; details?: {blockers?: {code: string; shotTitle?: string}[]}}) =>
      error.code === 'EXPORT_BLOCKED' && error.details?.blockers?.[0]?.code === 'PLACEHOLDER_CLIP'
      && error.details.blockers[0].shotTitle === '路口俯拍');
  assert.throws(() => freezeFormat5RenderSnapshot(f.store), (error: {message?: string}) => /路口俯拍/.test(error.message ?? ''));
  const preflightBlocked: any = await f.services.call('timeline.export.preflight',
    {projectId, expectedRevision: 1, exportSettings: settings});
  assert.equal(preflightBlocked.issues[0]?.code, 'PLACEHOLDER_CLIP');
  assert.equal(preflightBlocked.issues[0]?.shotTitle, '路口俯拍');
  // Reference preparation must skip the placeholder rather than rejecting the
  // selected-clip read; an unrelated clip's missing source is not opened here.
  assert.equal((await prepareTimelineReferenceHashes(f.store, projectId, {clipId: BOARD_IDS.clipB})).preparedBytes, 0);

  // Put the shot's selected version on the main track through the real
  // sequence write path; no native rows are patched by the test.
  const preview: any = await f.services.call('sequence.preview', {projectId, requestId: `export-check-${randomUUID()}`,
    intents: [{side: 'board', operation: {kind: 'board-version', nodeId: BOARD_IDS.shotB,
      version: {id: BOARD_IDS.versionB, sourceFrames: 120}}}]});
  await f.services.call('sequence.commit', {projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest});
  const current = f.store.get('timelines', BOARD_IDS.timeline) as any;
  const available: any = await f.services.call('timeline.export.capabilities',
    {projectId, expectedRevision: current.revision, exportSettings: settings});
  assert.equal(available.status, 'available', JSON.stringify(available));
  assert.equal(available.timelineId, current.id);
  assert.equal(available.issues.length, 0);

  const preflight: any = await f.services.call('timeline.export.preflight',
    {projectId, expectedRevision: current.revision, exportSettings: settings});
  assert.equal(preflight.timelineId, current.id);
  assert.notEqual(preflight.issues[0]?.code, 'INVALID_TIMELINE_SNAPSHOT',
    'the Format-5 native rows are no longer fed to the Format-3/4 validator');
  f.store.close();
  f.library.close();
});

import {execFileSync as execFile, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {testEnv} from './helpers/test-env.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';

const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fixedAt='2026-01-01T00:00:00.000Z';
const fid=(n:number)=>`99000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('format-5 capabilities, preflight and real render complete through the export worker', {timeout:180000}, async t => {
  const ffmpegBin=process.env.MIOON_FFMPEG_PATH??'ffmpeg',ffprobeBin=process.env.MIOON_FFPROBE_PATH??'ffprobe';
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-format5-export-full-'));
  const store=createProjectStore({projectId:fid(1),projectFile:path.join(root,'project.mioon'),targetFormat:5,
    locate:()=>({localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'temp')})});
  const library=openAppLibrary({dataDir:path.join(root,'app')});
  let availableBytes = 2 ** 40;
  const services=createServices(store,new Map(),{env:{},application:createProjectServiceApplication(library,undefined,{}),
    exportOptions:{availableBytes:()=>availableBytes,memoryAllows:()=>true}});
  t.after(async()=>{await services.drain();library.close();store.close();rmSync(root,{recursive:true,force:true});});
  const projectId=store.projectId;
  const media=(name:string,args:string[],mimeType:string,duration:number)=>{
    const file=path.join(root,name);execFile(ffmpegBin,['-v','error','-y',...args,file],{env:testEnv()});
    const bytes=readFileSync(file);return {file,bytes,sha256:sha256(bytes),sizeBytes:bytes.length,mimeType,duration};
  };
  const video=media('main.mp4',['-f','lavfi','-i','color=c=red:s=360x640:d=4:r=30','-pix_fmt','yuv420p'],'video/mp4',4);
  const overlay=media('overlay.mp4',['-f','lavfi','-i','color=c=green:s=360x640:d=2:r=30','-pix_fmt','yuv420p'],'video/mp4',2);
  const audio=media('audio.wav',['-f','lavfi','-i','sine=frequency=440:duration=4'],'audio/wav',4);
  const refs=[] as {reference:unknown;referenceRevision:number;sha256:string;sizeBytes:number}[];
  for(const item of [video,overlay,audio])refs.push(await referenceForPublishedMedia(store,item.file));
  const [videoRef,overlayRef,audioRef]=refs;
  const asset=(id:string,item:typeof video,ref:typeof videoRef,hasVideo:boolean,hasAudio:boolean)=>({id,projectId,name:path.basename(item.file),
    mimeType:item.mimeType,duration:item.duration,sha256:ref.sha256,sizeBytes:ref.sizeBytes,reference:ref.reference,
    referenceRevision:ref.referenceRevision,hasVideo,hasAudio,createdAt:fixedAt});
  const shotA=fid(3),clipA=fid(30),overlayClip=fid(32),audioClip=fid(33),vTrack=fid(70),v2Track=fid(72),aTrack=fid(71),
    timelineId=fid(50),rootNode=fid(2),mediaNode=fid(4),v1=fid(20),job=fid(90);
  const versionSnapshot={shotId:shotA,title:'主镜头',prompt:'real media',referenceAssetIds:[],referenceAssets:[],referenceConnections:[],
    aspectRatio:'9:16',duration:4,providerId:'mock',model:'mock-motion-v1',parameters:{}};
  const timeline={id:timelineId,projectId,revision:1,width:720,height:1280,fps:30,durationFrames:120,createdAt:fixedAt,updatedAt:fixedAt,
    mainTrack:{trackId:vTrack,sequenceNodeId:rootNode},
    tracks:[{id:vTrack,name:'V1',kind:'video',orderIndex:0,hidden:false,muted:false},
      {id:v2Track,name:'V2',kind:'video',orderIndex:1,hidden:false,muted:false},
      {id:aTrack,name:'A1',kind:'audio',orderIndex:2,hidden:false,muted:false}],
    clips:[
      {id:clipA,trackId:vTrack,name:'主镜头',startFrame:0,durationFrames:120,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
        assetId:fid(10),sourceState:'ready',
        sequenceSource:{kind:'media',nodeId:mediaNode,segmentGroupId:fid(40)}},
      {id:overlayClip,trackId:v2Track,name:'叠加',startFrame:30,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
        assetId:fid(12),sourceState:'ready',anchor:{clipId:clipA,offsetFrames:30}},
      {id:audioClip,trackId:aTrack,name:'声音',startFrame:0,durationFrames:120,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,
        assetId:fid(13),sourceState:'ready',anchor:{clipId:clipA,offsetFrames:0}},
    ],
    subtitles:{profileId:'bottom_cjk_v1',cues:[{id:fid(80),text:'字幕',startFrame:30,durationFrames:30,anchor:{clipId:clipA,offsetFrames:30}}]}};
  const baseline={version:1,board:[{nodeId:mediaNode,kind:'media',assetId:fid(10)}],
    track:[{nodeId:mediaNode,segmentGroupId:fid(40),clipId:clipA,kind:'media',assetId:fid(10)}]};
  store.tx(()=>{
    store.put('projects',{id:projectId,name:'Format 5 full export',createdAt:fixedAt,updatedAt:fixedAt,revision:1});
    store.put('assets',asset(fid(10),video,videoRef,true,false));
    store.put('assets',asset(fid(12),overlay,overlayRef,true,false));
    store.put('assets',asset(fid(13),audio,audioRef,false,true));
    store.put('nodes',{id:rootNode,projectId,type:'sequence_root',name:'成片',position:{x:0,y:0},createdAt:fixedAt});
    store.put('nodes',{id:mediaNode,projectId,type:'video',assetId:fid(10),name:'主镜头',position:{x:0,y:0},createdAt:fixedAt});
    store.put('edges',{id:fid(95),projectId,kind:'sequence',source:rootNode,target:mediaNode,createdAt:fixedAt});
    store.put('timelines',timeline);
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId,projectId,rootNode,1,JSON.stringify(baseline));
  });
  for(const aid of [fid(10),fid(12),fid(13)])console.error('OWN',aid,Boolean(readOwnedTimelineAsset(store.db,projectId,aid)));
  console.error('JOBROW',JSON.stringify((store.get('jobs',job) as any)));console.error('VERROW',JSON.stringify((store.get('versions',v1) as any)));console.error('ASSETROW',JSON.stringify((store.get('assets',fid(10)) as any)));
  const settings={profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
  availableBytes=1;
  const resourceInput={projectId,expectedRevision:1,exportSettings:{...settings,resolution:'short_2160'}};
  const blocked=await services.call('timeline.export.preflight',resourceInput) as {status:string;issues:{code:string;details:unknown}[];checks:{checkedAssets:number}};
  assert.ok(isExportPreflightResponse(blocked,resourceInput));
  assert.equal(blocked.status,'blocked');assert.equal(blocked.checks.checkedAssets,0);
  assert.equal(blocked.issues[0]?.code,'EXPORT_DISK_SPACE_INSUFFICIENT');
  const blockedRequest={...resourceInput,requestId:randomUUID(),purpose:'export'};
  await assert.rejects(services.call('timeline.render',blockedRequest),(raw:unknown)=>{
    const error=raw as {code:string;details:Record<string,unknown>};
    assert.equal(error.code,'EXPORT_DISK_SPACE_INSUFFICIENT');
    assert.equal(error.details.availableBytes,availableBytes);
    assert.ok(hasRequestNotAppliedProof(error,blockedRequest,{operation:'timeline.render'}));
    return true;
  });
  assert.equal(store.list('exports').length,0);
  availableBytes=2 ** 40;
  const capability:any=await services.call('timeline.export.capabilities',{projectId,expectedRevision:1,exportSettings:settings});
  assert.equal(capability.status,'available',JSON.stringify(capability));
  const preflight:any=await services.call('timeline.export.preflight',{projectId,expectedRevision:1,exportSettings:settings});
  if(!spawnSync(ffmpegBin,['-filters'],{encoding:'utf8',env:testEnv()}).stdout.includes('drawtext')){
    // Local Homebrew ffmpeg lacks libfreetype; CI's reviewed media toolchain has it.
    assert.equal(preflight.status,'blocked');
    assert.equal(preflight.issues[0]?.code,'SUBTITLE_RENDERER_UNAVAILABLE');
    return;
  }
  assert.equal(preflight.status,'ready',JSON.stringify(preflight));
  const accepted:any=await services.call('timeline.render',{projectId,expectedRevision:1,
    requestId:`format5-render-${fid(99)}`,purpose:'export',exportSettings:settings});
  assert.equal(accepted.status,'queued');
  const worker=startWorker(store,services,new Map());
  try{for(let i=0;i<120;i++){await worker.tick();const value:any=await services.call('export.get',{exportId:accepted.id});
    if(['succeeded','failed'].includes(value.status))break;await new Promise(resolve=>setTimeout(resolve,50));}}
  finally{await worker.stop();}
  const done:any=await services.call('export.get',{exportId:accepted.id});
  assert.equal(done.status,'succeeded',JSON.stringify(done.error));
  assert.equal(typeof done.assetId,'string');
  const outputAsset=store.get('assets',done.assetId) as any;
  const outputFile=path.resolve(store.projectDir,outputAsset.reference.path);
  assert.ok(statSync(outputFile).size>0);
  const probe=JSON.parse(execFile(ffprobeBin,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',outputFile],{encoding:'utf8',env:testEnv()}));
  assert.ok(probe.streams.some((stream:any)=>stream.codec_type==='video'));
  assert.ok(probe.streams.some((stream:any)=>stream.codec_type==='audio'));
  assert.ok(Number(probe.format.duration)>3,'output duration follows the frozen 4s timeline');
});
