import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {createPrivateTemporaryDirectory,validateManagedFile} from '../packages/contracts/src/private-storage.ts';

test('native Windows headless backend and separate CLI share private storage, diagnostics and synthetic v2 tool/control receipts',{skip:process.platform!=='win32',timeout:180000},async t=>{
 await initializeNodePrivateStorage();
 const root=createPrivateTemporaryDirectory(tmpdir(),'mioon-node-host-smoke-');
 const {startServer}=await import('../apps/server/src/index.ts');
 const {createHeadlessAgentSecretCodec}=await import('../apps/server/src/headless-agent-secret-codec.ts');
 let modelCalls=0;
 const gateway=async function*(request){
  request.beforeSubmit?.();modelCalls++;
  const body=JSON.parse(request.body),answered=body.messages.some(item=>item.role==='tool');
  if(answered){const text='Windows synthetic tool loop completed';yield {type:'done',output:{text,toolCalls:[],providerOutput:{role:'assistant',content:text}}};}
  else{const call={id:'windows_synthetic_shot',name:'mioon_shot_create',arguments:{title:'Windows synthetic reversible shot'}};yield {type:'done',output:{text:'',toolCalls:[call],providerOutput:{role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}}};}
 };
 const service=await startServer({dataDir:root,port:0,agentSecretCodecFactory:createHeadlessAgentSecretCodec,taskGatewayV2:gateway});
 t.after(async()=>{await service.close();rmSync(root,{recursive:true,force:true});});
 const env={...process.env,MIOON_BASE_URL:service.url,MIOON_TOKEN_FILE:service.tokenFile};delete env.MIOON_TOKEN;delete env.MIOON_CONNECTION_FILE;
 const entry=fileURLToPath(new URL('../apps/cli/src/index.ts',import.meta.url));
 async function cli(words,input={},options={}){
  const child=spawn(process.execPath,[entry,...words,'--input',JSON.stringify(input),...(options.flags??[])],{env,stdio:[options.key===undefined?'ignore':'pipe','pipe','pipe']});
  if(options.key!==undefined)child.stdin.end(options.key);
  let stdout='',stderrBytes=0;child.stdout.setEncoding('utf8').on('data',bytes=>{stdout+=bytes;if(Buffer.byteLength(stdout)>512*1024)child.kill('SIGKILL');});child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI smoke deadline exceeded'));},20000);child.once('error',()=>{clearTimeout(timer);reject(Error('Synthetic CLI launch failed'));});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  const lines=stdout.trim().split('\n');assert.equal(lines.length,1);const envelope=JSON.parse(lines[0]);assert.deepEqual(result,{code:0,signal:null},JSON.stringify({command:words.join('.'),code:envelope.error?.code,message:envelope.error?.message}));assert.equal(envelope.ok,true);assert.ok(stderrBytes<8192);return envelope.data;
 }
 assert.ok(validateManagedFile(service.tokenFile,{root:path.dirname(service.tokenFile),private:true}));
 const settings=await cli(['agent','settings','get']);assert.equal(settings.secret.configured,false);
 const project=await cli(['project','create'],{name:'Windows isolated native CLI smoke'});assert.match(project.id,/^[a-f0-9-]{36}$/u);
 const listed=await cli(['project','list']);assert.deepEqual(listed.map(value=>value.id),[project.id]);
 const doctor=await cli(['agent','doctor'],{projectId:project.id});assert.equal(doctor.verification,'not_tested');assert.equal(doctor.catalog.valid,true);assert.ok(doctor.catalog.count>0);
 const {policy}=await cli(['agent','policy','get']);assert.equal(policy.stepLimit,30);assert.equal(policy.modes.paid,'confirm');
 assert.ok(validateManagedFile(path.join(root,'workbench.sqlite'),{root}));assert.ok(validateManagedFile(service.tokenFile,{root:path.dirname(service.tokenFile),private:true}));assert.equal(modelCalls,0);
 // Only this constructor-injected synthetic generator can answer. This is
 // actual v2 CLI/SQLite/tool execution, never a real vendor/model acceptance.
 const secured=await cli(['agent','settings','secret','set'],{expectedRevision:settings.revision,configuration:settings.configuration},{key:'SYNTHETIC_WINDOWS_SESSION_NO_PROVIDER',flags:['--key-stdin','--storage','session']});
 const authorization=await cli(['agent','authorization','list']);
 await cli(['agent','authorization','grant'],{requestId:randomUUID(),expectedRevision:authorization.revision,expectedSettingsRevision:secured.revision,destination:authorization.currentTarget.destination,model:authorization.currentTarget.model,scope:'project_agent'});
 const send={projectId:project.id,requestId:randomUUID(),expectedSettingsRevision:secured.revision,text:'Create one synthetic shot for the isolated Windows task-control test'};
 const accepted=await cli(['agent','task','send'],send);
 const ended=await cli(['agent','task','status'],{projectId:project.id,runId:accepted.run.id});assert.equal(ended.run.status,'completed');assert.equal(ended.changes.length,1);assert.equal(modelCalls,2);
 const control={projectId:project.id,runId:ended.run.id,requestId:randomUUID(),expectedRevision:ended.run.revision};
 const undone=await cli(['agent','task','undo-all'],control);assert.equal(undone.run.status,'reverted');assert.ok(undone.changes.every(change=>change.status==='reverted'));
 assert.deepEqual(await cli(['agent','task','undo-all'],control),undone);
 const receipt=await cli(['agent','task','action-lookup'],{projectId:project.id,runId:ended.run.id,requestId:control.requestId});assert.equal(receipt.found,true);
 const original=await cli(['agent','task','lookup'],{projectId:project.id,requestId:send.requestId});assert.equal(original.found,true);assert.equal(modelCalls,2);
});
