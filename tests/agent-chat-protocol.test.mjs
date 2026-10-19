import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import {AGENT_CHAT_PROFILES, AGENT_CHAT_LIMITS, buildAgentChatRequest, createChatCompletionGateway, streamChatCompletion} from '../packages/business/src/agent/chat-completions.ts';
const chunk = (delta = {}, finish = null, extra = {}) => ({choices:[{index:0,delta,finish_reason:finish}],...extra});
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const complete = text => frame(chunk({role:'assistant'}))+frame(chunk({content:text}))+frame(chunk({},'stop'))+frame('[DONE]');
const messages = [{role:'user',content:'Synthetic protocol fixture only.'}];
async function collect(iterator) { const events=[]; for await (const event of iterator) events.push(event); return events; }
async function fixture(t, handler, dependencies) {
  const calls=[];
  const server=createServer(async (request,response) => {
    const buffers=[]; for await (const buffer of request) buffers.push(buffer);
    calls.push({path:request.url,method:request.method,headers:request.headers,body:JSON.parse(Buffer.concat(buffers).toString())});
    response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
    await handler(response,request,calls.at(-1));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));});
  const configuration={protocol:'chat_completions',presetId:'ollama',platformId:'local',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'qwen3:8b'};
  return {calls, configuration, run:(options={}) => (dependencies ? createChatCompletionGateway(dependencies) : streamChatCompletion)({configuration,apiKey:null,messages,selfPort:1,...options})};
}

test('named profiles use exact non-thinking controls, bounded token fields and no tool/continuation options', () => {
  for (const preset of AGENT_PRESETS) {
    const platform=preset.platforms[0];
    const configuration={protocol:'chat_completions',presetId:preset.id,platformId:platform.id,baseUrl:platform.baseUrl||'https://fixture.example.com/v1',model:platform.model||'custom-text-model'};
    const result=JSON.parse(buildAgentChatRequest({configuration,apiKey:'synthetic-key',messages,selfPort:4318}).body);
    assert.equal(result.stream,true); assert.equal(result[AGENT_CHAT_PROFILES[preset.id].tokenField],2048);
    for (const field of ['tools','tool_choice','temperature','parallel_tool_calls','response_format','previous_response_id','extra_headers']) assert.equal(result[field],undefined);
    for (const [key,value] of Object.entries(AGENT_CHAT_PROFILES[preset.id].fields)) assert.deepEqual(result[key],value);
    if (preset.id!=='custom') assert.throws(()=>buildAgentChatRequest({configuration:{...configuration,model:'unapproved-thinking-model'},apiKey:'synthetic-key',messages,selfPort:4318}),{code:'AGENT_CHAT_PROFILE_UNSUPPORTED'});
  }
  assert.equal(AGENT_CHAT_PROFILES.openai.fields.store,false);
  assert.equal(AGENT_CHAT_PROFILES.openrouter.fields.provider.allow_fallbacks,false);
});

test('request input validation rejects tools, arbitrary headers, unsafe keys, excess size and malformed Unicode', () => {
  const configuration={protocol:'chat_completions',presetId:'custom',platformId:'custom',baseUrl:'https://fixture.example.com/v1',model:'custom-text-model'};
  const base={configuration,apiKey:'synthetic-key',messages};
  for (const input of [{...base,apiKey:null},{...base,apiKey:'synthetic\nkey'},{...base,apiKey:'密钥'},{...base,messages:[{role:'tool',content:'x'}]},{...base,messages:[{role:'user',content:'x',tool_calls:[]}]},{...base,messages:[{role:'user',content:[{type:'text',text:'x'}]}]},{...base,messages:[{role:'user',content:'\ud800'}]},{...base,messages:Array(65).fill(messages[0])},{...base,configuration:{...configuration,headers:{x:'y'}}}]) assert.throws(()=>buildAgentChatRequest(input),error=>['AGENT_CHAT_KEY_REQUIRED','AGENT_CHAT_VALIDATION'].includes(error.code));
  assert.throws(()=>buildAgentChatRequest({...base,messages:[{role:'user',content:'x'.repeat(AGENT_CHAT_LIMITS.maxInputBytes+1)}]}),{code:'AGENT_CHAT_LIMIT'});
});

test('real local synthetic Ollama-shaped request streams fragmented multilingual UTF-8 without an unconfigured key', async t => {
  const fixtureServer=await fixture(t,async response => {
    const wire=Buffer.from(': keepalive\r\n\r\n'+complete('你好，Mioon 🙂'));
    for (const byte of wire) response.write(Buffer.from([byte]));
    response.end();
  });
  const events=await collect(fixtureServer.run());
  assert.deepEqual(events,[{type:'delta',text:'你好，Mioon 🙂'},{type:'done',finishReason:'stop'}]);
  assert.equal(fixtureServer.calls.length,1);
  assert.equal(fixtureServer.calls[0].path,'/v1/chat/completions'); assert.equal(fixtureServer.calls[0].method,'POST');
  assert.equal(fixtureServer.calls[0].headers.authorization,undefined);
  assert.equal(fixtureServer.calls[0].body.reasoning_effort,'none');
});

test('empty chunks, null content and duplicate terminal/accounting frames dispatch one completion with safe usage', async t => {
  const usage={prompt_tokens:10,completion_tokens:2,total_tokens:12,secret:'synthetic-private-marker',cost:999};
  const source=frame({choices:[],usage:null})+frame(chunk({content:null}))+frame(chunk({content:'ok'}))+frame(chunk({},'stop',{usage}))+frame(chunk({},'stop',{usage}))+frame({choices:[],usage})+frame('[DONE]')+frame('[DONE]');
  const service=await fixture(t,response=>response.end(source));
  assert.deepEqual(await collect(service.run()),[{type:'delta',text:'ok'},{type:'done',finishReason:'stop',usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}]);
});

test('length and content_filter finish reasons remain explicit', async t => {
  for (const reason of ['length','content_filter']) {
    const service=await fixture(t,response=>response.end(frame(chunk({content:'partial'},reason))+frame('[DONE]')));
    assert.equal((await collect(service.run())).at(-1).finishReason,reason);
  }
});

test('tool calls, legacy functions and reasoning/continuation fields never become commands or successful completion', async t => {
  const variants=[
    [chunk({tool_calls:[{index:0,id:'call',function:{name:'delete',arguments:'{}'}}]}),'AGENT_CHAT_TOOLS_UNSUPPORTED'],
    [chunk({function_call:{name:'delete',arguments:'{}'}}),'AGENT_CHAT_TOOLS_UNSUPPORTED'],
    [chunk({},'tool_calls'),'AGENT_CHAT_TOOLS_UNSUPPORTED'],
    [chunk({reasoning_content:'synthetic-private-marker'}),'AGENT_CHAT_REASONING_UNSUPPORTED'],
    [chunk({reasoning:'synthetic-private-marker'}),'AGENT_CHAT_REASONING_UNSUPPORTED'],
    [chunk({reasoning_details:[{type:'signature',data:'synthetic-private-marker'}]}),'AGENT_CHAT_REASONING_UNSUPPORTED'],
    [chunk({},null,{previous_response_id:'synthetic-private-marker'}),'AGENT_CHAT_REASONING_UNSUPPORTED'],
  ];
  for (const [value,code] of variants) {
    const service=await fixture(t,response=>response.end(frame(value)+frame(chunk({},'stop'))+frame('[DONE]')));
    await assert.rejects(collect(service.run()),error=>error.code===code&&!error.message.includes('marker'));
    assert.equal(service.calls.length,1);
  }
});

test('malformed payloads, unrecognized choice shapes, invalid UTF-8 and midstream errors fail safely', async t => {
  const cases=[
    [frame('{not-json'),'AGENT_CHAT_PROTOCOL_ERROR'],[frame([]),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame({choices:[{index:1,delta:{content:'x'}}]}),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame({choices:[{index:0,delta:{content:['x']}}]}),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame({choices:[{index:0,delta:{audio:{data:'x'}}}]}),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame({choices:[{index:0,delta:{content:'\ud800'}}]}),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame(chunk({},'unknown')),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame({error:{message:'synthetic-private-marker'}}),'AGENT_CHAT_PROVIDER_ERROR'],
    ['event: error\ndata: synthetic-private-marker\n\n','AGENT_CHAT_PROVIDER_ERROR'],
    [Buffer.from([0xc3,0x28]),'AGENT_CHAT_PROTOCOL_ERROR'],
  ];
  for (const [source,code] of cases) {
    const service=await fixture(t,response=>response.end(source));
    await assert.rejects(collect(service.run()),error=>error.code===code&&!error.message.includes('marker'));
  }
});

test('missing finish or DONE, unterminated frames, conflicting finish and post-terminal text never complete', async t => {
  const cases=[
    [frame(chunk({content:'partial'})),'AGENT_CHAT_TRUNCATED'],
    [frame(chunk({},'stop')),'AGENT_CHAT_TRUNCATED'],
    [frame('[DONE]'),'AGENT_CHAT_TRUNCATED'],
    [frame(chunk({},'stop'))+'data: [DONE]','AGENT_CHAT_TRUNCATED'],
    [frame(chunk({},'stop'))+frame(chunk({},'length'))+frame('[DONE]'),'AGENT_CHAT_PROTOCOL_ERROR'],
    [frame(chunk({},'stop'))+frame(chunk({content:'late'}))+frame('[DONE]'),'AGENT_CHAT_PROTOCOL_ERROR'],
    [complete('ok')+frame(chunk({content:'after DONE'})),'AGENT_CHAT_PROTOCOL_ERROR'],
  ];
  for (const [source,code] of cases) {
    const service=await fixture(t,response=>response.end(source)); const events=[];
    await assert.rejects(async()=>{for await(const event of service.run())events.push(event);},{code});
    assert.equal(events.some(event=>event.type==='done'),false);
  }
});

test('wire, event, text and returned output-token bounds stop oversized streams without retry', async t => {
  const cases=[
    [':'+ 'x'.repeat(65537)+'\n\n'],
    [frame(chunk({content:'x'.repeat(40000)})).repeat(7)+frame(chunk({},'stop'))+frame('[DONE]')],
    [(': keepalive\n\n').repeat(90000)],
    [frame(chunk({},'stop',{usage:{completion_tokens:2049}}))+frame('[DONE]')],
  ];
  for(const [source] of cases){const service=await fixture(t,response=>response.end(source));await assert.rejects(collect(service.run()),{code:'AGENT_CHAT_LIMIT'});assert.equal(service.calls.length,1);}
});

test('stop and iterator return close the actual local socket, preserve partial output and never retry', async t => {
  let closed=false;
  const service=await fixture(t,response=>{response.on('close',()=>{closed=true;});response.write(frame(chunk({content:'partial'})));});
  const controller=new AbortController(); const events=[];
  await assert.rejects(async()=>{for await(const event of service.run({signal:controller.signal})){events.push(event);controller.abort('synthetic-private-marker');}},{code:'AGENT_CHAT_ABORTED'});
  await delay(20); assert.equal(closed,true);assert.deepEqual(events,[{type:'delta',text:'partial'}]);assert.equal(service.calls.length,1);
  const second=await fixture(t,response=>response.write(frame(chunk({content:'one'}))));
  const iterator=second.run();assert.equal((await iterator.next()).value.text,'one');await iterator.return();
});

test('read inactivity and total duration apply to real sockets even after partial output or keepalives', async t => {
  const idle=await fixture(t,response=>response.write(frame(chunk({content:'partial'}))),{limits:{readTimeoutMs:30,totalTimeoutMs:500,connectTimeoutMs:100}});
  await assert.rejects(collect(idle.run()),{code:'AGENT_CHAT_TIMEOUT'});
  const total=await fixture(t,response=>{const timer=setInterval(()=>response.write(': alive\n\n'),5);response.on('close',()=>clearInterval(timer));},{limits:{readTimeoutMs:100,totalTimeoutMs:40,connectTimeoutMs:100}});
  await assert.rejects(collect(total.run()),{code:'AGENT_CHAT_TIMEOUT'});
});

test('provider connection dropping after text is incomplete, including after a framed DONE', async t => {
  for (const source of [frame(chunk({content:'partial'})),complete('text')]) {
    const service=await fixture(t,response=>{response.write(source);setTimeout(()=>response.destroy(),10);});
    const events=[]; await assert.rejects(async()=>{for await(const event of service.run()) events.push(event);},{code:'AGENT_CHAT_TRUNCATED'});
    assert.equal(events.some(event=>event.type==='done'),false);
  }
});


test('an explicitly acquired Ollama-bound key is sent only to the selected local fixture', async t => {
  const service=await fixture(t,response=>response.end(complete('ok')));
  await collect(service.run({apiKey:'synthetic-local-bound-marker'}));
  assert.equal(service.calls[0].headers.authorization,'Bearer synthetic-local-bound-marker');
  assert.equal(service.calls.length,1);
});

test('oversized response headers are rejected by real Node HTTP parsing without disclosing values', async t => {
  const server=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream','X-Oversized':'synthetic-private-marker'.repeat(1000)});response.end(complete('never accepted'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const configuration={protocol:'chat_completions',presetId:'ollama',platformId:'local',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'qwen3:8b'};
  await assert.rejects(collect(streamChatCompletion({configuration,apiKey:null,messages,selfPort:1})),error=>error.code==='AGENT_CHAT_CONNECT_FAILED'&&!error.message.includes('marker'));
});

test('null optional continuation fields and escaped command-like text remain inert text', async t => {
  const text='<script>alert(1)</script> {"tool":"delete_project"}';
  const service=await fixture(t,response=>response.end(frame(chunk({content:text,tool_calls:[],function_call:null,reasoning_content:'',reasoning_details:[]}))+frame(chunk({},'stop'))+frame('[DONE]')));
  assert.deepEqual(await collect(service.run()),[{type:'delta',text},{type:'done',finishReason:'stop'}]);
});
