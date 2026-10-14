import {timelineLoudnessCandidateDigest} from '@mioon/contracts/timeline-loudness-apply';
import {readyMixLoudness,mixLoudnessInput} from './timeline-mix-loudness-fixtures.mjs';
export async function loudnessApplyFixture({projectId=mixLoudnessInput.projectId,expectedRevision=mixLoudnessInput.expectedRevision,
 requestId='apply-wire-original-request'}={}){
 const prepareInput={...mixLoudnessInput,projectId,expectedRevision,target:{integratedLufs:-24,truePeakCeilingDbtp:-1}};
 const report=readyMixLoudness(prepareInput);
 const input={...prepareInput,requestId,snapshotSha256:report.identity.snapshotSha256,candidateDigest:await timelineLoudnessCandidateDigest(report)};
 const trackId='55555555-5555-4555-8555-555555555555',gain=report.candidate.gains[0];
 const timeline={id:report.identity.timelineId,projectId:input.projectId,revision:input.expectedRevision+1,fps:30,width:1280,height:720,
  tracks:[{id:trackId,name:'Sound',kind:'audio',orderIndex:0,hidden:false,muted:false}],
  clips:[{id:gain.clipId,trackId,assetId:gain.assetId,name:'Sound',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:1280,height:720},gain:gain.afterGain}],
  durationFrames:30,createdAt:'2026-10-14T00:00:00.000Z',updatedAt:'2026-10-14T01:00:00.000Z'};
 const response={operation:'timeline.loudness.apply',requestId:input.requestId,timeline,application:{candidateDigest:input.candidateDigest,snapshotSha256:input.snapshotSha256,
  mixProfile:input.mixProfile,measurementProfile:input.measurementProfile,target:input.target,beforeRevision:input.expectedRevision,afterRevision:input.expectedRevision+1,
  gainMultiplier:report.candidate.gainMultiplier,gains:report.candidate.gains,original:report.original,candidate:report.candidate.measurement,
  meetsTarget:true,meetsTruePeak:true,marginDb:.5}};
 return {input,report,response};
}
