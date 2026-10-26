import type {probe} from '../../packages/business/src/media.ts';
import type {TimelineExportAudioMeasurement} from '../../packages/contracts/src/timeline-export-float.ts';
export type FloatRenderResult=Awaited<ReturnType<typeof probe>> & {audioCheck:TimelineExportAudioMeasurement};
export interface ProbeJson {streams: {codec_type:string;codec_name:string;width:number;height:number;r_frame_rate:string;avg_frame_rate:string;nb_read_frames:string;sample_rate:string;channels:number;duration:string;channel_layout:string}[];format:{duration:string};frames:{media_type:string;best_effort_timestamp_time:string;pkt_duration_time:string}[]}
