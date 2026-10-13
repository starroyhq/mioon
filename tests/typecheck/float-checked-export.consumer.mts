import {TIMELINE_EXPORT_FLOAT_PROFILE_ID,TIMELINE_EXPORT_FLOAT_POLICY_ID,isTimelineExportAudioMeasurement,isTimelineExportAudioCheck,isTimelineExportAudioOutcome,isTimelineExportFloatReadResponse,resolveTimelineExportFloatDelivery} from '@mioon/contracts/timeline-export-float';
import type {TimelineExportSettings,TimelineExportAudioMeasurement,TimelineExportAudioCheck} from '@mioon/contracts/timeline-export-float';
import type {LocalDeliveryExportSettings} from '@mioon/contracts/local-delivery';

const settings:TimelineExportSettings={profileId:TIMELINE_EXPORT_FLOAT_PROFILE_ID,resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
const retained:LocalDeliveryExportSettings=settings;
const delivery=resolveTimelineExportFloatDelivery({fps:30,width:720,height:1280},retained);
const codec:'pcm_f32le'=delivery.effective.intermediateAudio.codec;
const policy:typeof TIMELINE_EXPORT_FLOAT_POLICY_ID=delivery.effective.preencodeAudioPolicy.policyId;
declare const value:unknown;
if(isTimelineExportAudioMeasurement(value,30)){const measurement:TimelineExportAudioMeasurement=value;void measurement;}
if(isTimelineExportAudioCheck(value)){const report:TimelineExportAudioCheck=value;void report;}
const valid:boolean=isTimelineExportAudioOutcome(value,{snapshotSha256:'a'.repeat(64),assetSha256:'b'.repeat(64)});
const readValid:boolean=isTimelineExportFloatReadResponse(value,'export-id',(_row,input)=>typeof input.requestId==='string');
// @ts-expect-error Unknown profiles must not enter durable export inputs.
const unknownProfile:TimelineExportSettings={profileId:'future-profile',resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
void [codec,policy,valid,readValid,unknownProfile];
