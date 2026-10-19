import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createComfyTransport, resolveComfyDestination, validateComfyDescriptor} from '../packages/business/src/comfy/network.ts';
import {COMFY_NETWORK_LIMITS} from '../packages/business/src/comfy/profile.ts';

const baseUrl='http://127.0.0.1:8188', id='11111111-1111-4111-8111-111111111111';
const filenamePrefix=`mioon_${id}`, descriptor={filename:`${filenamePrefix}_00001_.png`,subfolder:'',type:'output'};
const submit={baseUrl,operation:'submit',body:'{}',beforeSubmit:()=>{}};
function mock({peer='127.0.0.1',port=8188,status=200,headers={'content-type':'application/json'},body=Buffer.from('{}'),complete=true,chunks,onConnect,onEnd,noConnect=false,noResponse=false,early=false}={}) {
  const state={created:0,ends:0,destroyed:0};
  state.httpRequest=(options,callback)=>{
    state.created++;state.options=options;
    const req=new EventEmitter(),socket=new EventEmitter();
    Object.assign(socket,{remoteAddress:peer,remotePort:port,destroy(){state.destroyed++;}});
    req.socket=socket;req.destroy=()=>{state.destroyed++;};
    const respond=()=>{const incoming=Readable.from(chunks??[body]);Object.assign(incoming,{statusCode:status,headers,complete,socket});callback(incoming);};
    req.end=payload=>{state.ends++;state.payload=payload;onEnd?.(state);if(!noResponse)respond();};
    queueMicrotask(()=>{req.emit('socket',socket);onConnect?.(state);if(early)respond();if(!noConnect)socket.emit('connect');});
    return req;
  };
  return state;
}
const transport=(state,options={})=>createComfyTransport({httpRequest:state.httpRequest,reservedPorts:()=>[4318],...options});
test('literal loopback endpoint rejects aliases, paths, credentials and runtime-owned ports before I/O',()=>{
  for(const value of ['',undefined,'http://localhost:8188','https://127.0.0.1:8188','http://127.1:8188','http://2130706433:8188','http://127.0.0.2:8188','http://[::ffff:127.0.0.1]:8188','http://[0:0:0:0:0:0:0:1]:8188','http://127.0.0.1','http://127.0.0.1:080','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:8188/','http://127.0.0.1:8188/api','http://a@127.0.0.1:8188','http://127.0.0.1:8188?x=1','http://127.0.0.1:8188#x','http://127.0.0.1:8188\\a','http://127.0.0.1:4318'])assert.throws(()=>resolveComfyDestination(value,{reservedPorts:[4318]}),{code:'COMFY_NETWORK_DENIED'});
  for(const reservedPorts of [undefined,[],[0],[1.5],['4318']])assert.throws(()=>resolveComfyDestination(baseUrl,{reservedPorts}),{code:'COMFY_NETWORK_DENIED'});
  assert.deepEqual(resolveComfyDestination('http://[::1]:8188',{reservedPorts:new Set([4318])}),{address:'::1',family:6,port:8188});
});
test('transport pins peer, port, fixed route and final synchronous fence without proxy, DNS or credentials',async()=>{
  const order=[],state=mock({onConnect:()=>order.push('connect'),onEnd:()=>order.push('end')});
  const result=await transport(state)({...submit,beforeSubmit:()=>{assert.equal(state.ends,0);order.push('fence');}});
  assert.deepEqual(order,['connect','fence','end']);assert.equal(result.dispatched,true);assert.equal(state.ends,1);
  const o=state.options;assert.equal(o.hostname,'127.0.0.1');assert.equal(o.port,8188);assert.equal(o.path,'/prompt');assert.equal(o.protocol,'http:');assert.equal(o.agent,false);assert.equal(o.autoSelectFamily,false);
  assert.deepEqual(Object.keys(o.headers).sort(),['Accept','Accept-Encoding','Connection','Content-Length','Content-Type']);
  assert.equal(o.headers['Accept-Encoding'],'identity');assert.equal(o.headers.Authorization,undefined);assert.equal(o.headers.Cookie,undefined);
  assert.equal(await new Promise(resolve=>o.lookup('localhost',error=>resolve(error.code))),'COMFY_NETWORK_DENIED');
});
test('peer mismatches, endpoint now self-owned, early responses and invalid fences never dispatch',async()=>{
  for(const setup of [{peer:'127.0.0.2'},{peer:'::1'},{port:4318},{early:true}]){
    const state=mock(setup);await assert.rejects(transport(state)(submit),error=>error.dispatched===false);assert.equal(state.ends,0);
  }
  let ports=[4318];const state=mock({onConnect:()=>{ports=[4318,8188];}});
  await assert.rejects(transport(state,{reservedPorts:()=>ports})(submit),{code:'COMFY_NETWORK_DENIED',dispatched:false});assert.equal(state.ends,0);
  for(const beforeSubmit of [async()=>{},()=>{throw Error('private detail');}]){
    const state=mock();await assert.rejects(transport(state)({...submit,beforeSubmit}),{code:'COMFY_DISPATCH_BLOCKED',dispatched:false});assert.equal(state.ends,0);
  }
});
test('only typed known-node, exact job and safe PNG view GET routes exist',async()=>{
  for(const args of [{operation:'queue'},{operation:'history'},{operation:'cancel'},{operation:'interrupt'},{operation:'upload'},{operation:'free'},{operation:'node',nodeClass:'CustomNode'},{operation:'job',promptId:'../queue'},{operation:'system',body:'{}'},{operation:'system',beforeSubmit:()=>{}}]){
    const state=mock();await assert.rejects(transport(state)({baseUrl,...args}));assert.equal(state.created,0);
  }
  const cases=[{operation:'system',path:'/system_stats'},{operation:'node',nodeClass:'KSampler',path:'/object_info/KSampler'},{operation:'job',promptId:id,path:`/api/jobs/${id}`},{operation:'view',descriptor,filenamePrefix,path:`/view?filename=${descriptor.filename}&subfolder=&type=output`}];
  for(const args of cases){const state=mock({headers:{'content-type':args.operation==='view'?'image/png':'application/json'}});const result=await transport(state)({baseUrl,...args});assert.equal(state.options.path,args.path);assert.equal(state.options.method,'GET');assert.equal(result.dispatched,false);assert.equal(state.payload,undefined);}
  for(const change of [{filename:'../a.png'},{filename:'http://127.0.0.1/x.png'},{filename:`${filenamePrefix}_00001_.png?x=1`},{filename:`${filenamePrefix}_00001_.jpg`},{filename:'other_00001_.png'},{subfolder:'../'},{type:'temp'},{channel:'rgb'}])assert.throws(()=>validateComfyDescriptor({...descriptor,...change},filenamePrefix));
});
test('POST redirects/errors never retry and lost acknowledgement remains unknown',async()=>{
  for(const status of [301,302,303,307,308,400,401,403,404,429,500]){
    const state=mock({status,headers:{'content-type':'application/json',location:'http://attacker.invalid'}});
    await assert.rejects(transport(state)(submit),{code:'COMFY_HTTP_ERROR',dispatched:true,outcomeUnknown:true});assert.equal(state.created,1);assert.equal(state.ends,1);
  }
  const state=mock({noResponse:true});await assert.rejects(transport(state,{limits:{jsonTimeoutMs:10}})(submit),{code:'COMFY_TIMEOUT',dispatched:true,outcomeUnknown:true});assert.equal(state.ends,1);
});
test('JSON and PNG responses have streaming caps and strict encoding/completeness',async()=>{
  for(const args of [{headers:{'content-type':'text/html'}},{headers:{'content-type':'application/json','content-encoding':'gzip'}},{complete:false},{headers:{'content-type':'application/json','content-length':'3'}}]){
    const state=mock(args);await assert.rejects(transport(state)(submit),error=>error.dispatched&&error.outcomeUnknown);
  }
  for(const operation of ['system','view'])for(const args of [{headers:{'content-type':operation==='view'?'image/png':'application/json','content-length':'101'}},{headers:{'content-type':operation==='view'?'image/png':'application/json'},chunks:[Buffer.alloc(60),Buffer.alloc(41)]}]){
    const state=mock(args);await assert.rejects(transport(state,{limits:{maxStatusBytes:100,maxPngBytes:100}})({baseUrl,operation,descriptor,filenamePrefix}),{code:'COMFY_RESPONSE_TOO_LARGE',dispatched:false});
  }
  assert.throws(()=>transport(mock(),{limits:{maxStatusBytes:COMFY_NETWORK_LIMITS.maxStatusBytes+1}}));
});
test('abort before or inside fence prevents POST; abort after end destroys observation without retry/cancel',async()=>{
  const pre=new AbortController();pre.abort();const a=mock();await assert.rejects(transport(a)({...submit,signal:pre.signal}),{code:'COMFY_ABORTED',dispatched:false});assert.equal(a.created,0);
  const mid=new AbortController(),b=mock();await assert.rejects(transport(b)({...submit,signal:mid.signal,beforeSubmit:()=>mid.abort()}),{code:'COMFY_ABORTED',dispatched:false});assert.equal(b.ends,0);
  const post=new AbortController(),c=mock({onEnd:()=>post.abort()});await assert.rejects(transport(c)({...submit,signal:post.signal}),{code:'COMFY_ABORTED',dispatched:true,outcomeUnknown:true});assert.equal(c.created,1);assert.equal(c.ends,1);assert.ok(c.destroyed>0);
  const d=mock({noConnect:true});await assert.rejects(transport(d,{limits:{connectTimeoutMs:5}})(submit),{code:'COMFY_TIMEOUT',dispatched:false});assert.equal(d.ends,0);
});
