import {EXPORT_SAMPLE_PEAK_ALGORITHM, exportSamplePeakReason} from '@mioon/contracts/export-sample-peak';
export const samplePeakOperation = 'timeline.export.samplePeak';
export const samplePeakInput = {projectId:'11111111-1111-4111-8111-111111111111',exportId:'22222222-2222-4222-8222-222222222222'};
export const samplePeakToken = 'synthetic-export-sample-peak-test-token';
export function readySamplePeak({left = 0.5, right = 0.25, fields = {}} = {}) {
  const peak = Math.max(left, right), db = value => value === 0 ? null : 20 * Math.log10(value);
  return {...samplePeakInput,algorithm:EXPORT_SAMPLE_PEAK_ALGORITHM,checkedAt:'2026-10-13T00:00:00.000Z',status:'ready',
    artifact:{assetId:'33333333-3333-4333-8333-333333333333',sha256:'a'.repeat(64),sizeBytes:1024,timelineRevision:4,...fields},
    measurement:{sampleRate:48000,channels:2,sampleFrames:48000,decodedDurationSeconds:1,peakLinear:peak,peakDbfs:db(peak),silent:peak===0,overFullScale:peak>1,
      channelPeaks:[{channel:0,label:'left',peakLinear:left,peakDbfs:db(left),silent:left===0},{channel:1,label:'right',peakLinear:right,peakDbfs:db(right),silent:right===0}]},
    reason:peak>1?exportSamplePeakReason('OVER_FULL_SCALE'):null,checks:{bytesHashed:2048,audioFullyDecoded:true}};
}
export function incompleteSamplePeak(code='BUSY') {
  return {...samplePeakInput,algorithm:EXPORT_SAMPLE_PEAK_ALGORITHM,checkedAt:'2026-10-13T00:00:00.000Z',status:'incomplete',artifact:null,measurement:null,
    reason:exportSamplePeakReason(code),checks:{bytesHashed:0,audioFullyDecoded:false}};
}
