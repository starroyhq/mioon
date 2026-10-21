import {run,checkMediaEffect} from './media-runtime.ts';

interface SubtitleRendererOptions {signal?: AbortSignal;beforeEffect?: (()=>void)|undefined}
export interface SubtitleRendererCapability {textShaping: boolean}
const fault=(code: string,message: string): Error=>Object.assign(Error(message),{code});
const unavailable=(): never=>{throw fault('SUBTITLE_RENDERER_UNAVAILABLE','This FFmpeg build lacks the drawtext options required for the fixed subtitle profile. Select a build with libfreetype and libharfbuzz.');};
const unverified=(): never=>{throw fault('SUBTITLE_RENDERER_UNVERIFIED','The subtitle renderer capabilities could not be verified.');};
const required=['fontfile','textfile','expansion','fontsize','borderw','line_spacing','fontcolor','bordercolor','x','y'];

// A complete filter-specific help response proves option absence. Truncated or
// unrelated output must not silently enable FFmpeg's default text shaping.
export function parseSubtitleRendererCapability(output: string): SubtitleRendererCapability {
 const text=output.replaceAll('\r\n','\n').trim();
 if(/^Unknown filter ['"]drawtext['"]\.?(?:\n|$)/u.test(text))return unavailable();
 if(!text.startsWith('Filter drawtext\n')||!text.includes('\ndrawtext AVOptions:\n')||
  !/\nThis filter has support for timeline through the 'enable' option\.(?:\n\s*Exiting with exit code 0)?$/u.test(text))return unverified();
 const options=new Map<string,string>();
 for(const match of text.matchAll(/^\s+(\w+)\s+<([^>\n]+)>\s+/gmu)){
  if(options.has(match[1]))return unverified();
  options.set(match[1],match[2]);
 }
 if(required.some(name=>!options.has(name)))return unavailable();
 const shaping=options.get('text_shaping');
 if(shaping!==undefined&&shaping!=='boolean')return unverified();
 return {textShaping:shaping!==undefined};
}

/** Read-only, bounded help inspection; no cue, font, output file or encoding.
 * Deliberately uncached: changing a configured executable must be observed. */
export async function inspectSubtitleRenderer({signal,beforeEffect}: SubtitleRendererOptions={}): Promise<SubtitleRendererCapability>{
 checkMediaEffect(beforeEffect,signal);
 const output=await run('ffmpeg',['-hide_banner','-h','filter=drawtext'],{signal,beforeEffect,timeout:15000,maxStdoutBytes:64*1024,maxStderrBytes:64*1024});
 checkMediaEffect(beforeEffect,signal);
 return parseSubtitleRendererCapability(output);
}
