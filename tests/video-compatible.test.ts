import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {createConfiguredVideoProvider} from '../packages/business/src/video/runtime.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {compatibleVideoSize} from '../packages/business/src/video/adapters.ts';
import {createCompatibleVideoSdkClient} from '../packages/business/src/video/compatible-sdk.ts';
import {createPinnedVideoFetch,isUndispatchedVideoNetworkFailure} from '../packages/business/src/video/network.ts';
import {checkCompatibleVideoService} from '../packages/business/src/video/compatible-check.ts';
import {createVideoHttp} from '../apps/server/src/video-http.ts';
import {safeCompatibleCheck} from '../apps/web/src/video-settings.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {defaultVideoModels,normalizeCompatibleVideoBaseUrl,parseVideoBinding,videoConnectionConfigurationSchema,videoConnectionEndpoint,videoOutputHosts} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';

const BASE='https://api.example.com/v1',KEY='synthetic-compatible-key';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const mp4=Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
function png(width=360,height=640):Buffer {
  const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(body));return Buffer.concat([size,body,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const configuration=(patch:Partial<VideoConnectionConfiguration>={}):VideoConnectionConfiguration=>({id:randomUUID(),providerId:'compatible',name:'My aggregator',region:'custom',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('compatible'),baseUrl:BASE,...patch});

test('a compatible connection names one normalized https origin; official providers never carry one',()=>{
  assert.equal(videoConnectionConfigurationSchema.safeParse(configuration()).success,true);
  for(const baseUrl of ['http://api.example.com/v1','https://127.0.0.1/v1','https://api.example.com/v1/','https://user@api.example.com/v1','https://api.example.com:8443/v1','https://api.example.com/v1?x=1',undefined])
    assert.equal(videoConnectionConfigurationSchema.safeParse(configuration({baseUrl})).success,false,String(baseUrl));
  assert.equal(videoConnectionConfigurationSchema.safeParse(configuration({region:'global'})).success,false);
  const official={id:randomUUID(),providerId:'minimax' as const,name:'Official',region:'global',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('minimax')};
  assert.equal(videoConnectionConfigurationSchema.safeParse(official).success,true);
  assert.equal(videoConnectionConfigurationSchema.safeParse({...official,baseUrl:BASE}).success,false);
  assert.equal(normalizeCompatibleVideoBaseUrl('https://API.Example.com/v1/'),BASE);
  assert.equal(videoConnectionEndpoint(configuration()),BASE);
  assert.equal(videoConnectionEndpoint(official),'https://api.minimax.io');
  const model=defaultVideoModels('compatible')[0]!;
  assert.deepEqual([model.modelId,model.templateId,model.aspectRatios,model.durationResolutionMap],['sora-2','openai-video-v1',['9:16','16:9'],[{duration:[4,8,12],resolution:['720p']}]]);
});

test('frozen compatible bindings keep their own host as an output host and reject a changed origin',()=>{
  const binding:VideoExecutionBinding={version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'compatible',region:'custom',workspaceId:'',endpoint:BASE,credentialRef:randomUUID(),model:defaultVideoModels('compatible')[0]!,outputHosts:['cdn.example.com']};
  assert.equal(parseVideoBinding(binding).endpoint,BASE);
  assert.deepEqual(videoOutputHosts(binding),['api.example.com','cdn.example.com']);
  assert.throws(()=>parseVideoBinding({...binding,endpoint:'http://api.example.com/v1'}),{code:'VIDEO_BINDING_INVALID'});
  assert.throws(()=>parseVideoBinding({...binding,endpoint:'https://10.0.0.1/v1'}),{code:'VIDEO_BINDING_INVALID'});
});

test('OpenAI sizes and the official SDK multipart fields preserve the complete image bytes',async()=>{
  assert.equal(compatibleVideoSize('9:16','720p'),'720x1280');assert.equal(compatibleVideoSize('16:9','1080p'),'1920x1080');
  assert.equal(compatibleVideoSize('1:1','480p'),'480x480');assert.equal(compatibleVideoSize('21:9','720p'),'1680x720');assert.equal(compatibleVideoSize('3:4','720p'),'720x960');
  assert.throws(()=>compatibleVideoSize('9:16','4k'),{code:'UNSUPPORTED_CAPABILITY'});
  const image={mimeType:'image/png',base64:Buffer.from('PNGBYTES').toString('base64'),role:'first_frame'};
  const sdk=createCompatibleVideoSdkClient({api:BASE,model:'sora-2',send:async(endpoint,{raw})=>{
    assert.equal(endpoint,'/videos');assert.ok(raw);
    const form=await new Response(Buffer.from(raw.bytes),{headers:{'content-type':raw.contentType}}).formData();
    assert.deepEqual([...form.keys()],['model','prompt','seconds','size','input_reference']);
    assert.deepEqual(['model','prompt','seconds','size'].map(key=>form.get(key)),['sora-2','Slow dolly','4','720x1280']);
    const file=form.get('input_reference');assert.ok(file instanceof File);assert.equal(file.name,'reference.png');assert.equal(file.type,'image/png');assert.equal(Buffer.from(await file.arrayBuffer()).toString(),'PNGBYTES');
    return {id:'task-123'};
  }});
  assert.deepEqual(await sdk.submit({prompt:'Slow dolly',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p'},images:[image],subjectReference:false}),{id:'task-123'});
});

async function settingsFixture(t:{after(fn:()=>unknown):void}){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-compatible-')));
  const options={directory:path.join(root,'video-settings'),privateRoot:root};
  let settings=await createVideoSettings(options);
  t.after(async()=>{await settings.close();await rm(root,{recursive:true,force:true});});
  return {options,get settings(){return settings;},async reopen(){await settings.close();settings=await createVideoSettings(options);return settings;}};
}

test('a compatible key is bound to its exact base URL; moving the service requires a new key',async t=>{
  const f=await settingsFixture(t),config=configuration();
  await f.settings.put({action:'save',expectedRevision:0,configuration:config,secret:{action:'replace',value:KEY,storage:'session'}});
  const binding=f.settings.select(config.id,1,config.models[0]!.id);
  assert.equal(binding.endpoint,BASE);assert.equal(await f.settings.acquire(binding),KEY);
  const moved={...config,baseUrl:'https://other.example.net/v1'};
  await assert.rejects(f.settings.put({action:'save',expectedRevision:1,configuration:moved,secret:{action:'keep'}}),{code:'VIDEO_SETTINGS_CONFLICT'});
  const saved=await f.settings.put({action:'save',expectedRevision:1,configuration:moved,secret:{action:'replace',value:'synthetic-second-key',storage:'session'}});
  const view=saved.connections.find(item=>item.configuration.id===config.id)!;
  assert.equal(view.configuration.baseUrl,'https://other.example.net/v1');
  assert.deepEqual(view.credentials.map(item=>item.endpoint).sort(),[BASE,'https://other.example.net/v1'].sort());
  const next=f.settings.select(config.id,2,config.models[0]!.id);
  assert.equal(next.endpoint,'https://other.example.net/v1');assert.equal(await f.settings.acquire(next),'synthetic-second-key');
  assert.doesNotMatch(JSON.stringify(saved),/synthetic-/);
  const reopened=await f.reopen();
  assert.equal((await reopened.get()).connections[0]!.configuration.baseUrl,'https://other.example.net/v1');
});

async function runtimeFixture(t:{after(fn:()=>unknown):void}){
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-compatible-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const model=defaultVideoModels('compatible')[0]!;
  const binding:VideoExecutionBinding={version:1,connectionId:randomUUID(),configurationRevision:1,providerId:'compatible',region:'custom',workspaceId:'',endpoint:BASE,credentialRef:randomUUID(),model,outputHosts:['cdn.example.com']};
  const bytes=png(),file=path.join(root,'frame.png');await writeFile(file,bytes);
  const asset={id:randomUUID(),path:file,mimeType:'image/png',sizeBytes:bytes.length,width:360,height:640,sha256:createHash('sha256').update(bytes).digest('hex'),role:'first_frame'};
  const calls:Array<{url:string;init:RequestInit}>=[],queue:Array<Response|Error>=[];let time=Date.UTC(2026,9,23);
  const provider=createConfiguredVideoProvider({root,binding,now:()=>time,acquireCredential:async()=>KEY,fetchImpl:async(input,init)=>{calls.push({url:String(input),init:init??{}});const next=queue.shift();if(next instanceof Error)throw next;if(!next)throw Error('Real HTTP forbidden');return next;}});
  const snapshot={providerId:'compatible',model:model.modelId,prompt:'Synthetic shapes move slowly.',aspectRatio:'9:16',duration:4,parameters:{resolution:'720p'} as Record<string,unknown>,referenceAssets:[] as unknown[]};
  return {root,binding,provider,asset,bytes,snapshot,calls,queue,advance:()=>{time+=20000;}};
}
const headerOf=(init:RequestInit,name:string)=>new Headers(init.headers).get(name);

test('submission is OpenAI-shaped multipart to the bound origin with the bound key',async t=>{
  const f=await runtimeFixture(t);
  f.queue.push(json({id:'video_123',object:'video',status:'queued',progress:0}));
  assert.deepEqual(await f.provider.submit(f.snapshot,{requestId:'stable-request-1'}),{providerJobId:'video_123'});
  const call=f.calls[0]!,body=Buffer.from(call.init.body as Uint8Array).toString('utf8');
  assert.equal(call.url,`${BASE}/videos`);assert.equal(call.init.method,'POST');assert.equal(call.init.redirect,'error');
  assert.equal(headerOf(call.init,'authorization'),`Bearer ${KEY}`);assert.match(String(headerOf(call.init,'content-type')),/^multipart\/form-data; boundary=[A-Za-z0-9_-]{16,70}$/);
  for(const [name,value] of [['model','sora-2'],['prompt','Synthetic shapes move slowly.'],['seconds','4'],['size','720x1280']])assert.ok(body.includes(`name="${name}"\r\n\r\n${value}\r\n`),name);
  assert.equal(body.includes('input_reference'),false);

  f.snapshot.referenceAssets=[f.asset];f.queue.push(json({id:'video_456',status:'queued'}));
  await f.provider.submit(f.snapshot,{requestId:'stable-request-2'});
  const image=Buffer.from(f.calls[1]!.init.body as Uint8Array);
  assert.ok(image.includes(Buffer.from('name="input_reference"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n')));assert.ok(image.includes(f.bytes));
});

test('status mapping, authenticated /content download and redirect hosts follow the frozen binding',async t=>{
  const f=await runtimeFixture(t);
  f.queue.push(json({id:'video_123',status:'in_progress',progress:42}));
  assert.deepEqual(await f.provider.poll('video_123',{}),{status:'running',progress:0.42});
  f.advance();f.queue.push(json({id:'video_123',status:'completed',progress:100}),new Response(mp4));
  const destination=path.join(f.root,'result.mp4');await f.provider.download('video_123',destination,{});
  assert.deepEqual(await readFile(destination),mp4);
  const content=f.calls[2]!;assert.equal(content.url,`${BASE}/videos/video_123/content`);assert.equal(headerOf(content.init,'authorization'),`Bearer ${KEY}`);assert.equal(content.init.redirect,'manual');

  f.advance();f.queue.push(json({id:'video_123',status:'completed'}),new Response(null,{status:302,headers:{location:'https://cdn.example.com/signed.mp4'}}),new Response(mp4));
  await f.provider.download('video_123',path.join(f.root,'second.mp4'),{});
  const cdn=f.calls[5]!;assert.equal(cdn.url,'https://cdn.example.com/signed.mp4');assert.equal(headerOf(cdn.init,'authorization'),null);

  f.advance();f.queue.push(json({id:'video_123',status:'completed'}),new Response(null,{status:302,headers:{location:'https://elsewhere.example.org/x.mp4'}}));
  await assert.rejects(f.provider.download('video_123',path.join(f.root,'third.mp4'),{}),{code:'UNAPPROVED_OUTPUT_HOST'});
  f.advance();f.queue.push(json({id:'video_123',status:'failed'}));assert.equal((await f.provider.poll('video_123',{})).status,'failed');
  f.advance();f.queue.push(json({id:'video_999',status:'completed'}));await assert.rejects(f.provider.poll('video_123',{}),{code:'INVALID_PROVIDER_RESPONSE'});
});

test('a provably unsent POST fails plainly; an ambiguous one stays unknown',async t=>{
  const f=await runtimeFixture(t);
  f.queue.push(Object.assign(Error('denied'),{code:'VIDEO_NETWORK_DENIED',notDispatched:true}));
  await assert.rejects(f.provider.submit(f.snapshot,{requestId:'r1'}),(error:unknown)=>{const value=error as Record<string,unknown>;assert.equal(value.code,'PROVIDER_NETWORK_DENIED');assert.equal(value.uncertain,undefined);return true;});
  f.queue.push(Object.assign(Error('dns'),{code:'VIDEO_NETWORK_UNREACHABLE',notDispatched:true}));
  await assert.rejects(f.provider.submit(f.snapshot,{requestId:'r2'}),{code:'PROVIDER_UNREACHABLE'});
  f.queue.push(Error('socket hang up after write'));
  await assert.rejects(f.provider.submit(f.snapshot,{requestId:'r3'}),(error:unknown)=>{const value=error as Record<string,unknown>;assert.equal(value.code,'SUBMISSION_UNKNOWN');assert.equal(value.uncertain,true);return true;});
});

// ---- Pinned transport, with inert DNS/HTTPS fakes ----
class FakeSocket extends EventEmitter {remoteAddress:string;remotePort:number;authorized:boolean;constructor(remoteAddress:string,remotePort=443,authorized=true){super();this.remoteAddress=remoteAddress;this.remotePort=remotePort;this.authorized=authorized;} destroy(){this.emit('close');}}
function fakeNetwork({answers=[{address:'93.184.216.34',family:4}] as unknown[],peer='93.184.216.34',authorized=true,status=200,headers={'content-type':'application/json'} as Record<string,string>,responseBody='{"ok":true}'}={}){
  const lookups:string[]=[],requests:Array<{options:Record<string,unknown>;written:Buffer|undefined;ended:boolean;pinned?:unknown}>=[];
  const lookup=async(hostname:string)=>{lookups.push(hostname);return answers;};
  const httpsRequest=((options:Record<string,unknown>,callback:(incoming:unknown)=>void)=>{
    const record={options,written:undefined as Buffer|undefined,ended:false,pinned:undefined as unknown};requests.push(record);
    // Node resolves through the supplied lookup while connecting; capture what it would dial.
    (options.lookup as (host:string,options:unknown,callback:(...args:unknown[])=>void)=>void)('anything.example',{all:true},(error,addresses)=>{record.pinned={error,addresses};});
    const request=Object.assign(new EventEmitter(),{
      end(body?:Buffer){record.ended=true;record.written=body;setImmediate(()=>callback(Object.assign(Readable.from([Buffer.from(responseBody)]),{statusCode:status,statusMessage:'OK',headers})));},
      destroy(){request.emit('close');},
    });
    setImmediate(()=>{const socket=new FakeSocket(peer,443,authorized);request.emit('socket',socket);setImmediate(()=>socket.emit('secureConnect'));});
    return request;
  }) as unknown as typeof import('node:https').request;
  return {lookup,httpsRequest,lookups,requests};
}
const undispatched=(code:string)=>(error:unknown)=>{assert.equal((error as {code?:string}).code,code);assert.equal(isUndispatchedVideoNetworkFailure(error),true);return true;};

test('the pinned transport refuses private answers, IP literals and plain http before any request',async()=>{
  for(const answers of [[{address:'10.0.0.5',family:4}],[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],[{address:'::1',family:6}],[]]){
    const net=fakeNetwork({answers});await assert.rejects(createPinnedVideoFetch(net)(`${BASE}/videos`,{method:'POST',body:'x'}),undispatched('VIDEO_NETWORK_DENIED'));assert.equal(net.requests.length,0);
  }
  for(const url of ['https://93.184.216.34/v1/videos','http://api.example.com/v1/videos','https://user:pass@api.example.com/v1','https://api.example.com:8443/v1']){
    const net=fakeNetwork();await assert.rejects(createPinnedVideoFetch(net)(url),undispatched('VIDEO_NETWORK_DENIED'));assert.equal(net.lookups.length+net.requests.length,0);
  }
});

test('the pinned transport connects to the checked address and writes only after the pinned TLS peer is confirmed',async()=>{
  const net=fakeNetwork();const response=await createPinnedVideoFetch(net)(`${BASE}/videos?limit=1`,{method:'POST',headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},body:'{"a":1}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  const sent=net.requests[0]!;assert.equal(sent.ended,true);assert.equal(String(sent.written),'{"a":1}');
  const options=sent.options as Record<string,unknown>&{headers:Record<string,string>};
  assert.deepEqual([options.hostname,options.servername,options.port,options.path,options.method,options.agent,options.family],['api.example.com','api.example.com',443,'/v1/videos?limit=1','POST',false,4]);
  assert.equal(options.headers.authorization,`Bearer ${KEY}`);assert.equal(options.headers['content-length'],'7');assert.equal(options.headers.connection,'close');
  assert.deepEqual(sent.pinned,{error:null,addresses:[{address:'93.184.216.34',family:4}]});

  for(const peer of [{peer:'1.2.3.4'},{authorized:false}]){
    const bad=fakeNetwork(peer);await assert.rejects(createPinnedVideoFetch(bad)(`${BASE}/videos`,{method:'POST',body:'secret'}),undispatched('VIDEO_NETWORK_DENIED'));assert.equal(bad.requests[0]!.ended,false);
  }
});

test('redirects are returned only when asked for, and an early abort proves nothing was sent',async()=>{
  const redirect=fakeNetwork({status:302,headers:{location:'https://cdn.example.com/x.mp4'},responseBody:''});
  await assert.rejects(createPinnedVideoFetch(redirect)(`${BASE}/videos/v/content`),(error:unknown)=>{assert.equal(isUndispatchedVideoNetworkFailure(error),false);return true;});
  const manual=await createPinnedVideoFetch(fakeNetwork({status:302,headers:{location:'https://cdn.example.com/x.mp4'},responseBody:''}))(`${BASE}/videos/v/content`,{redirect:'manual'});
  assert.equal(manual.status,302);assert.equal(manual.headers.get('location'),'https://cdn.example.com/x.mp4');
  const controller=new AbortController();controller.abort();
  await assert.rejects(createPinnedVideoFetch(fakeNetwork())(`${BASE}/videos`,{method:'POST',body:'x',signal:controller.signal}),undispatched('VIDEO_NETWORK_ABORTED'));
});

test('test connection reads /models with the key and maps only the outcome',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[];
  const respond=(next:Response|Error)=>(async(input:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(input),init:init??{}});if(next instanceof Error)throw next;return next;}) as typeof fetch;
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(json({data:[]}))}),{result:'ok'});
  assert.equal(calls[0]!.url,`${BASE}/models`);assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.redirect,'error');assert.equal(new Headers(calls[0]!.init.headers).get('authorization'),`Bearer ${KEY}`);
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(json({error:'PRIVATE provider text'},401))}),{result:'unauthorized',httpStatus:401});
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(json({},404))}),{result:'unsupported',httpStatus:404});
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(json({},502))}),{result:'http_error',httpStatus:502});
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(Object.assign(Error('x'),{code:'VIDEO_NETWORK_DENIED',notDispatched:true}))}),{result:'denied'});
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:BASE,apiKey:KEY,fetchImpl:respond(Error('timeout'))}),{result:'unreachable'});
  await assert.rejects(checkCompatibleVideoService({baseUrl:'http://api.example.com',apiKey:KEY,fetchImpl:respond(json({}))}),{code:'VIDEO_SETTINGS_VALIDATION'});
});

test('the check route sends a draft key only to the normalized draft origin and a saved key only to its own origin',async t=>{
  const f=await settingsFixture(t),config=configuration(),official={...configuration(),providerId:'minimax' as const,region:'global',models:defaultVideoModels('minimax')};delete (official as {baseUrl?:string}).baseUrl;
  await f.settings.put({action:'save',expectedRevision:0,configuration:config,secret:{action:'replace',value:KEY,storage:'session'}});
  await f.settings.put({action:'save',expectedRevision:1,configuration:official,secret:{action:'replace',value:'synthetic-official',storage:'session'}});
  const calls:string[]=[],keys:Array<string|null>=[];
  const handler=createVideoHttp({settings:f.settings,checkFetch:(async(input:string|URL|Request,init?:RequestInit)=>{calls.push(String(input));keys.push(new Headers(init?.headers).get('authorization'));return json({},401);}) as typeof fetch});
  const post=async(input:unknown,method='POST')=>{const req=Readable.from([Buffer.from(JSON.stringify(input))]) as unknown as import('node:http').IncomingMessage;req.url='/api/video-providers/compatible-check';req.method=method;req.headers={'content-type':'application/json'};let status=0,body='';const res={setHeader(){},writeHead:(code:number)=>{status=code;},end:(value:string)=>{body=value;},destroy:()=>assert.fail('destroyed')} as unknown as import('node:http').ServerResponse;await handler(req,res,new URL('/api/video-providers/compatible-check','http://localhost'));return {status,data:JSON.parse(body)};};
  const draft=await post({source:'draft',baseUrl:'https://Draft.Example.com/api/',value:'synthetic-draft-key'});
  assert.equal(draft.status,200);assert.deepEqual(draft.data,{ok:true,data:{result:'unauthorized',httpStatus:401}});
  assert.deepEqual([calls[0],keys[0]],['https://draft.example.com/api/models','Bearer synthetic-draft-key']);
  const saved=await post({source:'saved',connectionId:config.id,configurationRevision:1});
  assert.equal(saved.status,200);assert.deepEqual([calls[1],keys[1]],[`${BASE}/models`,`Bearer ${KEY}`]);
  assert.equal((await post({source:'saved',connectionId:config.id,configurationRevision:2})).data.error.code,'VIDEO_SETTINGS_CONFLICT');
  assert.equal((await post({source:'saved',connectionId:official.id,configurationRevision:1})).data.error.code,'VIDEO_SETTINGS_VALIDATION');
  assert.equal((await post({source:'draft',baseUrl:'http://insecure.example.com',value:'k'})).status,400);
  assert.equal((await post({source:'draft',baseUrl:BASE,value:'k',extra:true})).status,400);
  assert.equal((await post({source:'draft',baseUrl:BASE,value:'k'},'GET')).status,405);
  assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify([draft,saved]),/synthetic-/);
});

test('the web client accepts only the closed check result shape',()=>{
  assert.deepEqual(safeCompatibleCheck({result:'ok'}),{result:'ok'});
  assert.deepEqual(safeCompatibleCheck({result:'unauthorized',httpStatus:403}),{result:'unauthorized',httpStatus:403});
  for(const value of [{result:'ok',message:'echo'},{result:'other'},{result:'http_error',httpStatus:99},null,'ok'])assert.throws(()=>safeCompatibleCheck(value),{code:'INVALID_RESPONSE'});
});

test('a compatible connection runs end to end: one multipart POST, status, /content download, one decoded version',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-compatible-e2e-'))),video=path.join(root,'fixture.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=teal:s=360x640:r=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',video]);
  const bytes=await readFile(video),store=openStore(root),settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root});
  const calls:Array<{url:string;method:string;authorization:string|null;body?:string}>=[];
  const videoFetch=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',authorization=new Headers(init?.headers).get('authorization');
    calls.push({url,method,authorization,...(init?.body instanceof Uint8Array?{body:Buffer.from(init.body).toString('latin1')}:{})});
    if(method==='POST'&&url===`${BASE}/videos`)return json({id:'video_e2e',object:'video',status:'queued',progress:0});
    if(url===`${BASE}/videos/video_e2e`)return json({id:'video_e2e',status:'completed',progress:100});
    if(url===`${BASE}/videos/video_e2e/content`)return new Response(null,{status:302,headers:{location:'https://cdn.example.com/signed/e2e.mp4'}});
    if(url==='https://cdn.example.com/signed/e2e.mp4')return new Response(bytes,{headers:{'content-type':'video/mp4'}});
    throw Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const providers=createProviderRegistry({db:store.db,root,env:{}});
  const services=createServices(store,providers,{videoSettings:settings,videoFetch,profileNow:()=>Date.UTC(2026,9,23)});
  let worker:ReturnType<typeof startWorker>|null=null;
  t.after(async()=>{await worker?.stop();await services.drain();await settings.close();store.close();await rm(root,{recursive:true,force:true});});
  await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
  const config=configuration({outputHosts:['cdn.example.com']});
  await settings.put({action:'save',expectedRevision:0,configuration:config,secret:{action:'replace',value:KEY,storage:'session'}});
  const project=await services.call('project.create',{name:'Compatible integration'}) as ServiceRow;
  const shot=await services.call('shot.create',{projectId:project.id,title:'Compatible shot',prompt:'Synthetic shapes move.',aspectRatio:'9:16',duration:4,referenceAssetIds:[]}) as ServiceRow;
  const job=await services.call('generation.submit',{shotId:String(shot.id),expectedRevision:Number(shot.revision),requestId:randomUUID(),providerId:'compatible',model:'sora-2',connectionId:config.id,configurationRevision:1,modelEntryId:config.models[0]!.id}) as JobRecord;
  // tick() starts the due work; stop() waits for it, as in the official-provider tests.
  for(let i=0;i<6&&(store.get('jobs',job.id) as JobRecord).status!=='succeeded';i++){services.saveJob(store.get('jobs',job.id) as JobRecord,{nextPollAt:0});worker=startWorker(store,services,providers);await worker.tick();await worker.stop();worker=null;}
  const done=store.get('jobs',job.id) as JobRecord;
  assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(done.providerJobId,'video_e2e');
  assert.equal(store.list('versions').length,1);const version=store.list('versions')[0] as ServiceRow;assert.equal(version.jobId,job.id);
  assert.equal((store.get('shots',String(shot.id)) as ServiceRow).selectedVersionId,version.id);
  const posts=calls.filter(call=>call.method==='POST');assert.equal(posts.length,1);
  assert.equal(posts[0]!.authorization,`Bearer ${KEY}`);assert.ok(posts[0]!.body!.includes('name="size"\r\n\r\n720x1280'));assert.ok(posts[0]!.body!.includes('name="seconds"\r\n\r\n4'));
  assert.equal(calls.find(call=>call.url.endsWith('/content'))!.authorization,`Bearer ${KEY}`);
  assert.equal(calls.find(call=>call.url.startsWith('https://cdn.example.com/'))!.authorization,null);
  assert.equal(calls.every(call=>call.url.startsWith(BASE)||call.url.startsWith('https://cdn.example.com/')),true);
});
