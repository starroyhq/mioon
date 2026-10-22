import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createProjectFileOpener,projectFileArguments,ProjectFileOpenError} from '../apps/desktop/src/project-file-open.ts';

const settle=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};

test('project files on a command line are picked out and resolved against the caller directory',()=>{
 assert.deepEqual(projectFileArguments(undefined),[]);
 assert.deepEqual(projectFileArguments(['/Applications/Mioon','--inspect','.','notes.txt','Clip.MIOON','/abs/a.mioon'],'/Users/me/Desktop'),['/Users/me/Desktop/Clip.MIOON','/abs/a.mioon']);
 assert.deepEqual(projectFileArguments(['exe','b.mioon']),[path.resolve('b.mioon')]);
});

test('files opened before the backend runs wait, upload in order once, and failures are reported per file',async()=>{
 const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:(file,code)=>events.push(`failed ${file} ${code}`)});
 opener.add(['/a.mioon','/b.mioon','/a.mioon']);
 assert.deepEqual(opener.pending,['/a.mioon','/b.mioon']);
 const upload=async(file:string)=>{events.push(`upload ${file}`);if(file==='/b.mioon')throw new ProjectFileOpenError('PROJECT_PACKAGE_CORRUPT');};
 opener.attach(upload);await settle();
 assert.deepEqual(events,['upload /a.mioon','opened','upload /b.mioon','failed /b.mioon PROJECT_PACKAGE_CORRUPT']);
 opener.detach(upload);opener.add(['/c.mioon']);await settle();
 assert.deepEqual(opener.pending,['/c.mioon'],'a stopped backend leaves later files queued for the next one');
 opener.attach(async()=>{throw new Error('socket closed');});await settle();
 assert.equal(events.at(-1),'failed /c.mioon UNAVAILABLE');
});
