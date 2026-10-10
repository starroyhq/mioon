import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {validatePng, renderMockImagePng} from '../packages/business/src/images/png.mjs';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
function crc(data) { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let n=0;n<8;n++) c = c&1 ? 0xedb88320^(c>>>1) : c>>>1; } return (c^0xffffffff)>>>0; }
function chunk(type, data=Buffer.alloc(0)) { const b=Buffer.alloc(data.length+12); b.writeUInt32BE(data.length); b.write(type,4); data.copy(b,8); b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4); return b; }
function header({width=2,height=2,color=2,depth=8,interlace=0}={}) { const b=Buffer.alloc(13); b.writeUInt32BE(width); b.writeUInt32BE(height,4); b[8]=depth;b[9]=color;b[12]=interlace;return chunk('IHDR',b); }
function png({raw=Buffer.alloc(14),compressed=deflateSync(raw),before=[],after=[],...options}={}) {return Buffer.concat([signature,header(options),...before,chunk('IDAT',compressed),...after,chunk('IEND')]);}
const small = {width:2,height:2};
const rejects = (bytes,code='IMAGE_PNG_INVALID',options=small) => assert.rejects(validatePng(bytes,options),{code});

test('valid RGB, split IDAT, RGBA and all five row filters decode with exact metadata',async()=>{
  const b=png(); const m=await validatePng(b,small);
  assert.deepEqual(m,{mimeType:'image/png',width:2,height:2,byteLength:b.length,sha256:createHash('sha256').update(b).digest('hex')});
  const zip=deflateSync(Buffer.alloc(14));
  await validatePng(Buffer.concat([signature,header(),chunk('IDAT',zip.subarray(0,3)),chunk('IDAT',zip.subarray(3)),chunk('IEND')]),small);
  for(let filter=0;filter<5;filter++) {
    const raw=Buffer.from([filter,1,2,3,4,5,6,filter,7,8,9,10,11,12]); await validatePng(png({raw}),small);
  }
  await validatePng(png({color:6,raw:Buffer.from([0,1,2,3,255,4,5,6,255,0,7,8,9,255,10,11,12,255])}),small);
});

test('signature, every CRC, short chunk framing, oversized lengths and dimensions fail closed',async()=>{
  const good=png(); const corrupt=Buffer.from(good);corrupt[corrupt.length-1]^=1;await rejects(corrupt);
  const signatureBad=Buffer.from(good);signatureBad[0]=0;await rejects(signatureBad);
  const crcBad=Buffer.from(good);crcBad[45]^=1;await rejects(crcBad);
  const badLength=Buffer.from(good);badLength.writeUInt32BE(0xffffffff,33);await rejects(badLength);
  for(const length of [0,8,20,good.length-1,good.length-8]) await rejects(good.subarray(0,length));
  for(const options of [{width:NaN,height:2},{width:Infinity,height:2},{width:0,height:2},{width:2.5,height:2},{width:2048,height:2},{width:3,height:2}]) await rejects(good,'IMAGE_PNG_INVALID',options);
});

test('IHDR/PLTE/IDAT/IEND order, duplicates and trailing/polyglot bytes are rejected',async()=>{
  const good=png(),zip=deflateSync(Buffer.alloc(14)),palette=chunk('PLTE',Buffer.from([0,0,0]));
  const variants=[
    Buffer.concat([signature,chunk('IDAT',zip),header(),chunk('IEND')]),
    Buffer.concat([signature,header(),header(),chunk('IDAT',zip),chunk('IEND')]),
    png({before:[palette,palette]}),png({after:[palette]}),
    Buffer.concat([signature,header(),chunk('IDAT',zip.subarray(0,3)),chunk('tEXt',Buffer.from('key\0text')),chunk('IDAT',zip.subarray(3)),chunk('IEND')]),
    Buffer.concat([signature,header(),chunk('IEND')]),
    Buffer.concat([good,Buffer.from('PK\x03\x04')]),Buffer.concat([good,chunk('IEND')]),
  ];
  for(const value of variants) await rejects(value);
});

test('unsupported critical, animation, palette/grayscale/16-bit/interlaced and compressed metadata rejected',async()=>{
  for(const type of ['acTL','fcTL','fdAT','ABCD','zTXt','iCCP','tRNS']) await rejects(png({before:[chunk(type,Buffer.from([0]))]}),'IMAGE_PNG_UNSUPPORTED');
  for(const options of [{color:0},{color:3},{color:4},{depth:16},{interlace:1}]) await rejects(png(options),'IMAGE_PNG_UNSUPPORTED');
  await rejects(png({before:[chunk('abca',Buffer.alloc(0))]}));
});

test('deflate truncation, tail, concatenated streams, checksum, wrong output and bombs rejected',async()=>{
  const zip=deflateSync(Buffer.alloc(14));
  for(const compressed of [zip.subarray(0,-1),Buffer.concat([zip,Buffer.from([0])]),Buffer.concat([zip,zip]),Buffer.from('not-zlib'),deflateSync(Buffer.alloc(13))]) await rejects(png({compressed}));
  const bad=Buffer.from(zip);bad[bad.length-1]^=1;await rejects(png({compressed:bad}));
  await rejects(png({compressed:deflateSync(Buffer.alloc(1024*1024))}),'IMAGE_PNG_TOO_LARGE');
  await rejects(png({raw:Buffer.from([5,...Array(13).fill(0)])}));
});

test('RGBA alpha is reconstructed through filters before checking opaque profile',async()=>{
  await rejects(png({color:6,raw:Buffer.from([0,0,0,0,254,0,0,0,255,0,0,0,0,255,0,0,0,255])}),'IMAGE_PNG_UNSUPPORTED');
  // Sub: second alpha is residual zero and reconstructs to 255.
  const sub=Buffer.from([1,1,2,3,255,0,0,0,0,2,0,0,0,0,0,0,0,0]);
  await validatePng(png({color:6,raw:sub}),small);
  const transparent=png({color:6,raw:Buffer.alloc(18)});await validatePng(transparent,{...small,opaque:false});
});

test('known metadata is checked for lengths, order, duplication, text validity and metadata bound',async()=>{
  const goodText=chunk('tEXt',Buffer.from('Comment\0Synthetic fixture'));
  await validatePng(png({before:[chunk('sRGB',Buffer.from([0])),goodText],after:[chunk('caBX',Buffer.from('bounded provenance'))]}),small);
  for(const before of [[chunk('sRGB',Buffer.from([4]))],[chunk('gAMA',Buffer.alloc(4))],[chunk('sRGB',Buffer.from([0])),chunk('sRGB',Buffer.from([0]))],[chunk('tEXt',Buffer.from(' bad\0text'))],[chunk('tEXt',Buffer.from('key\0text\0tail'))]]) await rejects(png({before}));
  await rejects(png({after:[chunk('sRGB',Buffer.from([0]))]}));
  await rejects(png({before:[chunk('caBX',Buffer.alloc(1024*1024+1))]}),'IMAGE_PNG_TOO_LARGE');
});

test('Mock renderer emits deterministic actual 1024-square PNG and cancellation is local',async()=>{
  const first=await renderMockImagePng(), second=await renderMockImagePng();assert.deepEqual(first,second);
  const metadata=await validatePng(first);assert.equal(metadata.width,1024);assert.equal(metadata.height,1024);assert.ok(first.length<200000);
  const pre=new AbortController();pre.abort();await assert.rejects(renderMockImagePng({signal:pre.signal}),{code:'IMAGE_CANCELLED'});
  const mid=new AbortController();const rendering=renderMockImagePng({signal:mid.signal});setImmediate(()=>mid.abort());await assert.rejects(rendering,{code:'IMAGE_CANCELLED'});
  await assert.rejects(validatePng(first,{signal:pre.signal}),{code:'IMAGE_CANCELLED'});
});
