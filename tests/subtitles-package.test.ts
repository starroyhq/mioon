import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import resources from '../apps/desktop/subtitle-resources.ts';
import {createSubtitleTarVerifier,verifySubtitleResourceTarball} from '../apps/desktop/subtitle-package.ts';
const base='mioon-0.4.1-linux-x64',prefix=base+'/resources/subtitles',expected=resources.SUBTITLE_RESOURCE_MANIFEST;
const source=new URL('../packages/business/resources/subtitles/',import.meta.url);
const bytes=Object.fromEntries(await Promise.all(Object.keys(expected).map(async name=>[name,await readFile(new URL(name,source))]))) as Record<string, Buffer>;
function header(name: string,{size=0,type='0',link='',format='ustar'}: {size?: number; type?: string; link?: string; format?: 'ustar'|'gnu'}={}): Buffer {
 const b=Buffer.alloc(512);b.write(name,0,100);b.write(type==='5'?'0000755\0':'0000644\0',100);b.write('0000000\0',108);b.write('0000000\0',116);b.write(size.toString(8).padStart(11,'0')+'\0',124);b.write('00000000000\0',136);b.fill(32,148,156);b.write(type,156);b.write(link,157,100);
 // GNU format writes a spaced magic/version; byte 262 is then non-NUL, so the
 // verifier must not read the POSIX prefix field for these headers.
 if(format==='gnu'){b.write('ustar ',257);b.write(' \0',263);}else{b.write('ustar\0',257);b.write('00',263);}
 const sum=b.reduce((n,v)=>n+v,0);b.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return b;
}
interface TarEntry {name: string; data?: Buffer; size?: number; type?: string; link?: string}
const regular=(): TarEntry[]=>Object.keys(expected).map(name=>({name:prefix+'/'+name,data:bytes[name] as Buffer}));
function archive(entries: TarEntry[]=regular(),format: 'ustar'|'gnu'='ustar'): Buffer {
 const parts=[header(base,{type:'5',format}),header(base+'/resources',{type:'5',format}),header(prefix,{type:'5',format})];
 for(const entry of entries){const data=entry.data??Buffer.alloc(0);parts.push(header(entry.name,{size:entry.size??data.length,type:entry.type??'0',link:entry.link??'',format}),data,Buffer.alloc((512-data.length%512)%512));}
 return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
// A real POSIX PAX writer records sub-second mtime in an extended header before
// each member; the verifier must ignore that unrelated record and keep the
// header name. This builds that byte stream in process instead of shelling out
// to a platform tar binary.
function paxMtime(): Buffer {return paxEntry(`mtime=${Math.floor(Date.now()/1000)}.123456789`);}
function paxArchive(): Buffer {
 const parts=[header(base,{type:'5'}),header(base+'/resources',{type:'5'}),header(prefix,{type:'5'})];
 for(const entry of regular()){
  const data=entry.data??Buffer.alloc(0),metadata=paxMtime();
  parts.push(header('PaxHeaders/mtime',{size:metadata.length,type:'x'}),metadata,Buffer.alloc((512-metadata.length%512)%512));
  parts.push(header(entry.name,{size:data.length}),data,Buffer.alloc((512-data.length%512)%512));
 }
 return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
function inspect(input: Buffer){const checker=createSubtitleTarVerifier(base);for(let at=0;at<input.length;at+=8191)checker.consume(input.subarray(at,at+8191));return checker.finish();}
function paxEntry(value: string){let length=Buffer.byteLength(value)+3;while(Buffer.byteLength(`${length} ${value}\n`)!==length)length=Buffer.byteLength(`${length} ${value}\n`);return Buffer.from(`${length} ${value}\n`);}

test('delivered resource parser verifies exact five members in bounded arbitrary chunks',()=>{
 assert.deepEqual(inspect(archive()),expected);
 const script=bytes['extract-font.py'];assert.ok(script.length<32768);assert.ok(bytes['mioon-subtitle-cjk-sc-v1.otf'].length>10*1024*1024);
 for(const name of ['../escape','/absolute','bad/name',''])assert.throws(()=>createSubtitleTarVerifier(name));
});

test('delivered resource parser rejects missing, duplicate, unknown, link, changed and wrong-sized members',()=>{
 const valid=regular();
 const cases=[valid.slice(1),[...valid,valid[0]],[...valid,{name:prefix+'/unexpected.ttf',data:Buffer.from('font')}],
  valid.map((entry,i)=>i?entry:{...entry,type:'2',link:'/private/font',data:Buffer.alloc(0)}),
  valid.map((entry,i)=>i?entry:{...entry,type:'1',link:valid[1].name,data:Buffer.alloc(0)}),
  valid.map((entry,i)=>i?entry:{...entry,size:(entry.data ?? Buffer.alloc(0)).length+1}),
  valid.map((entry,i)=>i?entry:{...entry,data:Buffer.alloc((entry.data ?? Buffer.alloc(0)).length)}),
  [...valid,{name:base+'/resources/subtitles/../escaped',data:Buffer.alloc(0)}],
  [...valid,{name:prefix,type:'2',link:'/private',data:Buffer.alloc(0)}]];
 for(const entries of cases)assert.throws(()=>inspect(archive(entries)),/bounded archive verification/);
 const corrupt=archive();corrupt[148]=0;assert.throws(()=>inspect(corrupt));assert.throws(()=>inspect(archive().subarray(0,-1000)));
 const trailing=Buffer.concat([archive(),header('after-end')]);assert.throws(()=>inspect(trailing));
});

test('bounded GNU/PAX names resolve to exact members and cannot hide duplicates or wrong sizes',()=>{
 const valid=regular(),target=valid[0];
 for(const type of ['L','x']){
  const metadata=type==='L'?Buffer.from(target.name+'\0'):paxEntry('path='+target.name);
  const entries=[{name:type==='L'?'././@LongLink':'PaxHeaders/font',type,data:metadata},{...target,name:'placeholder'},...valid.slice(1)];
  assert.deepEqual(inspect(archive(entries)),expected);
  assert.throws(()=>inspect(archive([...entries,...entries.slice(0,2)])));
 }
 assert.throws(()=>inspect(archive([{name:'PaxHeader',type:'x',data:paxEntry('size=1')},...valid])));
 assert.throws(()=>inspect(archive([{name:'PaxHeader',type:'g',data:paxEntry('path='+target.name)},...valid])));
 assert.throws(()=>inspect(archive([{name:'PaxHeader',type:'x',data:paxEntry('GNU.sparse.map=0,100')},...valid])));
 const repeated=Array.from({length:200},(_,i)=>({name:'PaxHeader',type:'x',data:paxEntry(`VENDOR.unused${i}=${'x'.repeat(4096)}`)}));assert.deepEqual(inspect(archive([...repeated,...valid])),expected);
 const oversized=Buffer.concat([header('PaxHeader',{type:'x',size:65537}),Buffer.alloc(1024)]);assert.throws(()=>inspect(oversized));
});

test('gzip verifier streams >10MiB font, detects corruption/missing files, and reads GNU tar output',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subtitle-package-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'valid.tar.gz');
 await writeFile(file,gzipSync(archive()));assert.deepEqual(await verifySubtitleResourceTarball(file,base),expected);
 const wrong=path.join(root,'wrong.tar.gz');await writeFile(wrong,gzipSync(archive(regular().slice(1))));await assert.rejects(verifySubtitleResourceTarball(wrong,base));
 const link=path.join(root,'alias.tar.gz');await symlink(file,link);await assert.rejects(verifySubtitleResourceTarball(link,base));
 await writeFile(wrong,Buffer.from('not gzip'));await assert.rejects(verifySubtitleResourceTarball(wrong,base));
 // GNU and PAX format byte streams are generated in process, so the verifier's
 // format handling is exercised identically on every platform without relying
 // on a system tar that may lack --format=gnu (macOS) or GNU field layout.
 const gnu=path.join(root,'gnu.tar.gz');await writeFile(gnu,gzipSync(archive(regular(),'gnu')));assert.deepEqual(await verifySubtitleResourceTarball(gnu,base),expected);
 const pax=path.join(root,'pax.tar.gz');await writeFile(pax,gzipSync(paxArchive()));assert.deepEqual(await verifySubtitleResourceTarball(pax,base),expected);
});

test('real system GNU tar packaging is accepted when the platform provides GNU tar',{timeout:120000},async t=>{
 // The in-process GNU/PAX fixtures above cannot capture quirks of the real
 // tool. When the host ships GNU tar (Linux CI, Homebrew gnu-tar) also pack
 // the same directory with it; macOS's bsdtar lacks --format=gnu, so that
 // platform skips this extra case with the reason in the TAP output.
 const exec=promisify(execFile);
 const version=await exec('tar',['--version'],{timeout:10000}).then(({stdout})=>stdout).catch(()=>'');
 if(!/GNU tar/u.test(version)){t.diagnostic('System tar is not GNU tar; skipping the real GNU tar packaging case.');t.skip('GNU tar is not available on this platform');return;}
 const root=await mkdtemp(path.join(tmpdir(),'mioon-subtitle-gnu-tar-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const plain=path.join(root,'plain.tar');await writeFile(plain,archive());
 await exec('tar',['-xf',plain,'-C',root],{timeout:30000,maxBuffer:64*1024});
 const gnu=path.join(root,'gnu.tar.gz');await exec('tar',['--format=gnu','-czf',gnu,'-C',root,base],{timeout:30000,maxBuffer:64*1024});
 assert.deepEqual(await verifySubtitleResourceTarball(gnu,base),expected);
});

test('package inspector streams exact native ASAR and binary bytes and validates external delivered resources',async()=>{
 const source=await readFile(new URL('../apps/desktop/scripts/inspect-package.ts',import.meta.url),'utf8');
 assert.match(source,/await verifyArchiveMember\(tarball, `\$\{artifactBase\}\/resources\/app\.asar`, archive\)/);assert.match(source,/await verifyArchiveMember\(tarball, `\$\{artifactBase\}\/\$\{path\.basename\(binary\)\}`, binary\)/);
 assert.match(source,/new Set\(\['main\.cjs', 'backend\.cjs', \.\.\.\(!historicalV3 \? \['project-catalog\.cjs', 'preload\.cjs'\] : \[\]\), 'package\.json', 'web', 'licenses'\]\)/);
 assert.match(source,/historicalV3\?null:await verifySubtitleResourceTarball\(tarball,artifactBase\)/);assert.match(source,/archivedSubtitleResourcesMatchNativePackage:true/);
});

test('actual ASAR root allowlist adds current catalog utility, preload and icons while preserving historical v3 exclusions',async()=>{
 const source=await readFile(new URL('../apps/desktop/scripts/inspect-package.ts',import.meta.url),'utf8');
 const match=source.match(/^(const allowed = new Set\([^\n]+\);\nif \(!historicalV3\) allowed\.add\('icons'\);)$/m);assert.ok(match,'bounded current and historical root allowlist');
 const inspect=Function('historicalV3',`${match[1]} return allowed;`);
 const legacy=['main.cjs','backend.cjs','package.json','web','licenses'];
 assert.deepEqual([...inspect(true)],legacy);
 assert.deepEqual([...inspect(false)],['main.cjs','backend.cjs','project-catalog.cjs','preload.cjs','package.json','web','licenses','icons']);
 assert.equal(inspect(true).has('project-catalog.cjs'),false);
 assert.equal(inspect(true).has('preload.cjs'),false);
 assert.equal(inspect(true).has('icons'),false);
 for(const historical of [true,false])for(const extra of ['preload.js','preload-other.cjs','node_modules','data','subtitles','access-token','mcp-connection.json'])assert.equal(inspect(historical).has(extra),false,`${extra} must remain excluded`);
 assert.match(source,/assert\.ok\(allowed\.has\(file\.split\('\/'\)\[1\]\), `Unexpected ASAR entry: \$\{file\}`\)/);
});
