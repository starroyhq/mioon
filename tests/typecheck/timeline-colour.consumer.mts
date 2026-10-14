import {clipColourSchema, timelineClipColourSchema, createTimelineColourPlan, projectTimelineColourPlan,
  isTimelineColourSnapshot, isTimelineColourSourceInspection, timelineColourPixelBitDepth,
  timelineColourSourceEvidenceStatus} from '../../packages/contracts/src/timeline-colour.ts';
import type {ClipColour, TimelineClipColour, TimelineColourPlan, TimelineColourSourceEvidence,
  TimelineColourSourceInspection} from '../../packages/contracts/src/timeline-colour.ts';
const disabled: ClipColour = null;
const active: TimelineClipColour = {profileId:'mioon-rec709-sdr-clip-v1',source:null,look:null};
clipColourSchema.parse(disabled);
timelineClipColourSchema.parse(active);
const evidence: TimelineColourSourceEvidence = {primaries:null,transfer:null,matrix:null,range:null,pixelFormat:'yuv420p',bitDepth:8,hdrMetadata:false};
const status: TimelineColourSourceInspection['status'] = timelineColourSourceEvidenceStatus(evidence);
const bits: number | null = timelineColourPixelBitDepth('yuv420p');
const first: TimelineColourPlan | undefined = createTimelineColourPlan({clips:[],tracks:[]},[]);
const second: TimelineColourPlan | undefined = projectTimelineColourPlan({timeline:{clips:[],tracks:[]},assets:[]});
const valid: boolean = isTimelineColourSnapshot({timeline:{clips:[],tracks:[]},assets:[]});
function accepted(value: unknown, input: unknown): TimelineColourSourceInspection | null {
  return isTimelineColourSourceInspection(value,input) ? value : null;
}
void [status,bits,first,second,valid,accepted];
// @ts-expect-error A technical LUT never satisfies the creative declaration.
const unsupported: TimelineClipColour = {profileId:'mioon-log-hdr-clip-v1',source:null,look:null};
void unsupported;
