import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm,cp,readFile,writeFile,unlink,symlink,truncate,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TIMELINE_SUBTITLE_FONT_SHA256,TIMELINE_SUBTITLE_PROFILE_ID,isTimelineSubtitleCodePoint} from '@mioon/contracts';
import {initializeSubtitleResources,verifySubtitleFontResource,validateSubtitleSnapshotProfile,SUBTITLE_FONT_BYTES,SUBTITLE_FONT_FILE} from '../packages/business/src/subtitle-resources.ts';
import {prepareTimelineSubtitles} from '../packages/business/src/subtitle-media.ts';
const require=createRequire(import.meta.url);
const {verifySubtitleResources,SUBTITLE_RESOURCE_FILES,FONT_SHA256,packagedSubtitleDirectory}=require('../apps/desktop/subtitle-resources.ts');
const bundle=fileURLToPath(new URL('../packages/business/resources/subtitles/',import.meta.url));
const profile={profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256};

test('bundled SC resource pins bytes, every permitted cmap glyph, complete OFL and reproducible provenance',async()=>{
 const manifest=await verifySubtitleResources(bundle),bytes=await readFile(path.join(bundle,SUBTITLE_FONT_FILE));
 assert.equal(bytes.toString('ascii',0,4),'OTTO');assert.equal(bytes.length,SUBTITLE_FONT_BYTES);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),TIMELINE_SUBTITLE_FONT_SHA256);assert.equal(FONT_SHA256,TIMELINE_SUBTITLE_FONT_SHA256);
 assert.deepEqual(Object.keys(manifest),SUBTITLE_RESOURCE_FILES);
 const tableCount=bytes.readUInt16BE(4);let cmap;
 for(let i=0;i<tableCount;i++){const at=12+16*i;if(bytes.toString('ascii',at,at+4)==='cmap')cmap=bytes.readUInt32BE(at+8);}
 assert.ok(cmap);let groups;
 for(let i=0;i<bytes.readUInt16BE(cmap+2);i++){const record=cmap+4+i*8,offset=cmap+bytes.readUInt32BE(record+4);if(bytes.readUInt16BE(offset)===12){groups=[];for(let g=0;g<bytes.readUInt32BE(offset+12);g++){const at=offset+16+g*12;groups.push([bytes.readUInt32BE(at),bytes.readUInt32BE(at+4),bytes.readUInt32BE(at+8)]);}break;}}
 assert.ok(groups);
 for(let code=0;code<=0xffff;code++)if(isTimelineSubtitleCodePoint(code)){const group=groups.find(([first,last])=>code>=first&&code<=last);assert.ok(group&&group[2]+code-group[0]>0,`missing U+${code.toString(16)}`);}
 const license=await readFile(path.join(bundle,'OFL-1.1.txt'),'utf8'),notice=await readFile(path.join(bundle,'README.md'),'utf8');
 for(const text of ['2014-2021 Adobe','2010-2012, Google','SIL OPEN FONT LICENSE Version 1.1','PERMISSION & CONDITIONS','TERMINATION','OTHER DEALINGS IN THE FONT SOFTWARE.'])assert.ok(license.includes(text));
 for(const text of ['Modified Version','4.57.0','recalcTimestamp=False','reorderTables=False','index 2','2.004','Noto is a trademark'])assert.ok(notice.includes(text));
 assert.equal(createHash('sha256').update(await readFile(path.join(bundle,'SOURCE-COPYRIGHT.txt'))).digest('hex'),'849f4ea9c214fa4ac3593b770c699f387534b11ce671264c1b10d85bdcb5997b');
});

test('font reader rejects absent, symlink, nonregular, oversized and same-size changed resources; old empty snapshots need no font',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-font-')),resources=path.join(root,'subtitles');await cp(bundle,resources,{recursive:true});
 t.after(()=>rm(root,{recursive:true,force:true}));initializeSubtitleResources(resources);
 assert.equal((await verifySubtitleFontResource()).fontSha256,profile.fontSha256);
 const staged=path.join(root,'font.otf');await verifySubtitleFontResource({destination:staged});assert.equal(createHash('sha256').update(await readFile(staged)).digest('hex'),profile.fontSha256);
 const file=path.join(resources,SUBTITLE_FONT_FILE);await unlink(file);
 await assert.rejects(verifySubtitleFontResource(),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});
 assert.equal(await prepareTimelineSubtitles({timeline:{}},root),null);
 assert.equal(await prepareTimelineSubtitles({timeline:{subtitles:{profileId:profile.profileId,cues:[]}}},root),null);
 await symlink(staged,file);await assert.rejects(verifySubtitleFontResource(),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});await unlink(file);
 await writeFile(file,'bad');await assert.rejects(verifySubtitleFontResource(),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});
 await truncate(file,SUBTITLE_FONT_BYTES+1);await assert.rejects(verifySubtitleFontResource(),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});
 await cp(staged,file);const handle=await open(file,'r+');await handle.write(Buffer.from([0]),0,1,0);await handle.close();
 await assert.rejects(verifySubtitleFontResource(),{code:'SUBTITLE_RESOURCE_UNAVAILABLE'});await assert.rejects(verifySubtitleResources(resources),/hash mismatch/);
 await cp(staged,file);await writeFile(path.join(resources,'unexpected-font.ttf'),'bad');await assert.rejects(verifySubtitleResources(resources),/Unexpected/);
});

test('frozen profile permits no optional metadata on old snapshots and never exposes paths',()=>{
 assert.equal(validateSubtitleSnapshotProfile({timeline:{}}),false);
 assert.equal(validateSubtitleSnapshotProfile({timeline:{subtitles:{cues:[{}]}},subtitleProfile:profile}),true);
 for(const value of [undefined,{}, {...profile,fontSha256:'0'.repeat(64)},{...profile,fontPath:'/private/font'}])assert.throws(()=>validateSubtitleSnapshotProfile({timeline:{subtitles:{cues:[{}]}},subtitleProfile:value}),{code:'INVALID_TIMELINE_SNAPSHOT'});
 assert.throws(()=>validateSubtitleSnapshotProfile({timeline:{},subtitleProfile:profile}),{code:'INVALID_TIMELINE_SNAPSHOT'});
});

test('both desktop channels whitelist only external subtitle resources and retain ASAR boundaries',()=>{
 for(const channel of ['production','development']){
  const config=require('../apps/desktop/builder-config.ts').builderConfig(channel);
  assert.equal(config.asar,true);assert.deepEqual(config.extraResources,[{from:'build/subtitles',to:'subtitles',filter:[...SUBTITLE_RESOURCE_FILES]}]);
  assert.equal(config.files.some(file=>file.includes('subtitles')),false);assert.equal(config.files.includes('licenses/**/*'),true);
 }
 assert.equal(packagedSubtitleDirectory({appOutDir:'/tmp/app',electronPlatformName:'linux'}),'/tmp/app/resources/subtitles');
 assert.equal(packagedSubtitleDirectory({appOutDir:'/tmp/app',electronPlatformName:'darwin',packager:{appInfo:{productFilename:'Mioon'}}}),'/tmp/app/Mioon.app/Contents/Resources/subtitles');
});
