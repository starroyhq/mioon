import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeAgentSubmissionFence} from '../packages/business/src/agent/submission-fence.ts';

test('submission fence accepts only synchronous completed checks and sanitizes failure text', async () => {
 let checks=0;
 invokeAgentSubmissionFence(undefined);
 const fence=()=>{checks++;};
 invokeAgentSubmissionFence(fence);assert.equal(checks,1);
 for(const value of [null, true, 1, {}, ()=>true, ()=>null, ()=>Promise.resolve(), async()=>{throw new Error('SECRET/path');}, ()=>{throw Object.assign(new Error('SECRET/path'),{code:'CUSTOM'});}]) {
  assert.throws(()=>invokeAgentSubmissionFence(value),(error: unknown)=>{const failure=error as {code?: string; message?: string};return failure.code==='AGENT_CHAT_CONTEXT_CHANGED'&&!String(failure.message).includes('SECRET');});
 }
 await new Promise<void>(resolve=>setImmediate(resolve));
});
