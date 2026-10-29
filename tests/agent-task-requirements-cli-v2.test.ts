import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {agentTaskChecksSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskChecks} from '../packages/contracts/src/agent-tasks-v2.ts';

const repository=fileURLToPath(new URL('..',import.meta.url)),entry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url)),execute=promisify(execFile);
test('H4b real checks CLI preserves optional duration requirements and only sends the requested GET',async t=>{
 const projectId=randomUUID(),runId=randomUUID(),goalStepId=randomUUID(),session='SYNTHETIC_H4B_CLI_SESSION';
 const legacy:AgentTaskChecks={projectId,runId,runRevision:3,groups:[{id:'export_render',items:[]},{id:'generation',items:[]},{id:'timeline',items:[]},{id:'decomposition_frames',items:[]}]};
 const report=agentTaskChecksSchema.parse({...legacy,requirements:[{id:`goal:${goalStepId}:0`,type:'duration',source:'goal',goalStepId,status:'failed',target:{kind:'timeline',id:projectId},basis:[{kind:'timeline',id:projectId,revision:4}],expected:{maxSeconds:30},current:{durationFrames:942,fps:30,durationSeconds:31.4},reason:{code:'PARAMETERS_MISMATCH'}}]});
 let response:AgentTaskChecks=report;const calls:Array<{method:string|undefined;url:string|undefined}>=[];
 const server=http.createServer((request,result)=>{
  assert.equal(request.headers.authorization,`Bearer ${session}`);calls.push({method:request.method,url:request.url});
  result.setHeader('content-type','application/json');result.end(JSON.stringify({ok:true,data:response}));
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MIOON_'))),MIOON_BASE_URL:`http://127.0.0.1:${address.port}`,MIOON_TOKEN:session,MIOON_ENABLE_LIVE_PROVIDER:'0'};
 for(const expected of [report,legacy]){
  response=expected;
  const result=await execute(process.execPath,[entry,'agent','task','checks','--input',JSON.stringify({projectId,runId})],{cwd:repository,env,timeout:15000,encoding:'utf8'});
  assert.deepEqual(JSON.parse(result.stdout),{ok:true,data:expected});assert.equal(result.stdout.includes(session),false);assert.equal(result.stderr.includes(session),false);
 }
 assert.deepEqual(calls,Array.from({length:2},()=>({method:'GET',url:`/api/agent/tasks/v2/${projectId}/${runId}/checks`})));
});
