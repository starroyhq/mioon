import {constants} from 'node:fs';
import {Readable} from 'node:stream';
import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import subtitleResources from './subtitle-resources.cjs';
const {SUBTITLE_RESOURCE_MANIFEST:EXPECTED}=subtitleResources;
const CHUNK=64*1024,MAX_METADATA=64*1024,MAX_ARCHIVE=512*1024*1024;
const fail=()=>{throw Error('Delivered subtitle resources failed bounded archive verification.');};
const utf8=new TextDecoder('utf-8',{fatal:true});
const field=(bytes,start,length)=>utf8.decode(bytes.subarray(start,start+length)).split('\0')[0];
const octal=(bytes,start,length)=>{const text=field(bytes,start,length).trim();if(!/^[0-7]+$/.test(text))fail();const n=parseInt(text,8);if(!Number.isSafeInteger(n)||n<0)fail();return n;};
function canonical(name){
 if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||/[\r\n\0]/.test(name))fail();
 const parts=name.split('/').filter(part=>part&&part!=='.');if(!parts.length)fail();return parts.join('/');
}
function pax(bytes){
 const result={};let at=0;
 while(at<bytes.length){const space=bytes.indexOf(32,at);if(space<0||space-at>8)fail();const number=bytes.toString('ascii',at,space);if(!/^[1-9][0-9]*$/.test(number))fail();const end=at+Number(number);if(end>bytes.length||end<=space+2||bytes[end-1]!==10)fail();const entry=utf8.decode(bytes.subarray(space+1,end-1)),equals=entry.indexOf('=');if(equals<1)fail();const key=entry.slice(0,equals);if(Object.hasOwn(result,key))fail();result[key]=entry.slice(equals+1);at=end;}
 return result;
}

// 512-byte tar headers and 64-KiB stream chunks only. No member is extracted to
// disk or buffered whole. GNU long-name/PAX records have their own 64-KiB cap.
// This verifier grants no larger allowance to ASAR or arbitrary output buffers.
export function createSubtitleTarVerifier(artifactBase){
 if(typeof artifactBase!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(artifactBase))fail();
 const prefix=`${artifactBase}/resources/subtitles`,ancestors=new Set([artifactBase,`${artifactBase}/resources`,prefix]);
 const result={},directories=new Set(),header=Buffer.alloc(512);let headerBytes=0,current=null,pending={},zeroBlocks=0,total=0,headers=0;
 const setPending=values=>{const next={...pending};for(const key of ['path','linkpath','size'])if(Object.hasOwn(values,key))next[key]=values[key];if(Object.values(next).reduce((n,value)=>n+Buffer.byteLength(value),0)>MAX_METADATA)fail();pending=next;};
 const finishEntry=()=>{
  const entry=current;
  if(entry.metadata){const bytes=Buffer.concat(entry.metadata,entry.size);
   if(entry.type==='L'||entry.type==='K'){const value=utf8.decode(bytes).replace(/\0+$/,'');setPending(entry.type==='L'?{path:value}:{linkpath:value});}
   else {const values=pax(bytes);if(Object.keys(values).some(key=>key.startsWith('GNU.sparse.')||['SCHILY.realsize','SCHILY.filetype'].includes(key)))fail();if(entry.type==='g'){if(['path','linkpath','size'].some(key=>Object.hasOwn(values,key)))fail();}else setPending(values);}
  }else if(entry.hash){if(entry.hash.digest('hex')!==EXPECTED[entry.basename].sha256)fail();result[entry.basename]={...EXPECTED[entry.basename]};}
 };
 const beginEntry=()=>{
  if(header.every(value=>value===0)){zeroBlocks++;return;}
  if(zeroBlocks||++headers>10000)fail();
  const checksum=octal(header,148,8);let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(checksum!==sum)fail();
  const rawName=field(header,0,100),prefixName=header[262]===0?field(header,345,155):'',type=String.fromCharCode(header[156]||48);
  let size=octal(header,124,12),name=prefixName?`${prefixName}/${rawName}`:rawName,link=field(header,157,100);
  const metadata=['L','K','x','g'].includes(type);
  if(metadata){if(size>MAX_METADATA)fail();}
  else{
   if(Object.hasOwn(pending,'path'))name=pending.path;if(Object.hasOwn(pending,'linkpath'))link=pending.linkpath;
   if(Object.hasOwn(pending,'size')){if(!/^(0|[1-9][0-9]*)$/.test(pending.size))fail();size=Number(pending.size);if(!Number.isSafeInteger(size))fail();}
   pending={};name=canonical(name);
  }
  if(size>MAX_ARCHIVE)fail();
  const entry={type,name,size,remaining:size,padding:(512-size%512)%512,metadata:metadata?[]:null};
  if(!metadata&&ancestors.has(name)){if(type!=='5'||size!==0||link||directories.has(name))fail();directories.add(name);}
  if(!metadata&&name.startsWith(prefix+'/')){
   const basename=name.slice(prefix.length+1),expected=EXPECTED[basename];
   if(!Object.hasOwn(EXPECTED,basename)||!expected||type!=='0'||link||size!==expected.bytes||Object.hasOwn(result,basename))fail();
   entry.basename=basename;entry.hash=createHash('sha256');
  }
  current=entry;if(!size)finishEntry();
 };
 return {consume(chunk){
  if(!Buffer.isBuffer(chunk)||chunk.length>CHUNK||chunk.length>MAX_ARCHIVE-total)fail();total+=chunk.length;let at=0;
  while(at<chunk.length){
   if(current){
    if(current.remaining){const length=Math.min(current.remaining,chunk.length-at),part=chunk.subarray(at,at+length);current.hash?.update(part);if(current.metadata)current.metadata.push(Buffer.from(part));current.remaining-=length;at+=length;if(!current.remaining)finishEntry();continue;}
    if(current.padding){const length=Math.min(current.padding,chunk.length-at);if(chunk.subarray(at,at+length).some(value=>value!==0))fail();current.padding-=length;at+=length;continue;}
    current=null;continue;
   }
   const length=Math.min(512-headerBytes,chunk.length-at);chunk.copy(header,headerBytes,at,at+length);headerBytes+=length;at+=length;
   if(headerBytes===512){headerBytes=0;beginEntry();}
  }
 },finish(){
  if(headerBytes||(current&&(current.remaining||current.padding))||zeroBlocks<2||Object.keys(pending).length||Object.keys(result).length!==Object.keys(EXPECTED).length)fail();
  return Object.fromEntries(Object.keys(EXPECTED).map(name=>[name,result[name]]));
 }};
}

export async function verifySubtitleResourceTarball(file,artifactBase){
 const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>MAX_ARCHIVE)fail();
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));let source,gunzip,producer,timer;
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 try{
  const opened=await handle.stat();if(!same(before,opened))fail();
  const verifier=createSubtitleTarVerifier(artifactBase);
  async function* compressed(){let offset=0;const buffer=Buffer.alloc(CHUNK);while(offset<opened.size){const part=await handle.read(buffer,0,Math.min(CHUNK,opened.size-offset),offset);if(!part.bytesRead)fail();offset+=part.bytesRead;yield Buffer.from(buffer.subarray(0,part.bytesRead));}}
  source=Readable.from(compressed(),{objectMode:false,highWaterMark:CHUNK});gunzip=createGunzip({chunkSize:CHUNK});
  producer=pipeline(source,gunzip);producer.catch(()=>{});
  timer=setTimeout(()=>{source.destroy(Error('Subtitle archive inspection timed out.'));gunzip.destroy(Error('Subtitle archive inspection timed out.'));},120000);
  for await(const chunk of gunzip)for(let at=0;at<chunk.length;at+=CHUNK)verifier.consume(chunk.subarray(at,at+CHUNK));
  await producer;if(!same(opened,await handle.stat())||!same(opened,await lstat(file)))fail();return verifier.finish();
 }finally{clearTimeout(timer);source?.destroy();gunzip?.destroy();await producer?.catch(()=>{});await handle.close();}
}
