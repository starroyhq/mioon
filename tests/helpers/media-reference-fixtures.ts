import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {png} from './timeline-image-fixtures.ts';
import path from 'node:path';
import {mediaReferenceSchema} from '../../packages/contracts/src/media-reference.ts';
import {resolveReferencePath} from '../../packages/business/src/media-reference/paths.ts';
import type {MediaReference} from '../../packages/contracts/src/media-reference.ts';
/** A closed metadata-only fixture for pure ownership/contract tests. Filesystem
 * tests use the real L1 sampler instead. */
export function mediaReferenceFixture(path: string, sizeBytes: number, sha256: string): MediaReference {
 return {pathForm: 'relative', path, volume: null, sizeBytes, mtimeMs: 0, sampledSha256: sha256, fullSha256: sha256};
}
/** Header-valid input for tests whose decoder is explicitly stubbed. It is not
 * represented as a decodable MP4 in an integration test. */
export function mp4HeaderFixture(text: string): Buffer {
 return Buffer.concat([Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]), Buffer.from(text)]);
}

export function mediaFixturePath(root: string, asset: unknown): string {
 if (!asset || typeof asset !== 'object') throw new TypeError('Missing fixture asset');
 if ('reference' in asset) {const file = resolveReferencePath(root, mediaReferenceSchema.parse(asset.reference)); if (!file) throw new TypeError('Non-local fixture asset'); return file;}
 if ('relativePath' in asset && typeof asset.relativePath === 'string') return path.join(root,asset.relativePath);
 throw new TypeError('Missing fixture locator');
}


/** Explicit positive data for business tests whose decoder is absent/stubbed.
 * Video/container fixtures satisfy L1 headers only; real codec tests use their
 * own FFmpeg-generated media. Never invoke this to repair a missing negative. */
export function writeStubMediaFixture(root:string,id:string,mimeType='video/mp4'):{relativePath:string;sha256:string;sizeBytes:number}{
 const extensions:Readonly<Record<string,string>>={'video/mp4':'mp4','video/webm':'webm','image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'};
 let bytes:Buffer;
 if(mimeType==='image/png')bytes=png();
 else if(mimeType==='video/mp4'||mimeType==='audio/mp4')bytes=mp4HeaderFixture(`Stub container ${id}`);
 else if(mimeType==='audio/wav'){bytes=Buffer.alloc(44);bytes.write('RIFF');bytes.writeUInt32LE(36,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);}
 else if(mimeType==='image/jpeg')bytes=Buffer.from([255,216,255,224,0,2,255,217]);
 else if(mimeType==='image/webp'){bytes=Buffer.alloc(12);bytes.write('RIFF');bytes.writeUInt32LE(4,4);bytes.write('WEBP',8);}
 else if(mimeType==='video/webm')bytes=Buffer.from([26,69,223,163,0,0,0,0]);
 else if(mimeType==='audio/mpeg')bytes=Buffer.from('ID3\0\0\0\0\0\0\0','binary');
 else bytes=Buffer.from(`Unsupported MIME fixture ${id}`);
 const relativePath=`media/${id}.${extensions[mimeType]??'bin'}`;writeFileSync(path.join(root,relativePath),bytes);
 return {relativePath,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length};
}
