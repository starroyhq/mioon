


import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, createWriteStream, readFileSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {collectProject, packageDocumentBytes, buildManifest} from '../packages/business/src/project-package/document.ts';
import {writeProjectPackage,readProjectPackage} from '../packages/business/src/project-package/container.ts';
import {buildSampleProject, openWorkspace, tempRoot, cleanup, mediaToolsAvailable} from './helpers/project-package-fixture.ts';

const options={media:'all' as const,includeExports:false};
async function exportTo(store:any,projectId:string,file:string){
 const collected=collectProject(store,projectId,options),document=packageDocumentBytes(collected.document);
 const manifest=buildManifest({collected,document,appVersion:'test',options,name:collected.document.project.name});
 await pipeline(Readable.from(writeProjectPackage({manifest,document,media:collected.media.map(entry=>entry.source)})),createWriteStream(file));
 return collected;
}
const projectRows=(store:any,projectId:string)=>Object.fromEntries(['assets','shots','nodes','edges','jobs','versions','timelines'].map(table=>[table,store.list(table,projectId).length]));










import {PROJECT_PACKAGE_MAGIC} from '../packages/business/src/project-package/container.ts';



async function rejects(bytes:Buffer,code:string){
 const staging=mkdtempSync(path.join(tmpdir(),'mioon-package-bad-'));
 try{await assert.rejects(readProjectPackage({source:Readable.from([bytes]),destination:staging}),{code});}
 finally{cleanup(staging);}
}
test('damaged, foreign and newer files are rejected with distinct codes',{skip:!mediaToolsAvailable&&'ffmpeg unavailable'},async t=>{
 const root=tempRoot('package-bad'),work=mkdtempSync(path.join(tmpdir(),'mioon-package-work-'));t.after(()=>cleanup(root,work));
 const ws=openWorkspace(root);t.after(()=>ws.store.close());
 const sample=await buildSampleProject(root,ws),file=path.join(work,'p.mioon');
 await exportTo(ws.store,sample.project.id,file);
 const good=readFileSync(file);
 await rejects(Buffer.from('PK\x03\x04 not a project'),'PROJECT_PACKAGE_NOT_MIOON');
 await rejects(good.subarray(0,good.length-200),'PROJECT_PACKAGE_CORRUPT');
 const flipped=Buffer.from(good);flipped[flipped.length-400]^=0xff;await rejects(flipped,'PROJECT_PACKAGE_CORRUPT');
 const size=good.readUInt32BE(PROJECT_PACKAGE_MAGIC.length),headerEnd=PROJECT_PACKAGE_MAGIC.length+4+size;
 const manifestSize=JSON.parse(good.subarray(PROJECT_PACKAGE_MAGIC.length+4,headerEnd).toString()).bytes;
 const manifest=JSON.parse(good.subarray(headerEnd,headerEnd+manifestSize).toString());
 const newer=Buffer.from(JSON.stringify({...manifest,formatVersion:2}));
 const head=Buffer.alloc(4),body=Buffer.from(JSON.stringify({path:'manifest.json',bytes:newer.length}));head.writeUInt32BE(body.length);
 await rejects(Buffer.concat([PROJECT_PACKAGE_MAGIC,head,body,newer]),'PROJECT_PACKAGE_NEWER_FORMAT');
});




