import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import {isPublicAgentAddress, resolveAgentDestination, assertPinnedAgentSocket, createAgentTransport, wasAgentTransportSubmissionPrevented} from '../packages/business/src/agent/network-policy.ts';
import {AGENT_HTTP_DIAGNOSTIC_MAX_BYTES, agentChatHttpError, agentChatHttpStatus, safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
const configuration = {...DEFAULT_AGENT_CONFIGURATION};
const publicAnswers = async () => [{address: '8.8.8.8', family: 4}];
function injectedRequest({peer = '8.8.8.8', authorized = true, status = 200, headers = {'content-type': 'text/event-stream'}, beforeConnect, body = 'data: [DONE]\n\n', responseStream} = {}) {
  const state = {calls: 0, ends: 0, destroyed: false};
  state.request = (options, callback) => {
    state.calls++; state.options = options;
    const request = new EventEmitter();
    request.setTimeout = (_milliseconds, handler) => { state.timeout = handler; };
    request.destroy = () => { state.destroyed = true; };
    request.end = payload => { state.ends++; state.payload = payload; const response = responseStream ?? Readable.from([Buffer.from(body)]); response.statusCode = status; response.headers = headers; state.response = response; callback(response); };
    queueMicrotask(() => {
      const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: peer, remotePort: 443, authorized, destroy() {state.destroyed = true;}});
      request.emit('socket', socket); beforeConnect?.(state); socket.emit('secureConnect');
    });
    return request;
  };
  return state;
}
const openArgs = {configuration, apiKey: 'synthetic-key-marker', body: '{}'};

test('HTTP rejection exposes only the trusted status and preserves the sent boundary', async () => {
  for (const status of [301, 401, 403, 404, 429, 503]) {
    const headers = {'x-provider-secret': 'synthetic-header-marker'};
    Object.defineProperty(headers, 'content-type', {get() { assert.fail('HTTP rejection must not inspect response headers'); }});
    const fixture = injectedRequest({status, body: 'synthetic-provider-body-marker', headers});
    let failure;
    await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(openArgs), error => { failure = error; return error.code === 'AGENT_CHAT_HTTP_ERROR'; });
    const safe = safeAgentChatError(failure);
    assert.deepEqual(safe, {code:'AGENT_CHAT_HTTP_ERROR',status:502,message:`模型服务拒绝了请求（HTTP ${status}），请检查账户、模型和配置后手动重试。`});
    assert.equal(agentChatHttpStatus(failure), status);
    assert.equal(fixture.ends, 1);
    assert.equal(wasAgentTransportSubmissionPrevented(failure), false);
    assert.equal(fixture.response.readableDidRead, false);
    assert.equal(JSON.stringify(safe).includes('marker'), false);
  }
});

test('HTTP status evidence accepts only integer non-success statuses without coercion', () => {
  for (let status = 100; status <= 599; status++) {
    const failure = agentChatHttpError(status);
    assert.equal(agentChatHttpStatus(failure), status < 200 || status >= 300 ? status : undefined);
    assert.equal(safeAgentChatError(failure).status, 502);
  }
  for (const status of [undefined, null, false, '401', 99, 600, 401.5, NaN, Infinity, -Infinity, {valueOf() {assert.fail('status must not be coerced');}}]) {
    const failure = agentChatHttpError(status);
    assert.equal(agentChatHttpStatus(failure), undefined);
    assert.equal(safeAgentChatError(failure).message, '模型服务拒绝了请求，请检查账户、模型和配置后手动重试。');
  }
});

test('HTTP diagnostic evidence cannot be forged, copied or obtained from causes', () => {
  const failure = agentChatHttpError(401);
  Object.assign(failure, {status:599,httpStatus:599,message:'synthetic-key-marker'});
  assert.equal(agentChatHttpStatus(failure), 401);
  assert.deepEqual(safeAgentChatError(failure), {code:'AGENT_CHAT_HTTP_ERROR',status:502,message:'模型服务拒绝了请求（HTTP 401），请检查账户、模型和配置后手动重试。'});
  const forged = {code:'AGENT_CHAT_HTTP_ERROR',message:'synthetic-key-marker'};
  for (const property of ['status','httpStatus','body','headers','url','cause','response']) Object.defineProperty(forged, property, {get() {assert.fail(`must not inspect ${property}`);}});
  for (const value of [forged, {...failure}, Object.create(failure), Object.assign(Error('synthetic-key-marker'), {code:'AGENT_CHAT_HTTP_ERROR',cause:failure}), JSON.parse(JSON.stringify(failure)), null, 401]) {
    assert.equal(agentChatHttpStatus(value), undefined);
    assert.equal(safeAgentChatError(value).message.includes('HTTP 401'), false);
    assert.equal(JSON.stringify(safeAgentChatError(value)).includes('marker'), false);
  }
});

const schemaDiagnostic = JSON.stringify({error:{code:'invalid_request_error',type:'invalid_request_error',param:'tools[7].function.parameters',message:'Invalid schema: properties requires required and additionalProperties. synthetic-key-marker https://private.invalid/secret'},debug:'synthetic-body-marker'});
const schemaHint = '服务返回的参数提示：请求格式、工具参数结构；字段 tools、function、parameters、properties、required、additionalProperties；工具索引 7。';

test('HTTP400 parameter hints retain only fixed enums and bounded tool indices', () => {
  const failure = agentChatHttpError(400, Buffer.from(schemaDiagnostic));
  assert.equal(safeAgentChatError(failure).message, `模型服务拒绝了请求（HTTP 400），请检查账户、模型和配置后手动重试。 ${schemaHint}`);
  assert.deepEqual(JSON.parse(JSON.stringify(failure)), {code:'AGENT_CHAT_HTTP_ERROR',status:502});
  for (const marker of ['synthetic','private.invalid','secret','debug']) assert.equal(safeAgentChatError(failure).message.includes(marker), false);
  const indices = agentChatHttpError(400, Buffer.from(JSON.stringify({error:{type:'invalid_request_error',param:'tools[0] tools[127] tools[128] tools[1000] tools[001] tools.3'}})));
  assert.equal(safeAgentChatError(indices).message.endsWith('工具索引 0、127、3。'), true);
  for (const copy of [{...failure},Object.create(failure),Object.assign(Error('synthetic-marker'),{code:'AGENT_CHAT_HTTP_ERROR',cause:failure})]) assert.equal(safeAgentChatError(copy).message.includes('参数提示'), false);
  for (const status of [301,401,422,500]) assert.equal(safeAgentChatError(agentChatHttpError(status,Buffer.from(schemaDiagnostic))).message.includes('参数提示'), false);
});

test('HTTP400 hint classification rejects oversized, malformed UTF8, unknown and empty diagnostics', () => {
  const bytes = Buffer.from(schemaDiagnostic);
  const exact = Buffer.concat([bytes,Buffer.alloc(AGENT_HTTP_DIAGNOSTIC_MAX_BYTES-bytes.length,32)]);
  assert.equal(safeAgentChatError(agentChatHttpError(400,exact)).message.endsWith(schemaHint), true);
  for (const body of [Buffer.concat([exact,Buffer.from(' ')]),Buffer.concat([bytes,Buffer.from([255])]),Buffer.from('{'),Buffer.from(''),Buffer.from('null'),Buffer.from('{}'),Buffer.from('{"error":[]}'),Buffer.from('{"error":{"message":"synthetic-key-marker","code":"unknown","param":"tools[7]"}}')]) {
    assert.equal(safeAgentChatError(agentChatHttpError(400,body)).message.includes('参数提示'), false);
  }
});

test('HTTP400 transport classifies a bounded body without inspecting headers or changing dispatch evidence', async () => {
  const headers = {}; Object.defineProperty(headers,'content-type',{get(){assert.fail('HTTP400 diagnosis must not inspect headers');}});
  const fixture = injectedRequest({status:400,headers,body:schemaDiagnostic});let failure;
  await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(openArgs),error=>{failure=error;return error.code==='AGENT_CHAT_HTTP_ERROR';});
  assert.equal(safeAgentChatError(failure).message.endsWith(schemaHint), true);
  assert.equal(fixture.response.readableDidRead, true);assert.equal(fixture.ends,1);assert.equal(wasAgentTransportSubmissionPrevented(failure),false);
});

test('HTTP400 empty, oversized, malformed and broken bodies keep only the safe HTTP failure', async () => {
  const broken = Readable.from((async function*(){yield Buffer.from('{"error":');throw Error('synthetic-stream-secret-marker');})());
  for (const options of [{body:''},{body:'not JSON synthetic-key-marker'},{responseStream:Readable.from([Buffer.alloc(AGENT_HTTP_DIAGNOSTIC_MAX_BYTES+1,120)])},{responseStream:broken}]) {
    const fixture=injectedRequest({status:400,...options});let failure;
    await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(openArgs),error=>{failure=error;return error.code==='AGENT_CHAT_HTTP_ERROR';});
    assert.equal(safeAgentChatError(failure).message,'模型服务拒绝了请求（HTTP 400），请检查账户、模型和配置后手动重试。');
    assert.equal(fixture.ends,1);assert.equal(wasAgentTransportSubmissionPrevented(failure),false);
  }
});

test('HTTP400 body diagnosis remains cancellable and bounded by existing total timeout', async () => {
  for (const abort of [true,false]) {
    const controller=new AbortController(),fixture=injectedRequest({status:400,responseStream:new Readable({read(){}})});
    const pending=createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request,limits:{totalTimeoutMs:30}})({...openArgs,signal:controller.signal});
    await delay(0);assert.equal(fixture.ends,1);if(abort)controller.abort('synthetic-abort-marker');
    let failure;await assert.rejects(pending,error=>{failure=error;return error.code===(abort?'AGENT_CHAT_ABORTED':'AGENT_CHAT_TIMEOUT');});
    assert.equal(fixture.response.destroyed,true);assert.equal(agentChatHttpStatus(failure),undefined);assert.equal(wasAgentTransportSubmissionPrevented(failure),false);
    assert.equal(JSON.stringify(safeAgentChatError(failure)).includes('marker'),false);
  }
});

test('public IP gate denies private, metadata, reserved, documentation and IPv6 transition forms', () => {
  for (const address of ['0.1.2.3','10.1.2.3','100.64.0.1','100.127.255.255','127.0.0.1','169.254.169.254','168.63.129.16','172.16.0.1','172.31.255.255','192.0.0.9','192.0.2.1','192.88.99.1','192.168.1.1','198.18.0.1','198.19.255.255','198.51.100.4','203.0.113.8','224.1.2.3','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','::ffff:0808:0808','::8.8.8.8','64:ff9b::808:808','100::1','fc00::1','fd00:ec2::254','fe80::1','fe80::1%eth0','ff02::1','2001::1','2001:2::1','2001:20::1','2001:db8::1','2002:0808:0808::','3fff::1','not-an-ip']) assert.equal(isPublicAgentAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','100.128.0.1','172.32.0.1','192.1.2.3','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicAgentAddress(address), true, address);
});

test('DNS validates every answer, exact family, count and syntax; never picks around a bad answer', async () => {
  for (const answers of [[], [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}], [{address:'8.8.8.8',family:6}], [{address:'::ffff:8.8.8.8',family:6}], Array(65).fill({address:'8.8.8.8',family:4})]) await assert.rejects(resolveAgentDestination(configuration, {lookup: async () => answers}), {code:'AGENT_CHAT_NETWORK_DENIED'});
  const destination = await resolveAgentDestination(configuration, {lookup: async (hostname, options) => { assert.equal(hostname,'api.openai.com'); assert.deepEqual(options,{all:true,verbatim:true}); return [{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]; }});
  assert.equal(destination.address,'8.8.8.8'); assert.equal(destination.path,'/v1/chat/completions');
  await assert.rejects(resolveAgentDestination({...configuration, baseUrl:'https://127.0.0.1/v1'}, {lookup: () => assert.fail('no DNS for rejected syntax')}), {code:'AGENT_CHAT_NETWORK_DENIED'});
});

test('Ollama alone allows fixed loopback route and requires a known different self port', async () => {
  const local = {protocol:'chat_completions',presetId:'ollama', platformId:'local', baseUrl:'http://localhost:11434/v1', model:'qwen3:8b'};
  assert.equal((await resolveAgentDestination(local,{selfPort:4318,lookup:() => assert.fail('localhost never uses DNS')})).address,'127.0.0.1');
  for (const selfPort of [undefined,11434,0,'4318',65536]) await assert.rejects(resolveAgentDestination(local,{selfPort}),{code:'AGENT_CHAT_NETWORK_DENIED'});
  for (const baseUrl of ['http://127.0.0.2:11434/v1','http://localhost:11434/api','http://10.0.0.1:11434/v1']) await assert.rejects(resolveAgentDestination({...local,baseUrl},{selfPort:4318}),{code:'AGENT_CHAT_NETWORK_DENIED'});
});

test('transport pins the approved address and authenticates TLS before sending any body/key', async () => {
  let lookups = 0;
  const fixture = injectedRequest({beforeConnect:state => assert.equal(state.ends,0)});
  const stream = await createAgentTransport({lookup:async () => {lookups++; return publicAnswers();},httpsRequest:fixture.request})(openArgs);
  assert.equal(lookups,1); assert.equal(fixture.ends,1); assert.equal(fixture.options.agent,false); assert.equal(fixture.options.autoSelectFamily,false);
  assert.equal(fixture.options.hostname,'api.openai.com'); assert.equal(fixture.options.servername,'api.openai.com'); assert.equal(fixture.options.rejectUnauthorized,true);
  assert.equal(fixture.options.headers.Authorization,'Bearer synthetic-key-marker'); assert.equal(fixture.options.headers.Cookie,undefined); assert.equal(fixture.options.headers['Accept-Encoding'],'identity');
  assert.deepEqual(await new Promise((resolve,reject) => fixture.options.lookup('rebind.example.com',{all:true},(error,result) => error ? reject(error) : resolve(result))),[{address:'8.8.8.8',family:4}]);
  assert.deepEqual(await new Promise((resolve,reject) => fixture.options.lookup('rebind.example.com',{},(error,address,family) => error ? reject(error) : resolve([address,family]))),['8.8.8.8',4]);
  assert.ok(fixture.options.checkServerIdentity('ignored',{subjectaltname:'DNS:wrong.example.com',subject:{CN:'wrong.example.com'}}) instanceof Error);
  stream.close(); assert.equal(fixture.destroyed,true);
});

test('mismatched peer, port or untrusted TLS fails before request.end; equivalent mapped peer is exact-pinned only', async () => {
  for (const options of [{peer:'127.0.0.1'},{peer:'1.1.1.1'},{authorized:false}]) {
    const fixture = injectedRequest(options);
    await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(openArgs),error => ['AGENT_CHAT_NETWORK_DENIED','AGENT_CHAT_CONNECT_FAILED'].includes(error.code));
    assert.equal(fixture.ends,0);
  }
  assert.doesNotThrow(() => assertPinnedAgentSocket({remoteAddress:'::ffff:8.8.8.8',remotePort:443,authorized:true},{address:'8.8.8.8',port:443,secure:true}));
  assert.throws(() => assertPinnedAgentSocket({remoteAddress:'8.8.8.8',remotePort:80,authorized:true},{address:'8.8.8.8',port:443,secure:true}),{code:'AGENT_CHAT_NETWORK_DENIED'});
});

test('redirects, non-SSE and compressed responses are closed once without body/header/error leakage', async () => {
  for (const options of [{status:302,headers:{location:'https://key-marker.example.com'}},{status:401},{headers:{'content-type':'application/json'}},{headers:{'content-type':'text/event-stream','content-encoding':'gzip'}}]) {
    const fixture = injectedRequest(options);
    await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(openArgs),error => !JSON.stringify(safeAgentChatError(error)).includes('marker'));
    assert.equal(fixture.calls,1); assert.equal(fixture.destroyed,true);
  }
});

test('DNS connection timeout and cancellation prevent a resolver completing late from opening a socket', async () => {
  for (const cancellation of [false,true]) {
    let resolveLookup, calls = 0;
    const controller = new AbortController();
    const pending = createAgentTransport({lookup:() => new Promise(resolve => {resolveLookup=resolve;}),httpsRequest:() => {calls++; assert.fail('late socket');},limits:{connectTimeoutMs:20}})({...openArgs,signal:controller.signal});
    if (cancellation) controller.abort('synthetic-key-marker');
    await assert.rejects(pending,{code:cancellation?'AGENT_CHAT_ABORTED':'AGENT_CHAT_TIMEOUT'});
    resolveLookup(await publicAnswers()); await delay(5); assert.equal(calls,0);
  }
});

test('network errors and unknown codes always use fixed safe messages', async () => {
  await assert.rejects(createAgentTransport({lookup:async () => {throw Error('synthetic-key-marker');}})(openArgs),error => error.code==='AGENT_CHAT_CONNECT_FAILED' && !error.message.includes('marker'));
  for (const code of ['__proto__','constructor','toString',undefined]) assert.equal(safeAgentChatError({code,message:'synthetic-key-marker'}).code,'AGENT_CHAT_CONNECT_FAILED');
});

test('abort before DNS and between socket assignment and TLS handshake sends no bytes', async () => {
  const already = new AbortController(); already.abort('synthetic-key-marker');
  let lookups=0;
  await assert.rejects(createAgentTransport({lookup:async()=>{lookups++;return publicAnswers();}})({...openArgs,signal:already.signal}),{code:'AGENT_CHAT_ABORTED'});
  assert.equal(lookups,0);
  const controller = new AbortController();
  const fixture = injectedRequest({beforeConnect:()=>controller.abort('synthetic-key-marker')});
  await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})({...openArgs,signal:controller.signal}),{code:'AGENT_CHAT_ABORTED'});
  assert.equal(fixture.ends,0); assert.equal(fixture.destroyed,true);
});

test('TLS transport errors before secureConnect never transmit the key or body', async () => {
  for (const code of ['CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT']) {
    let ends=0,destroyed=false;
    const requestFactory=() => {
      const request = new EventEmitter(); request.setTimeout=()=>{};request.end=()=>{ends++;};request.destroy=()=>{destroyed=true;};
      queueMicrotask(()=>request.emit('error',Object.assign(Error('synthetic-key-marker'),{code})));
      return request;
    };
    await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:requestFactory})(openArgs),error=>error.code==='AGENT_CHAT_CONNECT_FAILED'&&!error.message.includes('marker'));
    assert.equal(ends,0);assert.equal(destroyed,true);
  }
});

test('abort after response closes both objects and retains the safe terminal reason', async () => {
  const controller = new AbortController(),fixture=injectedRequest();
  const stream=await createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})({...openArgs,signal:controller.signal});
  controller.abort('synthetic-key-marker');
  assert.equal(stream.error().code,'AGENT_CHAT_ABORTED');assert.equal(fixture.response.destroyed,true);assert.equal(fixture.destroyed,true);
  stream.close();
});

test('test overrides can only tighten defaults, never disable or raise network bounds', () => {
  for (const limits of [{connectTimeoutMs:0},{totalTimeoutMs:120001},{maxHeaderBytes:100000},{readTimeoutMs:Infinity},{maxDnsAnswers:1000},{proxy:'http://localhost'}]) assert.throws(()=>createAgentTransport({limits}),{code:'AGENT_CHAT_VALIDATION'});
});

test('Azure platform VIP is denied as a literal, sole DNS answer and mixed public DNS answer', async () => {
  await assert.rejects(resolveAgentDestination({...configuration,baseUrl:'https://168.63.129.16/v1'},{lookup:()=>assert.fail('literal does not resolve')}),{code:'AGENT_CHAT_NETWORK_DENIED'});
  for(const answers of [[{address:'168.63.129.16',family:4}],[{address:'8.8.8.8',family:4},{address:'168.63.129.16',family:4}]]) await assert.rejects(resolveAgentDestination(configuration,{lookup:async()=>answers}),{code:'AGENT_CHAT_NETWORK_DENIED'});
});

test('only validated protocol enum derives either fixed transport suffix, including exact Ollama loopback path', async () => {
  for (const protocol of ['chat_completions','responses']) {
    const expected=protocol==='responses'?'/responses':'/chat/completions';
    assert.equal((await resolveAgentDestination({...configuration,protocol},{lookup:publicAnswers})).path,`/v1${expected}`);
    const local={protocol,presetId:'ollama',platformId:'local',baseUrl:'http://localhost:11434/v1',model:'qwen3:8b'};
    assert.equal((await resolveAgentDestination(local,{selfPort:4318})).path,`/v1${expected}`);
    await assert.rejects(resolveAgentDestination(local,{selfPort:11434}),{code:'AGENT_CHAT_NETWORK_DENIED'});
  }
  for(const protocol of [undefined,'/responses','responses?key=x','responses/../private','constructor','__proto__']) await assert.rejects(resolveAgentDestination({...configuration,protocol},{lookup:()=>assert.fail('no DNS for invalid enum')}),{code:'AGENT_CHAT_NETWORK_DENIED'});
});

test('Responses preserves mixed-DNS denial and TLS/peer verification before secret/body transmission',async()=>{
  const responses={...openArgs,configuration:{...configuration,protocol:'responses'}};
  const denied=injectedRequest();await assert.rejects(createAgentTransport({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],httpsRequest:denied.request})(responses),{code:'AGENT_CHAT_NETWORK_DENIED'});assert.equal(denied.calls,0);
  for(const mismatch of [{peer:'127.0.0.1'},{authorized:false}]){const fixture=injectedRequest(mismatch);await assert.rejects(createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(responses));assert.equal(fixture.ends,0);}
  const fixture=injectedRequest({beforeConnect:state=>assert.equal(state.ends,0)});const stream=await createAgentTransport({lookup:publicAnswers,httpsRequest:fixture.request})(responses);assert.equal(fixture.options.path,'/v1/responses');assert.equal(fixture.ends,1);stream.close();
});

test('Responses cancellation while DNS is pending cannot open a later socket',async()=>{
  let resolveLookup,calls=0;const controller=new AbortController();
  const pending=createAgentTransport({lookup:()=>new Promise(resolve=>{resolveLookup=resolve;}),httpsRequest:()=>{calls++;assert.fail('late socket');}})({...openArgs,configuration:{...configuration,protocol:'responses'},signal:controller.signal});
  controller.abort();await assert.rejects(pending,{code:'AGENT_CHAT_ABORTED'});resolveLookup(await publicAnswers());await delay(5);assert.equal(calls,0);
});
