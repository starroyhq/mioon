import {TIMELINE_JPEG_DECODE_PROFILE} from '../../contracts/src/timeline-colour.ts';

/** This is an explicit JFIF YCbCr -> RGB24 decoder boundary, not video 709.
 * JFIF's centered chroma is full-range BT.601. Freeze the integer IDCT,
 * software decoder, chroma upsampler, matrix/range and rounding policy. sRGB
 * transfer starts from THESE decoded RGB8 bytes; JPEG losses are separate.
 * Rejecting EXIF metadata and disabling autorotation are independent fences.
 */
export const JFIF_DECODE_PROFILE = TIMELINE_JPEG_DECODE_PROFILE;
export const JFIF_RGB24_FILTER = 'scale=iw:ih:flags=bilinear+accurate_rnd+full_chroma_int+bitexact:in_color_matrix=bt601:out_color_matrix=bt709:in_range=full:out_range=full:in_h_chr_pos=128:in_v_chr_pos=128,format=rgb24';
export const JFIF_INPUT_ARGS: readonly string[] = Object.freeze([
 '-cpuflags','0','-xerror','-err_detect','crccheck+bitstream+buffer+explode','-ec','0',
 '-max_pixels','2073600','-flags','+bitexact','-hwaccel','none','-c:v','mjpeg','-idct','int',
 '-f','image2','-pattern_type','none',
]);
export interface JfifDecoderRuntime {
 runStreaming(command:string,args:string[],options:{timeout:number;maxStdoutBytes:number;maxStderrBytes:number;
  signal?:AbortSignal;beforeEffect:()=>void;onStdout:(chunk:Uint8Array)=>void}):Promise<unknown>;
}
export async function validateJfifDecode(file:string,evidence:{width:number;height:number},options:{signal?:AbortSignal;beforeEffect:()=>void},runtime:JfifDecoderRuntime):Promise<void> {
 const expected=evidence.width*evidence.height*3;
 if(!Number.isSafeInteger(expected)||expected<3||expected>2073600*3)throw Object.assign(Error('JPEG decode budget exceeded.'),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
 let count=0;options.beforeEffect();
 await runtime.runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','1','-filter_threads','1',...JFIF_INPUT_ARGS,
  '-noautorotate','-i',file,'-map','0:v:0','-vf',JFIF_RGB24_FILTER,'-frames:v','1','-an','-threads','1','-c:v','rawvideo','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],
  {timeout:12000,maxStdoutBytes:expected,maxStderrBytes:65536,signal:options.signal,beforeEffect:options.beforeEffect,
   onStdout(chunk){options.beforeEffect();count+=chunk.byteLength;}});
 options.beforeEffect();
 if(count!==expected)throw Object.assign(Error('The complete JPEG RGB24 decode could not be verified.'),{code:'TIMELINE_COLOUR_SOURCE_UNSUPPORTED'});
}

export function jpegDecodeIdentity(evidence:{profileId:string;sampling?:string;orientation?:number;decoderPolicy?:string}):readonly unknown[] {
 if(evidence.profileId!=='jfif-ycbcr8-srgb-v1'||!['444','422','420'].includes(evidence.sampling??'')||evidence.orientation!==1||evidence.decoderPolicy!==JFIF_DECODE_PROFILE)
  throw Object.assign(Error('The frozen JPEG decode profile is invalid.'),{code:'INVALID_TIMELINE_COLOUR'});
 return [evidence.profileId,evidence.sampling,evidence.orientation,evidence.decoderPolicy,'jfif-centered-chroma-full-bt601','opaque-rgb24'];
}
