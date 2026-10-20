import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {sendWorkspaceBackup} from '../apps/server/src/workspace-backup-download.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response(backpressure=false){return Object.assign(new EventEmitter(),{headers:null,chunks:[],ended:false,writeHead(code,headers){this.headers={code,...headers};},write(chunk){this.chunks.push(chunk);return !backpressure;},end(){this.ended=true;}});}
test('backup download validates its first iterator item before publishing response headers',async()=>{const res=response();await assert.rejects(sendWorkspaceBackup(res,'synthetic',async function*(){throw Error('invalid backup');},new AbortController().signal),/invalid backup/);assert.equal(res.headers,null);assert.equal(res.listenerCount('close'),0);});
test('closing a backpressured download aborts the owned iterator without waiting for a missing drain',async()=>{const res=response(true);let returned=false,observed;const pending=sendWorkspaceBackup(res,'synthetic',signal=>(async function*(){try{observed=signal;yield new Uint8Array([1,2,3]);yield new Uint8Array([4]);}finally{returned=true;}})(),new AbortController().signal);await tick();assert.equal(res.chunks.length,1);res.emit('close');await assert.rejects(pending);assert.equal(observed.aborted,true);assert.equal(returned,true);assert.equal(res.listenerCount('drain'),0);assert.equal(res.listenerCount('error'),0);assert.equal(res.listenerCount('close'),0);});
