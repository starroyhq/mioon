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

test('files opened before the backend runs wait, open in order once, and failures are reported per file',async()=>{
 const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:(file,code)=>{events.push(`failed ${file} ${code}`);}});
 opener.add(['/a.mioon','/b.mioon','/a.mioon']);
 assert.deepEqual(opener.pending,['/a.mioon','/b.mioon']);
 const open=async(file:string)=>{events.push(`open ${file}`);if(file==='/b.mioon')throw new ProjectFileOpenError('PROJECT_INVALID');};
 opener.attach(open);await settle();
 assert.deepEqual(events,['open /a.mioon','opened','open /b.mioon','failed /b.mioon PROJECT_INVALID']);
 opener.detach(open);opener.add(['/c.mioon']);await settle();
 assert.deepEqual(opener.pending,['/c.mioon'],'a stopped backend leaves later files queued for the next one');
 opener.attach(async()=>{throw new Error('socket closed');});await settle();
 assert.equal(events.at(-1),'failed /c.mioon UNAVAILABLE');
});


test('a stale in-flight completion is discarded, never replayed, while later intents use the replacement',async()=>{
 let finish!:()=>void;const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:()=>{events.push('failed');}});
 const old=async(file:string)=>{events.push('old '+file);await new Promise<void>(resolve=>{finish=resolve;});};
 opener.add(['/a.mioon','/b.mioon']);const pending=opener.attach(old);await settle();
 opener.detach(old);const replacement=async(file:string)=>{events.push('new '+file);};opener.attach(replacement);finish();await pending;await settle();
 assert.deepEqual(events,['old /a.mioon','new /b.mioon','opened']);
});


test('an owned failure presentation completes before the next queued file is opened',async()=>{
 let acknowledge!:()=>void;const events:string[]=[];
 const opener=createProjectFileOpener({opened:()=>events.push('opened'),failed:async()=>{events.push('failed');await new Promise<void>(resolve=>{acknowledge=resolve;});events.push('ack');}});
 opener.add(['/bad.mioon','/good.mioon']);
 const opening=opener.attach(async file=>{events.push(file);if(file==='/bad.mioon')throw new ProjectFileOpenError('PROJECT_INVALID');});
 await settle();assert.deepEqual(events,['/bad.mioon','failed']);assert.deepEqual(opener.pending,['/good.mioon']);
 acknowledge();await opening;assert.deepEqual(events,['/bad.mioon','failed','ack','/good.mioon','opened']);
});


test('native failures retain the bounded read-only reason without forwarding arbitrary error diagnostics',async()=>{
 const observed:unknown[]=[];
 const opener=createProjectFileOpener({opened:()=>assert.fail('Must fail'),failed:(_file,code,reason)=>{observed.push([code,reason]);}});
 opener.add(['/readonly.mioon','/newer.mioon']);
 await opener.attach(async file=>{throw file==='/readonly.mioon'?Object.assign(new Error('PRIVATE'),{code:'PROJECT_INVALID',details:{reason:'read-only',private:'do not publish'}}):new ProjectFileOpenError('PROJECT_FORMAT_NEWER');});
 assert.deepEqual(observed,[['PROJECT_INVALID','read-only'],['PROJECT_FORMAT_NEWER',undefined]]);
});
