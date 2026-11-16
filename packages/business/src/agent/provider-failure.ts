import type {AgentProviderFailureDiagnostic} from '../../../contracts/src/agent-failure-diagnostic.ts';
import type {AgentConfiguration} from './config.ts';

type Provider = AgentConfiguration['presetId'];
type FailureReason = AgentProviderFailureDiagnostic['reason'];
type Event = NonNullable<AgentProviderFailureDiagnostic['event']>;
type Reasons = Partial<Record<string, FailureReason>>;

// Only documented stable labels are retained. Labels with ambiguous meanings
// are classified separately from the general compatible-wire vocabulary.
const shared: Reasons = {
  api_error:'server', internal_error:'server', server_error:'server', service_unavailable:'server',
  service_unavailable_error:'server', server_unavailable:'server', unexpected_output:'server',
  overloaded_error:'overloaded', server_overloaded:'overloaded', server_is_overloaded:'overloaded',
  rate_limit_error:'rate_limit', rate_limit_exceeded:'rate_limit', slow_down:'rate_limit',
  billing_error:'quota', payment_required:'quota', billing_hard_limit_reached:'quota', billing_not_active:'quota',
  insufficient_quota:'quota', credit_balance_exhausted:'quota', usage_limit_exceeded:'quota',
  organization_spend_limit_exceeded:'quota', organization_usage_limit_exceeded:'quota', project_spend_limit_exceeded:'quota',
  context_length_exceeded:'context_length', request_too_large:'context_length',
  model_not_found:'model_unavailable', not_found_error:'model_unavailable', resource_not_found:'model_unavailable',
  invalid_request:'invalid_parameter', invalid_request_error:'invalid_parameter', invalid_prompt:'invalid_parameter',
  unsupported_parameter:'invalid_parameter', unsupported_value:'invalid_parameter',
  authentication_error:'authentication', invalid_api_key:'authentication', invalid_authentication:'authentication',
  permission_error:'authentication', permission_denied:'authentication',
  content_policy_violation:'unknown', image_content_policy_violation:'unknown',
  request_timeout:'unknown', timeout_error:'unknown',
};
const zhipu: Reasons = {
  model_context_window_exceeded:'context_length', network_error:'unknown', sensitive:'unknown',
  1000:'authentication', 1001:'authentication', 1003:'authentication', 1005:'authentication',
  1113:'quota', 1200:'server', 1210:'invalid_parameter', 1211:'model_unavailable', 1212:'invalid_parameter',
  1213:'invalid_parameter', 1214:'invalid_parameter', 1215:'invalid_parameter', 1220:'authentication',
  1221:'model_unavailable', 1222:'model_unavailable', 1230:'server', 1234:'server',
  1261:'context_length', 1301:'unknown', 1302:'rate_limit', 1305:'overloaded',
  1308:'quota', 1309:'quota', 1310:'quota', 1311:'model_unavailable', 1313:'quota',
  1314:'quota', 1315:'authentication', 1316:'quota', 1317:'quota', 1318:'quota', 1319:'quota', 1320:'quota', 1321:'quota',
};
const qwen: Reasons = {
  'Throttling.RateQuota':'rate_limit', 'Throttling.AllocationQuota':'rate_limit', 'Throttling.BurstRate':'rate_limit',
  'Throttling.ResourceExhausted':'overloaded', 'Throttling.ServiceOverloaded':'overloaded',
  LimitRequests:'rate_limit', limit_requests:'rate_limit', limit_burst_rate:'rate_limit',
  Arrearage:'quota', PrepaidBillOverdue:'quota', CommodityNotPurchased:'quota', 'isv.OUT_OF_SERVICE':'quota',
  ModelNotFound:'model_unavailable', 'Model.AccessDenied':'model_unavailable', InvalidApiKey:'authentication',
  AccessDenied:'authentication', access_denied:'authentication',
  InvalidParameter:'invalid_parameter', invalid_parameter_error:'invalid_parameter',
  'InvalidParameter.NotSupportEnableThinking':'invalid_parameter', 'InternalError.Algo.InvalidParameter':'context_length',
  ServiceUnavailable:'server', DataInspectionFailed:'unknown', data_inspection_failed:'unknown',
  // Model Studio also uses internal errors for requests needing configuration changes.
  InternalError:'unknown', 'InternalError.Algo':'unknown',
};
const kimi: Reasons = {
  engine_overloaded_error:'overloaded', exceeded_current_quota_error:'quota', resource_not_found_error:'model_unavailable',
  permission_denied_error:'authentication', invalid_authentication_error:'authentication',
  invalid_parameter_error:'invalid_parameter', rate_limit_reached_error:'rate_limit',
};
const anthropic: Reasons = {enforced_spend_limit_reached:'quota', ramp_limit_exceeded:'rate_limit'};
const deepseek: Reasons = {insufficient_system_resource:'overloaded', aborted:'unknown'};
const minimax: Reasons = {
  1000:'unknown', 1001:'unknown', 1002:'rate_limit', 1004:'authentication', 1008:'quota', 1024:'server',
  1026:'unknown', 1027:'unknown', 1033:'server', 1039:'unknown', 1041:'rate_limit', 1042:'invalid_parameter',
  2013:'invalid_parameter', 2014:'invalid_parameter', 2022:'model_unavailable', 2045:'rate_limit', 2046:'rate_limit',
  2047:'rate_limit', 2049:'authentication', 2053:'quota', 2056:'quota', 2057:'authentication', 2061:'model_unavailable',
  2062:'rate_limit', 2064:'overloaded', 2066:'unknown', 2067:'quota', 2068:'model_unavailable', 2069:'model_unavailable',
};
const openrouter: Reasons = {
  authentication:'authentication', permission_denied:'authentication', payment_required:'quota',
  token_limit_exceeded:'quota', context_length_exceeded:'context_length', payload_too_large:'context_length',
  invalid_request:'invalid_parameter', invalid_prompt:'invalid_parameter', string_too_long:'invalid_parameter',
  unprocessable:'invalid_parameter', not_found:'model_unavailable', rate_limit_exceeded:'rate_limit',
  provider_overloaded:'overloaded', provider_unavailable:'server', server:'server', timeout:'unknown',
  content_policy_violation:'unknown', refusal:'unknown', unmapped:'unknown', max_tokens_exceeded:'unknown',
  invalid_image:'invalid_parameter', image_too_large:'invalid_parameter', image_too_small:'invalid_parameter',
  unsupported_image_format:'invalid_parameter', image_not_found:'invalid_parameter', image_download_failed:'invalid_parameter',
};
const providerReasons: Partial<Record<string, Reasons>> = {anthropic, deepseek, qwen, zhipu, kimi, minimax, openrouter};
const knownParams = new Set([
  'model','messages','input','instructions','max_tokens','max_output_tokens','max_completion_tokens','temperature',
  'top_p','stream','stream_options','tools','tool_choice','parallel_tool_calls','reasoning','reasoning_effort',
  'thinking','output_config','enable_thinking','response_format','text','store','service_tier','truncation',
  'include','conversation','previous_response_id','parameters','input_schema','metadata',
]);
const genericTypes = new Set(['invalid_request', 'invalid_request_error']);
const retryable = new Set<FailureReason>(['server','overloaded','rate_limit']);
const retryProviders = new Set<Provider>(['openai','anthropic','deepseek','qwen','zhipu','kimi','minimax','openrouter']);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function chatCompletionFailureCode(configuration: AgentConfiguration, payload: unknown): string | number | undefined {
  if (configuration.protocol !== 'chat_completions') return undefined;
  const frame = object(payload);
  if (configuration.presetId === 'minimax') {
    const code = object(frame?.base_resp)?.status_code;
    return typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? code : undefined;
  }
  if (!(configuration.presetId === 'deepseek' || configuration.presetId === 'zhipu')) return undefined;
  if (!Array.isArray(frame?.choices) || frame.choices.length !== 1) return undefined;
  const choice = object(frame.choices[0]);
  const code = choice?.finish_reason;
  if (choice?.index !== 0 || typeof code !== 'string') return undefined;
  if (configuration.presetId === 'deepseek' && Object.hasOwn(deepseek,code)) return code;
  if (configuration.presetId === 'zhipu' && ['model_context_window_exceeded','network_error','sensitive'].includes(code)) return code;
  return undefined;
}

export function hasProviderChatCompletionFailure(configuration: AgentConfiguration, payload: unknown): boolean {
  return chatCompletionFailureCode(configuration,payload) !== undefined;
}

function labels(provider: Provider, value: unknown): FailureReason | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const own = Object.hasOwn(providerReasons,provider) ? providerReasons[provider] : undefined;
  if (own && Object.hasOwn(own, value)) return own[value];
  if (typeof value === 'string' && Object.hasOwn(shared, value)) return shared[value];
  return undefined;
}

function fallbackReason(provider: Provider, status: number | undefined): FailureReason {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'quota';
  if (status === 404 && ['openai','kimi','ollama'].includes(provider)) return 'model_unavailable';
  if (status === 413) return 'context_length';
  if (status === 400 || status === 422) return 'invalid_parameter';
  if (provider === 'deepseek' && status === 429) return 'rate_limit';
  if (provider === 'anthropic' && status === 529 || provider === 'deepseek' && status === 503) return 'overloaded';
  if (provider === 'openai' && status === 503) return 'overloaded';
  if (status === 500 && ['openai','anthropic','deepseek','zhipu'].includes(provider)) return 'server';
  return 'unknown';
}

// Error messages can contain input, account details, URLs or credentials even
// if they look like prose. Keep only an exact recognized explanatory phrase
// from the message. The boundary never copies any suffix supplied by the server.
const basicExplanations = [
  'Rate limit exceeded','Rate limit reached for requests','Too many requests','Temporary overload','Overloaded',
  'Internal server error','Internal error','Server error','Service unavailable','Server is overloaded',
  'The model is temporarily overloaded','The engine is currently overloaded','Provider is temporarily overloaded',
  'Provider disconnected mid-stream','The server had an error while processing your request',
  'An unexpected error occurred','An internal error has occurred','An error occurred while processing your request',
  'You exceeded your current quota','Insufficient credits','Insufficient balance','Your credit balance is too low',
  'Usage limit reached','API quota exceeded','Invalid API key provided','Invalid credentials','Authentication failed',
  'You have reached your API usage limits','You have reached your specified API usage limits','You have reached your specified workspace API usage limits',
  'Your request is too large','Your input exceeds the context window of this model',
  "This model's maximum context length is", 'Prompt is too long','Prompt too long','Maximum context length exceeded',
  'Model not found','The requested model does not exist','The model failed to generate a response',
  'Invalid API parameter','Invalid request','Invalid parameter','Unsupported parameter','Missing required parameter',
  'Prompt 超长','您的账户已欠费','该模型当前访问量过大','您的账户已达到速率限制','模型不存在',
  'API 调用参数有误','身份验证失败','服务集群负载较高','模型已下线','积分不足',
].sort((left,right) => right.length - left.length);

function safeExplanation(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const start = value.slice(0,256).trimStart();
  const normalized = start.toLowerCase();
  for (const explanation of basicExplanations) {
    if (!normalized.startsWith(explanation.toLowerCase())) continue;
    const boundary = start.charAt(explanation.length);
    if (!boundary || /[\s.,:;!?，。；：！？]/u.test(boundary)) return explanation;
  }
  return undefined;
}

function messageReason(provider: Provider, value: unknown): FailureReason | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.slice(0,512);
  if (provider === 'anthropic' && /^(?:you have reached your (?:specified )?(?:workspace )?API usage limits|your (?:organization|workspace) has reached (?:its |the )?(?:monthly )?(?:spend|usage) (?:limit|cap)|your credit balance is too low|(?:organization|workspace) spend limit (?:has been )?reached)/iu.test(text)) return 'quota';
  if (provider === 'kimi' && /^(?:organization-level )?(?:TPD|tokens per day)(?:\b| limit)/iu.test(text)) return 'quota';
  if (provider === 'anthropic' && /^prompt (?:is )?too long\b/iu.test(text)) return 'context_length';
  if (provider === 'ollama' && /^model ['"][\w.:/-]{1,160}['"] not found\b/iu.test(text)) return 'model_unavailable';
  return undefined;
}

function isTemporaryRateLimit(provider: Provider, code: unknown, type: unknown, message: unknown, delayMs: number | undefined): boolean {
  if (provider === 'anthropic' && (code === 'rate_limit_error' || type === 'rate_limit_error')) return code === 'ramp_limit_exceeded' || delayMs !== undefined;
  if (provider === 'kimi' && (code === 'rate_limit_reached_error' || type === 'rate_limit_reached_error')) {
    if (delayMs !== undefined) return true;
    return typeof message === 'string' && /^(?:organization-level )?(?:concurrency|RPM|TPM)\s+limit\b/iu.test(message);
  }
  return true;
}

export function providerFailureRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const header = value.trim();
  if (/^\d+$/u.test(header)) return Math.min(Number(header) * 1000,Number.MAX_SAFE_INTEGER);
  const httpDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
  if (!httpDate.test(header)) return undefined;
  const absolute = Date.parse(header);
  if (!Number.isFinite(absolute) || new Date(absolute).toUTCString() !== header) return undefined;
  return Math.max(0,absolute - Date.now());
}

export function providerFailureDiagnostic(configuration: AgentConfiguration, payload: unknown, options: {
  event?: Event;
  status?: number;
  retryAfterMs?: number;
} = {}): AgentProviderFailureDiagnostic {
  const provider = configuration.presetId;
  const frame = object(payload);
  const body = options.event === 'response.failed' ? object(frame?.response) : frame;
  const nested = object(body?.error);
  const detailCode = provider === 'anthropic' ? object(nested?.details)?.error_code : undefined;
  const base = provider === 'minimax' ? object(body?.base_resp) : undefined;
  const rawMessage = nested?.message ?? (typeof body?.error === 'string' ? body.error : undefined) ?? base?.status_msg ?? body?.message;
  const rawType = nested?.type ?? body?.type;
  const rawCode = labels(provider,detailCode) !== undefined ? detailCode
    : nested?.code ?? base?.status_code ?? body?.code ?? chatCompletionFailureCode(configuration,body);
  const rawParam = nested?.param ?? body?.param;
  const metadata = object(nested?.metadata);
  const typed = provider === 'openrouter' ? body?.error_type ?? nested?.error_type ?? metadata?.error_type : undefined;
  const typeReason = labels(provider,rawType);
  const codeReason = labels(provider,rawCode);
  const canonicalReason = typeof typed === 'string' && Object.hasOwn(openrouter,typed) ? openrouter[typed] : undefined;
  const recognizedMessageReason = messageReason(provider,rawMessage);
  const fallback = fallbackReason(provider,options.status);
  let reason = fallback;
  if (typed !== undefined) reason = canonicalReason ?? 'unknown';
  else if (recognizedMessageReason !== undefined) reason = recognizedMessageReason;
  else if (typeReason !== undefined && !retryable.has(typeReason) && !genericTypes.has(String(rawType))) reason = typeReason;
  else if (codeReason !== undefined) reason = codeReason;
  else if (typeReason !== undefined) reason = typeReason;
  if (reason === 'rate_limit' && !isTemporaryRateLimit(provider,rawCode,rawType,rawMessage,options.retryAfterMs)) reason = 'unknown';
  // OpenRouter's native Responses code can collapse authentication or quota to
  // server_error. Use only a known typed classification for a terminal retry.
  if (provider === 'openrouter' && configuration.protocol === 'responses' && options.event === 'response.failed' && typed === undefined && reason === 'server') reason = 'unknown';
  if (options.status !== undefined && options.status < 500 && options.status !== 429 && retryable.has(reason)) reason = fallback;
  const providerType = typeReason !== undefined && typeof rawType === 'string' ? rawType
    : canonicalReason !== undefined && typeof typed === 'string' ? typed : undefined;
  const nativeNumber = provider === 'openrouter' && typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599;
  const code = (codeReason !== undefined || nativeNumber) && (typeof rawCode === 'string' || typeof rawCode === 'number') ? rawCode : undefined;
  const param = typeof rawParam === 'string' && knownParams.has(rawParam) ? rawParam : undefined;
  const message = safeExplanation(rawMessage);
  return {kind:'provider',reason,...(options.event ? {event:options.event} : {}),
    ...(providerType !== undefined ? {providerType} : {}), ...(code !== undefined ? {code} : {}),
    ...(param !== undefined ? {param} : {}), ...(message !== undefined ? {message} : {})};
}

export function providerFailureIsTemporary(configuration: AgentConfiguration, diagnostic: AgentProviderFailureDiagnostic): boolean {
  return retryProviders.has(configuration.presetId) && retryable.has(diagnostic.reason);
}
