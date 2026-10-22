import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAgentClient,AGENT_CONTROL_COMMANDS} from '../packages/client/src/agent.ts';
import {sanitizeAgentSettingsResult} from '../packages/business/src/agent/settings.ts';
import {AGENT_PRESETS,DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
const projectId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),changeId=randomUUID(),requestId=randomUUID();
const configuration={presetId:'custom',platformId:'custom',baseUrl:'https://synthetic.example',model:'synthetic-model',protocol:'chat_completions'};
const policy={revision:0,stepLimit:30,modes:{read_only:'direct',local_reversible:'direct',local_irreversible:'direct',paid:'confirm'}};
const settings={revision:4,configuration,secret:{configured:false,storage:'none'},storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null},presets:[],scope:'settings_only',verification:'not_tested'};
const env={MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:'SYNTHETIC_CLIENT_AGENT_TOKEN_1234567890'};
const snapshot=(status='running',revision=1)=>({run:{id:runId,projectId,requestId,text:'synthetic',status,revision,stepLimit:30,budget:30,stepsUsed:1,configuration,createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'},steps:[],changes:[]});
const ok=value=>new Response(JSON.stringify({ok:true,data:value}),{headers:{'content-type':'application/json'}});

test('settings, project and doctor accept the actual sanitized preset catalog without making optional metadata required',async()=>{
 const actual=sanitizeAgentSettingsResult({...settings,configuration:DEFAULT_AGENT_CONFIGURATION});
 assert.deepEqual(actual.presets,AGENT_PRESETS);
 const client=createAgentClient({env,fetchImpl:async url=>{
  if(url.endsWith('/settings'))return ok(actual);
  if(url.includes('/diagnostics'))return ok({version:1,settings:actual,policy,authorization:{revision:0,scopes:[]},catalog:{count:89,valid:true,issues:[]},verification:'not_tested'});
  return ok({version:2,instanceId:'synthetic-instance',projectId,runs:[],policy,settings:actual,authorization:{revision:0,scopes:[]}});
 }});
 assert.deepEqual((await client.settingsGet()).presets,AGENT_PRESETS);
 assert.deepEqual((await client.list({projectId})).settings.presets,AGENT_PRESETS);
 assert.deepEqual((await client.doctor()).settings.presets,AGENT_PRESETS);
});

test('Agent management is a separate local client, rejects extra authority and never invents request IDs',async()=>{
 let calls=0;const client=createAgentClient({env,fetchImpl:async()=>{calls++;return ok(snapshot());}});
 for(const value of [{projectId,text:'test',expectedSettingsRevision:4},{projectId,requestId,text:'test',expectedSettingsRevision:4,approved:true},{projectId,requestId,text:'test',expectedSettingsRevision:4,configuration}])await assert.rejects(client.send(value),error=>error.code==='VALIDATION_ERROR');
 assert.equal(calls,0);
});
test('send accepts only explicit supported response locales and forwards them without changing request identity',async()=>{
 const calls=[],client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url,options});return ok(snapshot());}}),input={projectId,requestId,text:'synthetic',expectedSettingsRevision:4};
 for(const locale of ['zh-Hans','zh-Hant','en','ja']){await client.send({...input,locale});const body=JSON.parse(calls.at(-1).options.body);assert.equal(body.locale,locale);assert.equal(body.requestId,requestId);assert.equal(body.projectId,undefined);}
 for(const locale of [null,'zh-CN','EN','fr',1,{}])await assert.rejects(client.send({...input,locale}),error=>error.code==='VALIDATION_ERROR');assert.equal(calls.length,4);
 await client.send(input);assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).options.body),'locale'),false);
});

test('send forwards diagnostic modes and exact identities to REST without host IDs in the body',async()=>{
 for(const profile of ['text','read_only','catalog']){
  const requests=[];const client=createAgentClient({env,fetchImpl:async(url,options)=>{requests.push({url,options});return ok(snapshot());}});
  await client.send({projectId,requestId,text:'synthetic',expectedSettingsRevision:4,diagnostic:{profile,...(profile==='catalog'?{toolNames:['mioon_project_inspect']}: {})}});
  assert.equal(requests.length,1);assert.equal(requests[0].url,`http://127.0.0.1:4318/api/agent/tasks/v2/${projectId}`);
  const body=JSON.parse(requests[0].options.body);assert.equal(body.requestId,requestId);assert.equal(body.expectedSettingsRevision,4);assert.equal(body.projectId,undefined);assert.equal(body.diagnostic.profile,profile);
  assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.headers.origin,undefined);
 }
});

test('all controls preserve caller CAS and request ID and action lookups are GET only',async()=>{
 const calls=[];const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url,options});return ok(options.method==='POST'?snapshot('paused',9):{found:true,snapshot:snapshot('paused',9),receipt:{requestId,runId,action:'pause',revision:9,result:{}}});}});
 for(const [command,action] of Object.entries(AGENT_CONTROL_COMMANDS)){
  await client.action(command,{projectId,runId,requestId,expectedRevision:8,stepId,changeId,...(command==='resolve-unknown'?{resolution:'discard'}:{})});
  const body=JSON.parse(calls.at(-1).options.body);assert.equal(body.action,action);assert.equal(body.expectedRevision,8);assert.equal(body.requestId,requestId);assert.equal(body.projectId,undefined);
 }
 await client.actionLookup({projectId,runId,requestId});assert.equal(calls.at(-1).options.method,'GET');assert.ok(calls.at(-1).url.endsWith(`/actions/${requestId}`));
});

test('lost and invalid write responses never retry and give only original GET recovery',async()=>{
 const scenarios=[
  {write:c=>c.send({projectId,requestId,text:'synthetic',expectedSettingsRevision:4}),read:c=>c.lookup({projectId,requestId}),reply:{found:false}},
  {write:c=>c.action('pause',{projectId,runId,requestId,expectedRevision:1}),read:c=>c.actionLookup({projectId,runId,requestId}),reply:{found:false}},
  {write:c=>c.upload({projectId,requestId,name:'synthetic.png',mimeType:'image/png',dataBase64:'AQ=='}),read:c=>c.uploadLookup({projectId,requestId}),reply:{found:false}},
  {write:c=>c.policySet({stepLimit:policy.stepLimit,modes:policy.modes,expectedRevision:0,requestId}),read:c=>c.policyLookup({requestId}),reply:{found:false,readOnly:false}},
 ];
 for(const lost of [true,false])for(const scenario of scenarios){
  const calls=[];const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url,options});if(options.method!=='GET'){if(lost)throw Error('SYNTHETIC_SECRET_BODY');return ok({wrong:'response'});}return ok(scenario.reply);}});
  await assert.rejects(scenario.write(client),error=>error.exitCode===3&&error.details.outcomeUnknown===true&&error.details.lookup.startsWith('agent '));
  assert.equal(calls.length,1);await scenario.read(client);assert.equal(calls.length,2);assert.equal(calls[1].options.method,'GET');
 }
});

test('unknown settings writes read the same connection once and remain unknown even if configured is true',async()=>{
 for(const lost of [true,false]){
  const calls=[],chosen='SYNTHETIC_REPLACEMENT_KEY_NEVER_ECHO',mutableEnv={...env};
  const client=createAgentClient({env:mutableEnv,fetchImpl:async(url,options)=>{
   calls.push({url,options});
   if(options.method==='PUT'){
    mutableEnv.MIOON_BASE_URL='http://127.0.0.1:4320';mutableEnv.MIOON_TOKEN='SYNTHETIC_DIFFERENT_CONNECTION_TOKEN';
    if(lost)throw Error(chosen);return ok({wrong:chosen});
   }
   return ok({...settings,revision:5,secret:{configured:true,storage:'persistent'},unexpectedSecret:chosen});
  }});
  await assert.rejects(client.settingsPut({expectedRevision:4,configuration},{action:'replace',storage:'persistent',value:chosen}),error=>{
   assert.equal(error.code,'AGENT_SETTINGS_OUTCOME_UNKNOWN');assert.equal(error.exitCode,3);assert.equal(error.details.outcomeUnknown,true);
   assert.deepEqual(error.details.observation,{state:'read',revision:5,configurationMatchesRequested:true,keyConfigured:true,keyStorage:'persistent',provesWriteSucceeded:false});
   assert.equal(JSON.stringify(error).includes(chosen),false);return true;
  });
  assert.deepEqual(calls.map(c=>c.options.method),['PUT','GET']);
  assert.ok(calls.every(c=>c.url==='http://127.0.0.1:4318/api/agent/settings'));
  assert.ok(calls.every(c=>c.options.headers.authorization===`Bearer ${env.MIOON_TOKEN}`));
  assert.equal(calls[1].options.body,undefined);
 }
});
test('failed settings readback preserves uncertainty without response data or a second write',async()=>{
 const calls=[],marker='SYNTHETIC_READBACK_ERROR_NEVER_ECHO';
 const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push(options.method);if(options.method==='PUT')throw Error(marker);return new Response(JSON.stringify({ok:false,error:{code:'AGENT_SETTINGS_'+marker,message:marker,details:{key:marker}}}),{status:503});}});
 await assert.rejects(client.settingsPut({expectedRevision:4,configuration}),error=>{
  assert.equal(error.code,'AGENT_SETTINGS_OUTCOME_UNKNOWN');assert.deepEqual(error.details.observation,{state:'unavailable',code:'BACKEND_UNAVAILABLE',provesWriteSucceeded:false});assert.equal(JSON.stringify(error).includes(marker),false);return true;
 });
 assert.deepEqual(calls,['PUT','GET']);
});
test('a successful HTTP status carrying a rejection envelope is unverified, never a known settings failure',async()=>{
 const calls=[];const client=createAgentClient({env,fetchImpl:async(_url,options)=>{calls.push(options.method);return options.method==='PUT'?new Response(JSON.stringify({ok:false,error:{code:'AGENT_SETTINGS_CONFLICT'}}),{status:200}):ok(settings);}});
 await assert.rejects(client.settingsPut({expectedRevision:4,configuration}),error=>error.code==='AGENT_SETTINGS_OUTCOME_UNKNOWN'&&error.details.outcomeUnknown===true&&error.details.observation.state==='read');
 assert.deepEqual(calls,['PUT','GET']);
});
test('settings cancellation performs no readback, and a timed-out write only observes once',async()=>{
 const controller=new AbortController(),calls=[];
 const client=createAgentClient({env,fetchImpl:async(_url,options)=>{calls.push(options.method);controller.abort();throw Error('synthetic abort');}});
 await assert.rejects(client.settingsPut({expectedRevision:4,configuration},{action:'keep'},{signal:controller.signal}),error=>error.exitCode===130&&error.details.outcomeUnknown===true&&error.details.observation.state==='not_attempted');
 assert.deepEqual(calls,['PUT']);
 const timed=[];const timeoutClient=createAgentClient({env,fetchImpl:async(_url,options)=>{timed.push(options.method);if(options.method==='GET')return ok(settings);return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('synthetic timeout')),{once:true}));}});
 await assert.rejects(timeoutClient.settingsPut({expectedRevision:4,configuration},{action:'keep'},{timeoutMs:25}),error=>error.exitCode===5&&error.details.outcomeUnknown===true&&error.details.observation.state==='read'&&error.details.observation.provesWriteSucceeded===false);
 assert.deepEqual(timed,['PUT','GET']);
});
test('cancellation during the sole settings readback exits locally with 130 while retaining the unknown write',async()=>{
 const controller=new AbortController(),calls=[];
 const client=createAgentClient({env,fetchImpl:async(_url,options)=>{
  calls.push(options.method);if(options.method==='PUT')throw Error('synthetic response loss');
  return new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('synthetic readback cancelled')),{once:true});setTimeout(()=>controller.abort(),20);});
 }});
 await assert.rejects(client.settingsPut({expectedRevision:4,configuration},{action:'keep'},{signal:controller.signal}),error=>{
  assert.equal(error.code,'INTERRUPTED');assert.equal(error.exitCode,130);assert.equal(error.details.outcomeUnknown,true);
  assert.deepEqual(error.details.observation,{state:'unavailable',code:'INTERRUPTED',provesWriteSucceeded:false});return true;
 });
 assert.deepEqual(calls,['PUT','GET']);
});

test('public settings and doctor drop unknown fields, and backend errors never reflect response messages',async()=>{
 const secret='SYNTHETIC_KEY_NEVER_ECHO_123';let calls=0;
 const client=createAgentClient({env,fetchImpl:async()=>{calls++;return calls===1?ok({...settings,apiKey:secret}):new Response(JSON.stringify({ok:false,error:{code:'AGENT_SETTINGS_CONFLICT',message:secret,details:{key:secret}}}),{status:409});}});
 assert.equal((await client.settingsGet()).apiKey,undefined);
 await assert.rejects(client.settingsPut({expectedRevision:4,configuration},{action:'replace',storage:'persistent',value:secret}),error=>error.code==='AGENT_SETTINGS_CONFLICT'&&!JSON.stringify(error).includes(secret)&&!error.message.includes(secret));
 const doctor=createAgentClient({env,fetchImpl:async(url,options)=>{assert.equal(options.method,'GET');assert.ok(url.endsWith(`/api/agent/diagnostics?projectId=${projectId}`));return ok({version:1,settings,policy,authorization:{revision:0,scopes:[]},catalog:{count:89,valid:true,issues:[]},projectId,verification:'not_tested',headers:{authorization:secret}});}});
 assert.equal((await doctor.doctor({projectId})).headers,undefined);
});

test('watch reads durable snapshots after fragmented CRLF SSE notifications and never writes',async()=>{
 const calls=[];let reads=0,cancelled=false;
 const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url,method:options.method??'GET'});if(url.includes('/events?')){
  assert.ok(url.endsWith('after=3'));const frame=`id: 7\r\nevent: changed\r\ndata: ${JSON.stringify({id:7,type:'changed',runId,sequence:7,data:{revision:2}})}\r\n\r\n`;
  return new Response(new ReadableStream({start(controller){for(let i=0;i<frame.length;i+=11)controller.enqueue(Buffer.from(frame.slice(i,i+11)));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
 }return ok(snapshot(++reads===1?'running':'completed',reads));}});
 const progress=[];const result=await client.watch({projectId,runId,after:3},{timeoutMs:1000,onProgress:(value,sequence)=>progress.push([value.run.status,sequence])});
 assert.equal(result.outcome,'completed');assert.equal(result.sequence,7);assert.equal(reads,2);assert.equal(cancelled,true);assert.ok(calls.every(call=>call.method==='GET'));assert.deepEqual(progress,[['running',3],['completed',7]]);
});

test('SSE disconnection recovers with GET, action-needed stops observation and does not resume',async()=>{
 let reads=0,streams=0;const client=createAgentClient({env,fetchImpl:async(url,options)=>{assert.equal(options.method??'GET','GET');if(url.includes('/events?')){streams++;throw Error('offline');}return ok(snapshot(++reads===1?'running':'awaiting_approval',reads));}});
 const result=await client.watch({projectId,runId},{timeoutMs:1000,intervalMs:20});assert.equal(result.outcome,'action_needed');assert.equal(streams,1);assert.equal(reads,2);
});

test('watch deadline and cancellation are local only',async()=>{
 const fetchImpl=async(url,options)=>{if(!url.includes('/events?'))return ok(snapshot());return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));};
 const client=createAgentClient({env,fetchImpl});await assert.rejects(client.watch({projectId,runId},{timeoutMs:30}),error=>error.exitCode===5);
 const controller=new AbortController();const promise=client.watch({projectId,runId},{signal:controller.signal,timeoutMs:1000});setTimeout(()=>controller.abort(),20);await assert.rejects(promise,error=>error.exitCode===130);
});

test('receipt lookups reject a different resource or request identity',async()=>{
 for(const [method,input,response] of [
  ['lookup',{projectId,requestId},{found:true,upload:{id:randomUUID(),name:'wrong',mimeType:'image/png',status:'selected'}}],
  ['lookup',{projectId,requestId},{found:true,snapshot:{...snapshot(),run:{...snapshot().run,requestId:randomUUID()}}}],
  ['uploadLookup',{projectId,requestId},{found:true,snapshot:snapshot()}],
  ['actionLookup',{projectId,runId,requestId},{found:true,snapshot:snapshot()}],
  ['policyLookup',{requestId},{found:true,readOnly:false}],
 ]){const client=createAgentClient({env,fetchImpl:async()=>ok(response)});await assert.rejects(client[method](input),error=>error.code==='BACKEND_PROTOCOL_ERROR');}
});

test('policy CAS and independent read routes preserve their exact boundaries',async()=>{
 const calls=[];const upload={id:randomUUID(),name:'reference.png',mimeType:'image/png',status:'selected'};
 const client=createAgentClient({env,fetchImpl:async(url,options)=>{calls.push({url,options});if(url.includes('/policy/requests/'))return ok({found:true,policy:{...policy,revision:1},readOnly:false});if(url.endsWith('/policy'))return ok({policy:{...policy,revision:options.method==='PUT'?1:0},readOnly:false});if(url.includes('/uploads/requests/'))return ok({found:true,upload});if(url.includes('/history?'))return ok({runs:[snapshot().run],nextCursor:null});return ok({version:2,instanceId:'synthetic-instance',projectId,runs:[snapshot().run],policy,settings,authorization:{revision:0,scopes:[]}});}});
 await client.policyGet();await client.policySet({requestId,expectedRevision:0,stepLimit:30,modes:policy.modes});await client.policyLookup({requestId});await client.list({projectId});await client.history({projectId,cursor:'retained-cursor'});await client.uploadLookup({projectId,requestId});
 assert.equal(calls.filter(call=>call.options.method!=='GET').length,1);assert.equal(calls[1].options.method,'PUT');assert.equal(JSON.parse(calls[1].options.body).expectedRevision,0);assert.ok(calls[4].url.endsWith('/history?cursor=retained-cursor'));assert.ok(calls[5].url.endsWith(`/uploads/requests/${requestId}`));
});
