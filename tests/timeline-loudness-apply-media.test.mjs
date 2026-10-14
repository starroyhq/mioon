import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createClient} from '@mioon/client';
import {isTimelineMutationResponse} from '@mioon/contracts';
import {timelineLoudnessCandidateDigest} from '@mioon/contracts/timeline-loudness-apply';
import {startServer} from '../apps/server/src/index.mjs';
import {mediaEnvironment,mediaExecutable} from '../packages/business/src/media-environment.mjs';

const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const operation='timeline.loudness.apply',profile='bs1770-5-48k-stereo-fir4x-v1';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function wav(){
 const frames=144000,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);
 bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);
 for(let frame=0;frame<frames;frame++){const value=Math.round(.2*32767*Math.sin(2*Math.PI*997*frame/48000));bytes.writeInt16LE(value,44+frame*4);bytes.writeInt16LE(-value,46+frame*4);}return bytes;
}
function withoutRevision(value){const {revision,updatedAt,...rest}=value;return rest;}

// Genuine shared HTTP services and production export worker. No mocked decoder,
// capability list, renderer or measurement result participates in this gate.
test('real apply undo redo and explicit float-v2 export remeasure the final AAC artifact while legacy output stays identical',{timeout:120000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-loudness-apply-media-'));let backend,db;
 t.after(async()=>{db?.close();await backend?.close();await rm(root,{recursive:true,force:true});});
 backend=await startServer({dataDir:root,port:0,chatGateway:async function*(){throw Error('No model call permitted');}});
 const client=createClient({env:{...mediaEnvironment(),MIOON_BASE_URL:backend.url,MIOON_TOKEN:backend.token,MIOON_ENABLE_LIVE_PROVIDER:'0'}});
 const project=await client.rpc('project.create',{name:'固定增益 应用撤销与真实成片'}),bytes=wav();
 const source=await client.rpc('asset.import',{projectId:project.id,name:'Known stereo 997 Hz.wav',mimeType:'audio/wav',dataBase64:bytes.toString('base64')});
 let timeline=await client.rpc('timeline.get',{projectId:project.id});
 timeline=await client.rpc('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
  trackId:timeline.tracks.find(track=>track.kind==='audio').id,assetId:source.id,startFrame:0,durationFrames:90,gain:.75});
 const original=structuredClone(timeline);db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});
 const record=id=>JSON.parse(db.prepare('SELECT data FROM exports WHERE id=?').get(id).data);
 const asset=id=>JSON.parse(db.prepare('SELECT data FROM assets WHERE id=?').get(id).data);
 const originalSource=asset(source.id),sourceFile=path.join(root,originalSource.relativePath);
 async function render(exportSettings){
  const input={projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(exportSettings?{exportSettings}:{})};
  const queued=await client.rpc('timeline.render',input);let result;
  for(const deadline=Date.now()+40000;Date.now()<deadline;){result=await client.rpc('export.get',{exportId:queued.id});if(['succeeded','failed'].includes(result.status))break;await pause(25);}
  assert.equal(result?.status,'succeeded',JSON.stringify(result?.error));
  const saved=record(result.id),output=asset(result.assetId),file=path.join(root,output.relativePath),raw=await readFile(file);
  assert.equal(output.sha256,sha(raw));assert.deepEqual(await client.rpc('timeline.render',input),queued);
  return {input,queued,result,saved,output,file,raw};
 }
 const legacy=await render();assert.equal(Object.hasOwn(legacy.saved.snapshot,'delivery'),false);
 const prepareInput={projectId:project.id,expectedRevision:timeline.revision,mixProfile:'timeline-float-mix-v1',measurementProfile:profile,
  target:{integratedLufs:-30,truePeakCeilingDbtp:-1}};
 const report=await client.rpc('timeline.loudness.prepare',prepareInput);assert.equal(report.candidate.status,'measured');assert.equal(report.candidate.meetsTarget,true);assert.equal(report.candidate.meetsTruePeak,true);
 const input={...prepareInput,requestId:randomUUID(),snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
 const applied=await client.rpc(operation,input);assert.equal(isTimelineMutationResponse(operation,input,applied),true);timeline=applied.timeline;
 assert.equal(timeline.revision,original.revision+1);assert.equal(timeline.clips[0].gain,report.candidate.gains[0].afterGain);
 const expected=structuredClone(original);expected.clips[0].gain=timeline.clips[0].gain;assert.deepEqual(withoutRevision(timeline),withoutRevision(expected));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM timeline_history WHERE operation=?').get(operation).n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,1);
 timeline=await client.rpc('timeline.undo',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID()});
 assert.deepEqual(withoutRevision(timeline),withoutRevision(original));assert.deepEqual(await client.rpc(operation,input),applied);
 const legacyAfterUndo=await render();assert.deepEqual(legacyAfterUndo.raw,legacy.raw,'Same legacy render bytes after gain undo; omitted old input and delivery stay omitted');
 timeline=await client.rpc('timeline.redo',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID()});
 assert.deepEqual(withoutRevision(timeline),withoutRevision(applied.timeline));
 const output=await render({profileId:'mp4_h264_float_checked_v2',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}});
 assert.equal(output.saved.snapshot.delivery.exportSettings.profileId,'mp4_h264_float_checked_v2');
 assert.equal(output.result.audioCheck.status,'complete');assert.equal(output.result.audioCheck.code,'EXPORT_AUDIO_WITHIN_LIMIT');
 const observation=await client.rpc('timeline.export.loudness',{projectId:project.id,exportId:output.result.id,expectedArtifactSha256:sha(output.raw),measurementProfile:profile,target:prepareInput.target});
 assert.equal(observation.status,'ready');assert.equal(observation.measurement.state,'valid');
 assert.ok(Math.abs(observation.measurement.integratedLufs-prepareInput.target.integratedLufs)<=.2,JSON.stringify(observation.measurement));
 assert.ok(observation.measurement.truePeakDbtp<=prepareInput.target.truePeakCeilingDbtp-.5);
 // Independent official FFmpeg ebur128 reference for the actual encoded file.
 const reference=await execute(mediaExecutable('ffmpeg'),['-hide_banner','-nostats','-loglevel','info','-nostdin','-threads','1','-i',output.file,
  '-map','0:a:0','-vn','-sn','-dn','-af','ebur128=peak=true','-f','null','-'],{env:mediaEnvironment(),encoding:'utf8',maxBuffer:1024*1024,timeout:30000});
 const lufs=[...reference.stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?) LUFS/gu)].at(-1),peak=[...reference.stderr.matchAll(/Peak:\s*(-?(?:\d+(?:\.\d+)?|inf)) dBFS/gu)].at(-1);
 assert.ok(lufs&&peak);assert.ok(Math.abs(observation.measurement.integratedLufs-Number(lufs[1]))<=.11);
 assert.ok(Math.abs(observation.measurement.truePeakDbtp-Number(peak[1]))<=.6);
 const probe=JSON.parse((await execute(mediaExecutable('ffprobe'),['-v','error','-count_frames','-show_streams','-show_format','-of','json',output.file],{env:mediaEnvironment(),encoding:'utf8',maxBuffer:65536,timeout:10000})).stdout);
 const video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
 assert.equal(video.codec_name,'h264');assert.equal(video.r_frame_rate,'30/1');assert.equal(Number(video.nb_read_frames),90);assert.equal(audio.codec_name,'aac');assert.equal(Number(audio.sample_rate),48000);assert.equal(audio.channels,2);
 assert.equal(sha(await readFile(sourceFile)),sha(bytes));assert.deepEqual(asset(source.id),originalSource);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM timeline_history WHERE operation=?').get(operation).n,1);
 const evidence={sourceSha256:sha(bytes),legacyBeforeSha256:sha(legacy.raw),legacyAfterUndoSha256:sha(legacyAfterUndo.raw),legacyBytesIdentical:true,
  applyRequestId:input.requestId,beforeRevision:original.revision,afterRevision:applied.timeline.revision,finalRevision:timeline.revision,gains:applied.application.gains,
  candidate:report.candidate.measurement,finalArtifact:{sha256:sha(output.raw),bytes:output.raw.length,profile:output.saved.snapshot.delivery.exportSettings.profileId,frames:Number(video.nb_read_frames),width:video.width,height:video.height},
  measured:observation.measurement,ffmpegReference:{integratedLufs:Number(lufs[1]),truePeakDbtp:Number(peak[1])},note:'Only this synthetic final artifact establishes measured output; no universal AAC target guarantee.'};
 await mkdir('evidence/loudness-apply',{recursive:true});await writeFile('evidence/loudness-apply/actual-media-summary.json',JSON.stringify(evidence,null,2)+'\n');
});
