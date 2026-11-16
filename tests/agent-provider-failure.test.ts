import test from 'node:test';
import assert from 'node:assert/strict';
import {agentChatDiagnostic, agentChatHttpError, agentChatProviderError, agentChatProviderRetryAfterMs, agentChatProviderRetryable, hasProviderChatCompletionFailure, safeAgentChatError} from '../packages/business/src/agent/chat-errors.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {agentFailureDiagnosticSchema} from '../packages/contracts/src/agent-failure-diagnostic.ts';

const configuration = (presetId: string, protocol: AgentConfiguration['protocol'] = 'responses'): AgentConfiguration =>
  ({presetId, protocol, platformId:'synthetic', model:'synthetic', baseUrl:'https://models.example.com'});
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
function diagnostic(error: unknown) {
  return agentFailureDiagnosticSchema.parse(agentChatDiagnostic(error));
}
function reason(error: unknown): string | undefined {
  const evidence = diagnostic(error);
  if (evidence.kind === 'http') return evidence.provider?.reason;
  if (evidence.kind === 'provider') return evidence.reason;
}

test('Responses reads failed-response details and plain errors without retaining provider-supplied data outside known fields', () => {
  const secret = 'SYNTHETIC_SECRET_AND_PRIVATE_PROMPT';
  const provider = configuration('openai');
  const direct = agentChatProviderError(provider,'error',{
    type:'error', code:'unsupported_parameter', param:'reasoning', message:'Unsupported parameter: '+secret, unused:secret,
  });
  assert.deepEqual(diagnostic(direct),{
    kind:'provider', event:'error', reason:'invalid_parameter', code:'unsupported_parameter', param:'reasoning', message:'Unsupported parameter',
  });
  const rejected = agentChatProviderError(provider,'response.failed',{
    type:'response.failed', response:{
      error:{type:'invalid_request_error',code:'context_length_exceeded',param:'input.messages.'+secret,message:'Prompt is too long. '+secret},
      input:secret,
    },
  });
  assert.deepEqual(diagnostic(rejected),{
    kind:'provider', event:'response.failed', reason:'context_length', providerType:'invalid_request_error', code:'context_length_exceeded',message:'Prompt is too long',
  });
  assert.equal(agentChatProviderRetryable(rejected),false);
  const error = agentChatProviderError(provider,'error',{
    type:'error',code:secret,param:secret,message:'Your response has error '+secret.repeat(500),metadata:{secret},
  });
  assert.deepEqual(diagnostic(error),{kind:'provider', event:'error', reason:'unknown'});
  assert.doesNotMatch(JSON.stringify(safeAgentChatError(error)),/SYNTHETIC_SECRET/);
  assert.equal(agentChatProviderRetryable(error),false);
});

test('OpenAI prioritizes a quota or parameter rejection over generic rate limiting, only transport-owned errors are retry evidence', () => {
  const provider = configuration('openai');
  const respond = (status: number, error: unknown, wait?: string) => agentChatHttpError(status,bytes({error}),provider,wait);
  const exhausted = respond(429,{type:'rate_limit_error',code:'credit_balance_exhausted',message:'Insufficient credits'},'2');
  assert.deepEqual(diagnostic(exhausted),{
    kind:'http',status:429,providerType:'rate_limit_error',providerCode:'credit_balance_exhausted',
    provider:{kind:'provider',reason:'quota',providerType:'rate_limit_error',code:'credit_balance_exhausted',message:'Insufficient credits'},
  });
  assert.equal(agentChatProviderRetryable(exhausted),false);
  const throttled = respond(429,{type:'invalid_request_error',code:'rate_limit_exceeded',message:'Rate limit exceeded'},'4');
  assert.equal(agentChatProviderRetryable(throttled),true);
  assert.equal(agentChatProviderRetryAfterMs(throttled),4000);
  assert.equal(reason(throttled),'rate_limit');
  for (const counterfeit of [{...throttled},Object.create(throttled),{cause:throttled}, {diagnostic:diagnostic(throttled),retryAfterMs:2}]) {
    assert.equal(agentChatProviderRetryable(counterfeit),false);
    assert.equal(agentChatProviderRetryAfterMs(counterfeit),undefined);
  }
  assert.equal(agentChatProviderRetryable(respond(429,{message:'Undocumented reason'})),false);
  assert.equal(agentChatProviderRetryable(respond(400,{code:'server_error'})),false);
  assert.equal(agentChatProviderRetryable(respond(503,{code:'server_is_overloaded'})),true);
});

test('Anthropic distinguishes an explicit stream overload and ramp limit from quota and ambiguous 429', () => {
  const provider = configuration('anthropic','anthropic_messages');
  const stream = (error: unknown) => agentChatProviderError(provider,'error',{type:'error',error});
  const overloaded = stream({type:'overloaded_error',message:'Overloaded: sk-synthetic-private'});
  assert.deepEqual(diagnostic(overloaded),{
    kind:'provider',event:'error',reason:'overloaded',providerType:'overloaded_error',message:'Overloaded',
  });
  assert.equal(agentChatProviderRetryable(overloaded),true);
  const capped = stream({type:'rate_limit_error',details:{error_code:'enforced_spend_limit_reached',secret:'private'}});
  assert.equal(reason(capped),'quota');
  assert.equal(agentChatProviderRetryable(capped),false);
  assert.equal(agentChatProviderRetryable(stream({type:'rate_limit_error',details:{error_code:'ramp_limit_exceeded'}})),true);
  assert.equal(reason(stream({type:'rate_limit_error'})),'unknown');
  const paced = agentChatHttpError(429,bytes({error:{type:'rate_limit_error'}}),provider,'0');
  assert.equal(agentChatProviderRetryAfterMs(paced),0);
  assert.equal(reason(paced),'rate_limit');
  assert.equal(agentChatProviderRetryable(paced),true);
  const cap = agentChatHttpError(400,bytes({error:{type:'invalid_request_error',message:'You have reached your specified workspace API usage limits: private limit'}}),provider);
  assert.equal(reason(cap),'quota');
  assert.equal(agentChatProviderRetryable(cap),false);
});

test('OpenRouter canonical types override the same lossy Responses code', () => {
  const response = (typed?: string) => agentChatProviderError(configuration('openrouter'),'response.failed',{
    type:'response.failed',response:{error:{code:'server_error',message:'Internal server error'},error_type:typed},
  });
  for (const [type, expected, retry] of [
    ['provider_overloaded','overloaded',true],['authentication','authentication',false],['payment_required','quota',false],
    ['context_length_exceeded','context_length',false],['unmapped','unknown',false],[undefined,'unknown',false],
  ] as const) {
    const error = response(type);
    assert.equal(reason(error),expected);
    assert.equal(agentChatProviderRetryable(error),retry);
  }
  const rate = agentChatProviderError(configuration('openrouter','chat_completions'),'message',{
    error:{code:429,message:'Rate limit exceeded',metadata:{error_type:'rate_limit_exceeded',raw:'sk-synthetic-secret'}},
    choices:[{finish_reason:'error'}],
  });
  assert.deepEqual(diagnostic(rate),{
    kind:'provider',event:'message',reason:'rate_limit',providerType:'rate_limit_exceeded',code:429,message:'Rate limit exceeded',
  });
  assert.equal(agentChatProviderRetryable(rate),true);
});

test('the compatible vendor codes preserve their specific availability, request, billing and rate-limit semantics', () => {
  for (const [presetId, code, expected, retry] of [
    ['zhipu','1305','overloaded',true],['zhipu',1302,'rate_limit',true],['zhipu','1113','quota',false],
    ['zhipu','1261','context_length',false],['zhipu','1214','invalid_parameter',false],['zhipu','1211','model_unavailable',false],
    ['qwen','Throttling.RateQuota','rate_limit',true],['qwen','Arrearage','quota',false],['qwen','ModelNotFound','model_unavailable',false],
    ['qwen','InternalError.Algo.InvalidParameter','context_length',false],
    ['minimax',1002,'rate_limit',true],['minimax','1008','quota',false],['minimax','2069','model_unavailable',false],
    ['kimi','engine_overloaded_error','overloaded',true],['kimi','exceeded_current_quota_error','quota',false],
  ] as const) {
    const error = agentChatProviderError(configuration(presetId,'chat_completions'),'message',{error:{code}});
    assert.deepEqual(diagnostic(error),{kind:'provider',event:'message',reason:expected,code});
    assert.equal(agentChatProviderRetryable(error),retry);
  }
  const kimi = configuration('kimi','chat_completions');
  const moonshot = (message: string) => agentChatProviderError(kimi,'message',{error:{type:'rate_limit_reached_error',message}});
  assert.equal(reason(moonshot('Organization-level TPD limit reached')),'quota');
  assert.equal(agentChatProviderRetryable(moonshot('Organization-level RPM limit reached')),true);
  assert.equal(agentChatProviderRetryable(moonshot('Rate limit reached')),false);
  const deepseek = agentChatHttpError(429,undefined,configuration('deepseek','chat_completions'));
  assert.deepEqual(diagnostic(deepseek),{kind:'http',status:429});
  assert.equal(agentChatProviderRetryable(deepseek),true);
  const local = agentChatHttpError(404,bytes({error:"model 'synthetic-local-model' not found"}),configuration('ollama','chat_completions'));
  assert.equal(agentChatProviderRetryable(local),false);
  assert.doesNotMatch(JSON.stringify(diagnostic(local)),/synthetic-local-model/);
  const custom = agentChatHttpError(429,bytes({error:{code:'provider-private-code'}}),configuration('custom'));
  assert.deepEqual(diagnostic(custom),{kind:'http',status:429});
  assert.equal(agentChatProviderRetryable(custom),false);
  for (const presetId of ['custom','ollama']) {
    const compatible = agentChatProviderError(configuration(presetId),'error',{type:'error',code:'server_error',message:'Internal server error'});
    assert.equal(reason(compatible),'server');
    assert.equal(agentChatProviderRetryable(compatible),false);
  }
});

test('documented compatible Chat Completions terminal failures are recognized only under their own provider', () => {
  for (const [provider, payload, code, expected, retry] of [
    ['minimax',{base_resp:{status_code:2064,status_msg:'Server is overloaded'}},2064,'overloaded',true],
    ['zhipu',{choices:[{index:0,finish_reason:'model_context_window_exceeded'}]},'model_context_window_exceeded','context_length',false],
    ['deepseek',{choices:[{index:0,finish_reason:'insufficient_system_resource'}]},'insufficient_system_resource','overloaded',true],
  ] as const) {
    const preset = configuration(provider,'chat_completions');
    assert.equal(hasProviderChatCompletionFailure(preset,payload),true);
    assert.equal(hasProviderChatCompletionFailure({...preset,presetId:'custom'},payload),false);
    assert.equal(hasProviderChatCompletionFailure({...preset,protocol:'responses'},payload),false);
    const error = agentChatProviderError(preset,'message',payload);
    assert.equal(reason(error),expected);
    const evidence = diagnostic(error);
    assert.ok(evidence.kind === 'provider');
    assert.equal(evidence.code,code);
    assert.equal(agentChatProviderRetryable(error),retry);
  }
  assert.equal(hasProviderChatCompletionFailure(configuration('minimax','chat_completions'),{base_resp:{status_code:0}}),false);
  const deepseek = configuration('deepseek','chat_completions');
  assert.equal(hasProviderChatCompletionFailure(deepseek,{choices:[{index:1,finish_reason:'insufficient_system_resource'}]}),false);
  assert.equal(hasProviderChatCompletionFailure(deepseek,{choices:[{index:0,finish_reason:'stop'}]}),false);
});

test('only bounded HTTP Retry-After syntax reaches runtime waiting metadata', t => {
  const provider = configuration('openai');
  const settled = Date.UTC(2026,10,16,12);
  t.mock.method(Date,'now',() => settled);
  const response = (header: unknown) => agentChatHttpError(503,undefined,provider,header);
  assert.equal(agentChatProviderRetryAfterMs(response(new Date(settled+5000).toUTCString())),5000);
  assert.equal(agentChatProviderRetryAfterMs(response(new Date(settled-5000).toUTCString())),0);
  assert.equal(agentChatProviderRetryAfterMs(response('99999999999999999999999')),Number.MAX_SAFE_INTEGER);
  for (const invalid of [['10'],10,'-1','2.5','tomorrow','3, 20','synthetic-private-header']) {
    const error = response(invalid);
    assert.equal(agentChatProviderRetryAfterMs(error),undefined);
    assert.deepEqual(diagnostic(error),{kind:'http',status:503});
  }
});
