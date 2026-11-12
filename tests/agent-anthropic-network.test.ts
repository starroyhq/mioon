import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import type {RequestOptions, request as httpsRequest} from 'node:https';
import type {MockIncoming, MockRequest} from './helpers/strict-agent-workspace-types.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {createAgentTransport, wasAgentTransportSubmissionPrevented} from '../packages/business/src/agent/network-policy.ts';
import {createAnthropicSdkTransport} from '../packages/business/src/agent/anthropic-sdk-transport.ts';
import {agentChatDiagnostic} from '../packages/business/src/agent/chat-errors.ts';
import {ANTHROPIC_MESSAGES_API_VERSION} from '../packages/business/src/agent/anthropic-protocol.ts';
import * as anthropicProtocol from '../packages/business/src/agent/anthropic-protocol.ts';

const configuration: AgentConfiguration = {presetId: 'custom', platformId: 'custom', baseUrl: 'https://messages.example.com/anthropic', model: 'synthetic', protocol: 'anthropic_messages'};
const lookup = (async () => [{address: '8.8.8.8', family: 4}]) as unknown as typeof import('node:dns/promises').lookup;
function fixture({peer = '8.8.8.8', status = 200, body = 'data: synthetic\n\n'}: {peer?: string; status?: number; body?: string} = {}) {
  const calls: {options: RequestOptions; payload?: string}[] = [];
  let ends = 0;
  const request = ((options: RequestOptions, callback: (response: MockIncoming) => void) => {
    const call: {options: RequestOptions; payload?: string} = {options}; calls.push(call);
    const child = new EventEmitter() as MockRequest;
    child.setTimeout = () => {}; child.destroy = () => {};
    child.end = payload => {
      ends++; call.payload = payload;
      const incoming = Readable.from([Buffer.from(body)]) as MockIncoming;
      incoming.statusCode = status; incoming.headers = {'content-type': 'text/event-stream'};
      callback(incoming);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      Object.assign(socket, {remoteAddress: peer, remotePort: 443, authorized: true, destroy() {}});
      child.emit('socket', socket); socket.emit('secureConnect');
    });
    return child;
  }) as unknown as typeof httpsRequest;
  return {calls, request, ends: () => ends};
}

test('Anthropic transport owns the exact prefixed path, fixed version and bound key headers', async () => {
  const f = fixture(), body = '{"stream":true}';
  const stream = await createAgentTransport({lookup, httpsRequest: f.request})({configuration, apiKey: 'synthetic-bound-key', body});
  const options = f.calls[0]!.options, headers = options.headers as Record<string, string>;
  assert.equal(options.path, '/anthropic/v1/messages'); assert.equal(options.hostname, 'messages.example.com');
  assert.equal(headers['x-api-key'], 'synthetic-bound-key'); assert.equal(headers['anthropic-version'], ANTHROPIC_MESSAGES_API_VERSION);
  assert.equal(ANTHROPIC_MESSAGES_API_VERSION, '2023-06-01');
  assert.equal(headers.Authorization, undefined); assert.equal(headers.Cookie, undefined);
  assert.equal(options.rejectUnauthorized, true); assert.equal(headers['Accept-Encoding'], 'identity');
  assert.equal(f.calls[0]!.payload, body); assert.equal(f.ends(), 1);
  for await (const _chunk of stream.body) { /* Drain the bounded fixture stream. */ }
  stream.close();
});

test('Messages SDK wrapping preserves the safe HTTP diagnostic from the pinned transport', async () => {
  const status = 403, body = JSON.stringify({model:configuration.model,stream:true,max_tokens:30,messages:[{role:'user',content:'Synthetic prompt'}]});
  const f = fixture({status,body:JSON.stringify({type:'error',error:{type:'permission_error',message:'Synthetic private message with sk-proj-synthetic-credential'}})});
  const open = createAnthropicSdkTransport({lookup,httpsRequest:f.request});
  await assert.rejects(open({configuration,apiKey:'synthetic-bound-key',body}), error=>{
    assert.deepEqual(agentChatDiagnostic(error),{kind:'http',status,providerType:'permission_error'});
    assert.equal(wasAgentTransportSubmissionPrevented(error),false);
    return (error as {code?:string}).code==='AGENT_CHAT_HTTP_ERROR';
  });
  assert.equal(f.ends(),1);
  assert.equal(f.calls[0]!.payload,body);
});

test('Sonnet prefix binding requires the exact official identity and frozen adaptive low request',()=>{
  const sonnet:AgentConfiguration={presetId:'anthropic',platformId:'global',baseUrl:'https://api.anthropic.com',model:'claude-sonnet-5-5',protocol:'anthropic_messages'};
  const fields={thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}},output_config:{effort:'low'}};
  assert.deepEqual(anthropicProtocol.agentSonnetThinkingFields(),fields);
  assert.equal(anthropicProtocol.SONNET_PREFIX_BINDING_API_VERSION,'2026-10-21');
  assert.ok(Object.isFrozen(anthropicProtocol.agentSonnetThinkingFields()));assert.ok(Object.isFrozen(anthropicProtocol.agentSonnetThinkingFields().thinking.block_binding));
  const body={model:sonnet.model,stream:true,...fields};
  assert.equal(anthropicProtocol.agentSonnetConfiguration(sonnet),true);
  assert.equal(anthropicProtocol.agentSonnetPrefixBinding(sonnet,body),true);
  for(const patch of [{presetId:'custom'},{platformId:'custom'},{baseUrl:'https://api.anthropic.com.evil.example'},{baseUrl:'https://api.anthropic.com/v1'},
    {model:'claude-sonnet-5-5-20990101'},{model:'claude-haiku-4-5'},{protocol:'chat_completions'}]){
    assert.equal(anthropicProtocol.agentSonnetConfiguration({...sonnet,...patch}),false);
    assert.equal(anthropicProtocol.agentSonnetPrefixBinding({...sonnet,...patch},body),false);
  }
  for(const patch of [{model:'claude-haiku-4-5'},{stream:false},{thinking:{type:'disabled'}},{thinking:{type:'between_tools'}},
    {thinking:{type:'adaptive'}},{thinking:{...fields.thinking,display:'omitted'}},
    {thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'error'}}},
    {thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block',extra:true}}},
    {output_config:{effort:'medium'}},{output_config:{effort:'low',extra:true}},{output_config:undefined}])assert.equal(anthropicProtocol.agentSonnetPrefixBinding(sonnet,{...body,...patch}),false);
  for(const invalid of [null,[],false,'serialized'])assert.equal(anthropicProtocol.agentSonnetPrefixBinding(sonnet,invalid),false);
});

test('only the exact Sonnet frozen request derives the fixed beta header at host dispatch',async t=>{
  const sonnet:AgentConfiguration={presetId:'anthropic',platformId:'global',baseUrl:'https://api.anthropic.com',model:'claude-sonnet-5-5',protocol:'anthropic_messages'};
  const fields={thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}},output_config:{effort:'low'}};
  for(const [selected,body,beta] of [
    [sonnet,JSON.stringify({model:sonnet.model,stream:true,...fields}),true],
    [sonnet,JSON.stringify({model:sonnet.model,stream:true,thinking:{type:'disabled'}}),false],
    [{...sonnet,presetId:'custom',platformId:'custom'},JSON.stringify({model:sonnet.model,stream:true,...fields}),false],
    [sonnet,'{',false],
  ] as const){
    const f=fixture(),stream=await createAgentTransport({lookup,httpsRequest:f.request})({configuration:selected,apiKey:'synthetic-bound-key',body});
    t.after(()=>stream.close());
    const headers=f.calls[0]!.options.headers as Record<string,string>;
    assert.equal(headers['anthropic-beta'],beta?'thinking-binding-controls-2026-08-01':undefined);assert.equal(headers['anthropic-version'],beta?'2026-10-21':'2023-06-01');
    assert.equal(headers.Authorization,undefined);assert.equal(headers['x-api-key'],'synthetic-bound-key');assert.equal(f.calls[0]!.payload,body);assert.equal(f.ends(),1);stream.close();
  }
});

test('OpenAI protocols keep their original Bearer headers and endpoints', async () => {
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const f = fixture();
    const stream = await createAgentTransport({lookup, httpsRequest: f.request})({configuration: {...configuration, protocol, baseUrl: 'https://messages.example.com/v1'}, apiKey: 'synthetic-bound-key', body: '{}'});
    const headers = f.calls[0]!.options.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer synthetic-bound-key');
    assert.equal(headers['x-api-key'], undefined); assert.equal(headers['anthropic-version'], undefined);
    assert.equal(f.calls[0]!.options.path, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
    stream.close();
  }
});

test('changing the caller object during DNS cannot change protocol, key mode or approved destination', async () => {
  const f = fixture(), caller = {...configuration}, pending = Promise.withResolvers<{address: string; family: number}[]>();
  const open = createAgentTransport({lookup: (() => pending.promise) as unknown as typeof lookup, httpsRequest: f.request});
  const waiting = open({configuration: caller, apiKey: 'synthetic-bound-key', body: '{}'});
  caller.protocol = 'chat_completions'; caller.baseUrl = 'https://other.example.com/v1';
  pending.resolve([{address: '8.8.8.8', family: 4}]);
  const stream = await waiting, headers = f.calls[0]!.options.headers as Record<string, string>;
  assert.equal(f.calls[0]!.options.hostname, 'messages.example.com');
  assert.equal(f.calls[0]!.options.path, '/anthropic/v1/messages');
  assert.equal(headers['x-api-key'], 'synthetic-bound-key'); assert.equal(headers.Authorization, undefined);
  stream.close();
});

test('Anthropic requests preserve DNS, socket, cancellation and no-redirect dispatch evidence', async () => {
  const privateDns = fixture();
  await assert.rejects(createAgentTransport({lookup: (async () => [{address: '127.0.0.1', family: 4}]) as unknown as typeof lookup, httpsRequest: privateDns.request})({configuration, apiKey: 'synthetic', body: '{}'}), error => wasAgentTransportSubmissionPrevented(error));
  assert.equal(privateDns.calls.length, 0);
  const wrongPeer = fixture({peer: '1.1.1.1'});
  await assert.rejects(createAgentTransport({lookup, httpsRequest: wrongPeer.request})({configuration, apiKey: 'synthetic', body: '{}'}), {code: 'AGENT_CHAT_NETWORK_DENIED'});
  assert.equal(wrongPeer.ends(), 0);
  const redirect = fixture({status: 302}); let failure: unknown;
  await assert.rejects(createAgentTransport({lookup, httpsRequest: redirect.request})({configuration, apiKey: 'synthetic', body: '{}'}), error => {failure = error; return true;});
  assert.equal(wasAgentTransportSubmissionPrevented(failure), false); assert.equal(redirect.calls.length, 1); assert.equal(redirect.ends(), 1);
  const cancelled = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(createAgentTransport({lookup, httpsRequest: cancelled.request})({configuration, apiKey: 'synthetic', body: '{}', signal: controller.signal}), {code: 'AGENT_CHAT_ABORTED'});
  assert.equal(cancelled.calls.length, 0);
});
