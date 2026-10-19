import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentGainContextFence, invokeAgentSubmissionFence, assertAgentGainRequestBudget} from '../packages/business/src/agent/gain-context-fence.ts';

test('gain submission fence accepts only synchronous completed checks and sanitizes failure text', async () => {
 let checks=0;
 invokeAgentSubmissionFence(undefined);
 const fence=createAgentGainContextFence({live:()=>true,checkTarget:()=>{checks++;}});
 invokeAgentSubmissionFence(fence);assert.equal(checks,1);
 for(const value of [null, true, 1, {}, ()=>true, ()=>null, ()=>Promise.resolve(), async()=>{throw new Error('SECRET/path');}, ()=>{throw Object.assign(new Error('SECRET/path'),{code:'CUSTOM'});}]) {
  assert.throws(()=>invokeAgentSubmissionFence(value),error=>error.code==='AGENT_CHAT_CONTEXT_CHANGED'&&!error.message.includes('SECRET'));
 }
 await new Promise(resolve=>setImmediate(resolve));
});

test('gain submission fence stops before target access after Stop and cannot recover authority after target failure',()=>{
 let live=true,valid=true,checks=0;
 const fence=createAgentGainContextFence({live:()=>live,checkTarget:()=>{checks++;if(!valid)throw new Error('private target');}});
 fence();assert.equal(checks,1);valid=false;assert.throws(fence,{code:'AGENT_CHAT_CONTEXT_CHANGED'});assert.equal(checks,2);
 live=false;assert.throws(fence,{code:'AGENT_CHAT_ABORTED'});assert.equal(checks,2);
});

test('complete serialized gain request budget counts JSON escaping and UTF-8 but leaves existing scopes untouched',()=>{
 const request={scope:'selected_timeline_clip_gain',phase:'request'},answer={...request,phase:'answer'};
 assert.doesNotThrow(()=>assertAgentGainRequestBudget('x'.repeat(30*1024),request));
 assert.throws(()=>assertAgentGainRequestBudget('x'.repeat(30*1024+1),request),{code:'AGENT_CHAT_LIMIT'});
 assert.doesNotThrow(()=>assertAgentGainRequestBudget('x'.repeat(64*1024),answer));
 assert.throws(()=>assertAgentGainRequestBudget('x'.repeat(64*1024+1),answer),{code:'AGENT_CHAT_LIMIT'});
 const escaped=JSON.stringify({text:'\u0001'.repeat(6000)});assert.ok(escaped.length>30*1024);
 assert.throws(()=>assertAgentGainRequestBudget(escaped,request),{code:'AGENT_CHAT_LIMIT'});
 assert.throws(()=>assertAgentGainRequestBudget('界'.repeat(10241),request),{code:'AGENT_CHAT_LIMIT'});
 for(const scope of [undefined,'selected_shot_edit','selected_timeline_clip_move'])assert.doesNotThrow(()=>assertAgentGainRequestBudget('x'.repeat(128*1024),scope?{scope,phase:'answer'}:undefined));
});

test('both real gain builders enforce complete escaped request bytes before any dispatch', async()=>{
 const {buildAgentRequest}=await import('../packages/business/src/agent/agent-gateway.ts');
 const {TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION}=await import('../packages/business/src/agent/timeline-gain-tool-policy.ts');
 const {AGENT_PRESETS}=await import('../packages/business/src/agent/presets.ts');
 const platform=AGENT_PRESETS.find(item=>item.id==='openai').platforms[0];
 for(const protocol of ['chat_completions','responses']){
  const configuration={presetId:'openai',platformId:platform.id,baseUrl:platform.baseUrl,model:platform.model,protocol};
  const messages=[{role:'system',content:TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION},{role:'user',content:'\\'.repeat(20000)}];
  assert.ok(messages.reduce((n,m)=>n+Buffer.byteLength(m.content),0)<30*1024);
  assert.throws(()=>buildAgentRequest({configuration,messages,readTools:{phase:'request',scope:'selected_timeline_clip_gain'},selfPort:1}),{code:'AGENT_CHAT_LIMIT'});
 }
});
