import {deflateSync,crc32} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
export const stamp='2026-10-15T00:00:00.000Z';
export const sha=(bytes: Buffer|Uint8Array|string): string=>createHash('sha256').update(bytes).digest('hex');
export function pngChunk(type: string,data: Buffer=Buffer.alloc(0)): Buffer{const result=Buffer.alloc(12+data.length);result.writeUInt32BE(data.length);result.write(type,4,4,'ascii');data.copy(result,8);result.writeUInt32BE(crc32(result.subarray(4,result.length-4)),result.length-4);return result;}
export interface PngOptions {readonly width?: number; readonly height?: number; readonly rgba?: boolean; readonly tagged?: boolean; readonly pixel?: (x: number,y: number)=>readonly number[]; readonly extra?: readonly Buffer[]}
export function png({width=64,height=64,rgba=true,tagged=true,pixel=(_x: number,_y: number): readonly number[]=>[128,128,128,128],extra=[]}: PngOptions = {}): Buffer{
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=rgba?6:2;
 const channels=rgba?4:3,raw=Buffer.alloc((width*channels+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const values=pixel(x,y);for(let c=0;c<channels;c++)raw[y*(width*channels+1)+1+x*channels+c]=values[c];}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),...(tagged?[pngChunk('sRGB',Buffer.from([0]))]:[]),...extra,pngChunk('IDAT',deflateSync(raw)),pngChunk('IEND')]);
}
export interface ImageColourEvidence {readonly sha256: string; readonly [key: string]: unknown}
export function imageColour(evidence: ImageColourEvidence,look: unknown=null){return{profileId:'mioon-srgb-image-clip-v1',source:{assetSha256:evidence.sha256,profileId:'png-rgb8-srgb-v1',interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence},look};}
export function evidenceOnly(value: Record<string, unknown>): Record<string, unknown>{const{status: _status,...evidence}=value;return evidence;}
export interface TimelineFixtureAsset {readonly id: string; readonly projectId?: string; readonly [key: string]: unknown}
export function timelineFixture(assets: readonly TimelineFixtureAsset[],colours: readonly unknown[]){const projectId=assets[0].projectId??randomUUID(),tracks=assets.map((_asset,n: number)=>({id:randomUUID(),kind:'video',name:`Track ${n}`,orderIndex:n,hidden:false,muted:false}));return{id:randomUUID(),projectId,revision:1,fps:30,width:720,height:720,durationFrames:6,createdAt:stamp,updatedAt:stamp,tracks,clips:assets.map((asset,n: number)=>({id:randomUUID(),assetId:asset.id,trackId:tracks[n].id,name:`Clip ${n}`,startFrame:0,durationFrames:6,sourceInFrame:0,rect:{x:0,y:0,width:720,height:720},gain:1,colour:colours[n]}))};}
