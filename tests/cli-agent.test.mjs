import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),entry=path.join(root,'apps/cli/src/index.ts');
const projectId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),changeId=randomUUID(),requestId=randomUUID();
const configuration={presetId:'custom',platformId:'custom',baseUrl:'https://synthetic.example',model:'synthetic-model',protocol:'chat_completions'};
const policy={revision:0,stepLimit:30,modes:{read_only:'direct',local_reversible:'direct',local_irreversible:'direct',paid:'confirm'}};
const settings={revision:4,configuration,secret:{configured:false,storage:'none'},storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null},presets:[],scope:'settings_only',verification:'not_tested'};
const token='SYNTHETIC_CLI_AGENT_TOKEN_1234567890';
const snapshot=(status='completed',revision=1)=>({run:{id:runId,projectId,requestId,text:'synthetic',status,revision,stepLimit:30,budget:30,stepsUsed:1,configuration,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'},steps:[],changes:[]});
function command(args,{base,stdin=''}={}){
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MIOON_')));
 if(base)Object.assign(env,{MIOON_BASE_URL:base,MIOON_TOKEN:token});env.MIOON_ENABLE_LIVE_PROVIDER='0';
 const child=spawn(process.execPath,[entry,...args],{cwd:root,env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 child.stdout.setEncoding('utf8').on('data',value=>stdout+=value);child.stderr.setEncoding('utf8').on('data',value=>stderr+=value);child.stdin.on('error',()=>{});child.stdin.end(stdin);
 const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Synthetic CLI did not exit.'));},15000);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',(code,signal)=>{clearTimeout(timer);try{assert.equal(signal,null);const lines=stdout.trim().split('\n');assert.equal(lines.length,1);resolve({code,stdout,stderr,body:JSON.parse(stdout)});}catch(error){reject(error);}});});
 return {child,result};
}
async function fixture(t,handler){const calls=[];const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,`Bearer ${token}`);const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;calls.push({method:req.method,url:req.url,body});res.setHeader('content-type','application/json');await handler(req,res,body,calls);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return {base:`http://127.0.0.1:${server.address().port}`,calls};}
const reply=(res,value)=>res.end(JSON.stringify({ok:true,data:value}));

test('Agent help/schema are offline and management is not added to RPC schemas',async()=>{
 for(const args of [['agent','--help'],['agent','task','--help'],['agent','settings','secret','set','--help'],['schema','agent.task.send'],['schema','agent','task','approve']]){const result=await command(args).result;assert.equal(result.code,0);assert.equal(result.body.ok,true);assert.equal(result.stdout.includes(token),false);}
 const legacy=await command(['schema']).result;assert.equal(JSON.stringify(legacy.body).includes('agent.task.send'),false);
 const raw=await command(['rpc','agent.task.send','--input','{}']).result;assert.equal(raw.code,2);assert.equal(raw.body.error.code,'UNKNOWN_OPERATION');
});

test('invalid key flags, metadata, origins and diagnosis consent fail before connecting',async()=>{
 const key='SYNTHETIC_KEY_MUST_NOT_APPEAR_123456';
 const variants=[['agent','secret','set',`--key=${key}`],['agent','secret','set',`--key-stdin=${key}`],['agent','secret','set','--key-stdin','--key-file','/synthetic/missing'],['agent','secret','set','--key-stdin','--input','-'],['agent','settings','get','--workspace-origin',randomUUID()],['agent','settings','get','--key-stdin'],['agent','settings','set','--input',JSON.stringify({expectedRevision:4,configuration,secret:{value:key}})],['agent','diagnose','--input','{}']];
 for(const args of variants){const result=await command(args,{stdin:key}).result;assert.equal(result.code,2);assert.equal(result.body.ok,false);assert.equal(result.stdout.includes(key),false);assert.equal(result.stderr.includes(key),false);}
});

test('send accepts JSON stdin/input-file and stable caller identity, while mismatches never POST',async t=>{
 const f=await fixture(t,(_req,res)=>reply(res,snapshot()));const input={projectId,requestId,text:'synthetic',expectedSettingsRevision:4};
 const first=await command(['agent','task','send','--input','-'],{base:f.base,stdin:JSON.stringify(input)}).result;assert.equal(first.code,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.requestId,requestId);assert.equal(f.calls[0].body.projectId,undefined);
 const dir=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-cli-agent-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'request.json');await writeFile(file,JSON.stringify(input));
 const second=await command(['agent','task','send','--input-file',file,'--request-id',requestId],{base:f.base}).result;assert.equal(second.code,0);assert.equal(f.calls.length,2);
 const mismatch=await command(['agent','task','send','--input-file',file,'--request-id',randomUUID()],{base:f.base}).result;assert.equal(mismatch.code,2);assert.equal(f.calls.length,2);
});

test('secret defaults to persistent, is write-only and exactly redacted even from successful metadata',async t=>{
 const key='SYNTHETIC_PRIVATE_KEY_1234567890';const f=await fixture(t,(req,res,input)=>{if(req.method==='GET')reply(res,settings);else{assert.equal(input.secret.value,key);assert.equal(input.secret.storage,'persistent');reply(res,{...settings,revision:5,configuration:{...configuration,model:key},secret:{configured:true,storage:'persistent'}});}});
 const result=await command(['agent','settings','secret','set','--key-stdin','--input',JSON.stringify({expectedRevision:4,configuration})],{base:f.base,stdin:key+'\n'}).result;
 assert.equal(result.code,0);assert.equal(f.calls.length,2);assert.equal(result.body.data.secret.configured,true);assert.equal(result.body.data.configuration.model,'[redacted]');assert.equal(result.stdout.includes(key),false);assert.equal(result.stderr.includes(key),false);
});

test('persistent unavailability refuses before key input; only explicit session succeeds',async t=>{
 const f=await fixture(t,(req,res,input)=>reply(res,req.method==='GET'?{...settings,storage:{persistentAvailable:false,sessionScope:'server',reasonCode:'WEB_SESSION_ONLY'}}:{...settings,revision:5,secret:{configured:true,storage:input.secret.storage}}));const metadata=JSON.stringify({expectedRevision:4,configuration});
 const denied=await command(['agent','secret','set','--key-stdin','--input',metadata],{base:f.base,stdin:'SYNTHETIC_SESSION_KEY'}).result;assert.equal(denied.code,3);assert.equal(f.calls.length,1);
 const accepted=await command(['agent','secret','set','--key-stdin','--storage','session','--input',metadata],{base:f.base,stdin:'SYNTHETIC_SESSION_KEY'}).result;assert.equal(accepted.code,0);assert.equal(f.calls.at(-1).body.secret.storage,'session');
});

test('explicit key-file uses private regular-file policy, not permissive JSON input', {skip:process.platform==='win32'},async t=>{
 const dir=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-cli-agent-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'key');await writeFile(file,'SYNTHETIC_KEY_FILE_VALUE\n',{mode:0o600});const metadata=JSON.stringify({expectedRevision:4,configuration});
 const f=await fixture(t,(req,res,input)=>reply(res,req.method==='GET'?settings:{...settings,revision:5,secret:{configured:true,storage:input.secret.storage}}));
 assert.equal((await command(['agent','secret','set','--key-file',file,'--input',metadata],{base:f.base}).result).code,0);assert.equal(f.calls.length,2);
 await chmod(file,0o644);const denied=await command(['agent','secret','set','--key-file',file,'--input',metadata],{base:f.base}).result;assert.equal(denied.code,2);assert.equal(f.calls.length,3);assert.equal(denied.stdout.includes('SYNTHETIC_KEY_FILE_VALUE'),false);
});

test('unknown settings response reads metadata once and never retries or invents a receipt',async t=>{
 const f=await fixture(t,(req,res,_input,calls)=>{if(req.method==='GET')reply(res,calls.some(call=>call.method==='PUT')?{...settings,revision:5,secret:{configured:true,storage:'persistent'}}:settings);else req.socket.destroy();});
 const result=await command(['agent','secret','set','--key-stdin','--input',JSON.stringify({expectedRevision:4,configuration})],{base:f.base,stdin:'SYNTHETIC_UNKNOWN_KEY'}).result;
 assert.equal(result.code,3);assert.equal(result.body.error.code,'AGENT_SETTINGS_OUTCOME_UNKNOWN');assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);assert.equal(result.body.error.details.lookup,'agent settings get');
 assert.deepEqual(f.calls.map(call=>call.method),['GET','PUT','GET']);
 assert.deepEqual(result.body.error.details.observation,{state:'read',revision:5,configurationMatchesRequested:true,keyConfigured:true,keyStorage:'persistent',provesWriteSucceeded:false});
 assert.equal(result.stdout.includes('SYNTHETIC_UNKNOWN_KEY'),false);assert.equal(result.stderr.includes('SYNTHETIC_UNKNOWN_KEY'),false);
});

test('doctor performs only the public diagnostic GET; live diagnosis requires and forwards explicit profile',async t=>{
 const f=await fixture(t,(req,res)=>reply(res,req.method==='GET'?{version:1,settings,policy,authorization:{revision:0,scopes:[]},catalog:{count:89,valid:true,issues:[]},projectId,verification:'not_tested'}:snapshot()));
 const doctor=await command(['agent','doctor','--input',JSON.stringify({projectId})],{base:f.base}).result;assert.equal(doctor.code,0);assert.equal(f.calls[0].method,'GET');assert.equal(f.calls[0].url,`/api/agent/diagnostics?projectId=${projectId}`);
 const diagnose=await command(['agent','diagnose','--live','--input',JSON.stringify({projectId,requestId,expectedSettingsRevision:4,text:'synthetic diagnostic',diagnostic:{profile:'catalog',toolNames:['mioon_project_inspect']}})],{base:f.base}).result;assert.equal(diagnose.code,0);assert.equal(f.calls[1].body.diagnostic.profile,'catalog');
});

test('ordinary task send rejects diagnostic profiles before dispatch and points to explicit live diagnosis',async t=>{
 const f=await fixture(t,(_req,res)=>reply(res,snapshot()));
 const result=await command(['agent','task','send','--input',JSON.stringify({projectId,requestId,expectedSettingsRevision:4,text:'synthetic diagnostic',diagnostic:{profile:'text'}})],{base:f.base}).result;
 assert.equal(result.code,2);assert.equal(result.body.error.code,'VALIDATION_ERROR');assert.match(result.body.error.message,/agent diagnose --live/u);assert.equal(f.calls.length,0);
 const schema=await command(['schema','agent.task.send']).result;assert.equal(schema.body.data.inputSchema.properties.diagnostic,undefined);
});
test('task JSON locale selects response language independently of CLI presentation locale',async t=>{
 const f=await fixture(t,(_req,res)=>reply(res,snapshot())),input={projectId,requestId,text:'synthetic',expectedSettingsRevision:4,locale:'ja'};
 const result=await command(['agent','task','send','--locale','en','--input',JSON.stringify(input)],{base:f.base}).result;assert.equal(result.code,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.locale,'ja');assert.equal(f.calls[0].body.requestId,requestId);
 for(const locale of ['zh-CN','fr',null,1]){const rejected=await command(['agent','task','send','--input',JSON.stringify({...input,locale})],{base:f.base}).result;assert.notEqual(rejected.code,0);}assert.equal(f.calls.length,1);
});

test('all task control aliases use one action endpoint and preserve CAS',async t=>{
 const f=await fixture(t,(_req,res)=>reply(res,snapshot('paused',2)));
 const aliases={pause:'pause',resume:'resume',stop:'stop',approve:'approve',deny:'deny','undo-change':'undo_change','undo-all':'undo_all','resolve-unknown':'resolve_unknown'};
 for(const [commandName,action] of Object.entries(aliases)){const input={projectId,runId,requestId,expectedRevision:1,stepId,changeId,...(commandName==='resolve-unknown'?{resolution:'discard'}:{})};const result=await command(['agent','task',commandName,'--input',JSON.stringify(input)],{base:f.base}).result;assert.equal(result.code,0);assert.equal(f.calls.at(-1).body.action,action);assert.equal(f.calls.at(-1).body.expectedRevision,1);}
 assert.ok(f.calls.every(call=>call.url===`/api/agent/tasks/v2/${projectId}/${runId}/actions`));
});

test('watch exit statuses and progress use one stdout envelope',async t=>{
 let status='awaiting_approval';const f=await fixture(t,(_req,res)=>reply(res,snapshot(status)));
 for(const [state,exit] of [['awaiting_approval',3],['paused',3],['interrupted',3],['failed',6],['stopped',6],['completed',0]]){status=state;const result=await command(['agent','task','watch','--input',JSON.stringify({projectId,runId}),'--timeout-ms','1000'],{base:f.base}).result;assert.equal(result.code,exit);assert.equal(result.body.ok,true);assert.ok(result.stderr.includes('agent_snapshot'));}
});

test('upload reads only an explicit file and sends a managed-handle request with stable identity',async t=>{
 const dir=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-cli-agent-upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'reference.png');await writeFile(file,Buffer.from([1,2,3]));
 const f=await fixture(t,(_req,res,input)=>reply(res,{id:randomUUID(),name:input.name,mimeType:input.mimeType,status:'selected'}));
 const result=await command(['agent','task','upload','--file',file,'--input',JSON.stringify({projectId,requestId})],{base:f.base}).result;assert.equal(result.code,0);assert.equal(f.calls[0].body.requestId,requestId);assert.equal(f.calls[0].body.dataBase64,'AQID');assert.equal(f.calls[0].body.filePath,undefined);assert.equal(result.stdout.includes('AQID'),false);
});

test('watch timeout and process SIGINT stop only local observation',async t=>{
 let signalStream=()=>{};
 const f=await fixture(t,(req,res)=>{if(req.url.includes('/events?')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': keepalive\n\n');signalStream();}else reply(res,snapshot('running'));});
 const timeout=await command(['agent','task','watch','--input',JSON.stringify({projectId,runId}),'--timeout-ms','50'],{base:f.base}).result;assert.equal(timeout.code,5);assert.equal(timeout.body.error.code,'WATCH_TIMEOUT');
 const streaming=new Promise(resolve=>signalStream=resolve);
 const active=command(['agent','task','watch','--input',JSON.stringify({projectId,runId}),'--timeout-ms','10000'],{base:f.base});await streaming;active.child.kill('SIGINT');const cancelled=await active.result;assert.equal(cancelled.code,130);assert.equal(cancelled.body.error.code,'INTERRUPTED');assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('conversation is an offline-discoverable management command and forwards the server-owned identity',async t=>{
 const conversationId=randomUUID(),run={...snapshot().run,conversationId},conversation={id:conversationId,projectId,title:'First prompt',createdAt:run.createdAt,updatedAt:run.updatedAt,lastRunId:runId,lastRunStatus:'completed',changeCount:0,runCount:1};
 const schema=await command(['schema','agent','task','conversation']).result;assert.equal(schema.code,0);assert.ok(JSON.stringify(schema.body).includes('conversationId'));
 const f=await fixture(t,(req,res)=>reply(res,req.url.includes('/conversations/')?{conversation,runs:[run],nextCursor:null}:req.method==='POST'?{...snapshot(),run}:{conversations:[conversation],nextCursor:null}));
 const sent=await command(['agent','task','send','--input',JSON.stringify({projectId,conversationId,requestId,text:'synthetic',expectedSettingsRevision:4})],{base:f.base}).result;assert.equal(sent.code,0);assert.equal(f.calls[0].body.conversationId,conversationId);
 const history=await command(['agent','task','history','--input',JSON.stringify({projectId})],{base:f.base}).result;assert.equal(history.code,0);assert.deepEqual(history.body.data,{conversations:[conversation],nextCursor:null});
 const members=await command(['agent','task','conversation','--input',JSON.stringify({projectId,conversationId,cursor:'retained-cursor'})],{base:f.base}).result;assert.equal(members.code,0);assert.deepEqual(members.body.data,{conversation,runs:[run],nextCursor:null});assert.equal(f.calls.at(-1).url,`/api/agent/tasks/v2/${projectId}/conversations/${conversationId}?cursor=retained-cursor`);
});
