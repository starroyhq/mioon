// Never reflect provider bodies, headers, URLs, keys, socket errors or causes.
const errors = Object.freeze({
  AGENT_CHAT_CONTEXT_CHANGED: [409, '所选片段的已保存内容或归属已改变，本轮没有继续发送模型请求。此前已发送的请求仍可能计费。'],
  AGENT_CHAT_STORAGE_LIMIT: [507, '本地聊天存储已达容量上限；原始请求和记录已保留，未重新发送。'],
  AGENT_CHAT_STORAGE_UNAVAILABLE: [503, '本地聊天记录无法安全写入；已停止发送，请修复存储后重新打开。'],
  AGENT_CHAT_NOT_FOUND: [404, '项目或这次对话不存在。'],
  AGENT_CHAT_BUSY: [429, '正在生成的对话或订阅已达上限，请稍后继续。'],
  AGENT_CHAT_VALIDATION: [400, '聊天请求格式无效，请检查消息和模型设置。'],
  AGENT_CHAT_PROFILE_UNSUPPORTED: [400, '此模型尚未接入当前文本聊天配置，请选择已支持的非思考模型。'],
  AGENT_CHAT_KEY_REQUIRED: [409, '请先为当前服务保存 API 密钥。'],
  AGENT_CHAT_NETWORK_DENIED: [400, '服务地址不符合安全网络规则；本地服务仅支持独立的 Ollama 回环地址。'],
  AGENT_CHAT_CONNECT_FAILED: [502, '无法安全连接模型服务，请检查地址和网络后手动重试。'],
  AGENT_CHAT_TIMEOUT: [504, '模型请求已超时，保留已收到的文本；可手动重试。'],
  AGENT_CHAT_ABORTED: [499, '聊天已停止；这不保证远端计算或计费已经停止。'],
  AGENT_CHAT_HTTP_ERROR: [502, '模型服务拒绝了请求，请检查账户、模型和配置后手动重试。'],
  AGENT_CHAT_PROTOCOL_ERROR: [502, '模型返回了不支持或无效的文本流，请检查兼容配置。'],
  AGENT_CHAT_TRUNCATED: [502, '模型连接提前结束，回复可能不完整；可手动重试。'],
  AGENT_CHAT_LIMIT: [413, '聊天达到输入、输出或流量限制，已停止当前请求。'],
  AGENT_CHAT_TOOLS_UNSUPPORTED: [422, '模型请求了未获本轮授权的工具，或超出了本轮工具调用上限；该请求未执行。'],
  AGENT_CHAT_INSPECTION_UNAVAILABLE: [422, '所选项目的这项资料无法安全读取；没有继续发送模型请求。'],
  AGENT_CHAT_REASONING_UNSUPPORTED: [422, '模型返回了推理或续接数据；当前阶段仅支持非思考文本模式。'],
  AGENT_CHAT_PROVIDER_ERROR: [502, '模型服务在回复过程中报告错误，已保留收到的文本。'],
} as const);
export type AgentChatErrorCode = keyof typeof errors;
export type AgentChatFailure = Error & {code: AgentChatErrorCode; status: number};
export const AGENT_HTTP_DIAGNOSTIC_MAX_BYTES = 8 * 1024;
const parameterFields = ['model','messages','max_tokens','stream','thinking','tools','tool_choice','function','name','parameters','properties','required','additionalProperties','type','anyOf','allOf','$ref','$schema','pattern','format','enum','const'] as const;
const parameterCategories = {invalid_request:'请求格式',schema:'工具参数结构',unsupported:'不支持的参数',required:'必填字段',type:'参数类型',value:'参数取值'} as const;
type ParameterField = (typeof parameterFields)[number];
interface HttpParameterHints {fields: readonly ParameterField[]; categories: readonly (keyof typeof parameterCategories)[]; toolIndices: readonly number[]}
const httpEvidence = new WeakMap<object, {status: number; hints?: HttpParameterHints}>();
/** Hints are untrusted provider suggestions, never permission or retry evidence.
 * Only closed enums and bounded indices survive this in-memory classification. */
function httpParameterHints(bytes: Uint8Array | undefined): HttpParameterHints | undefined {
  if (!bytes?.byteLength || bytes.byteLength > AGENT_HTTP_DIAGNOSTIC_MAX_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'error')) return undefined;
    const error: unknown = (value as {error:unknown}).error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const entries = error as Record<string,unknown>;
    const text = ['message','param','code','type'].map(field => typeof entries[field] === 'string' ? entries[field] : '').join('\n');
    const categories: (keyof typeof parameterCategories)[] = [];
    if (entries.code === 'invalid_request_error' || entries.type === 'invalid_request_error') categories.push('invalid_request');
    if (/\binvalid (?:json |function )?schema\b|\bschema (?:validation|error)\b/iu.test(text)) categories.push('schema');
    if (/\bunsupported (?:parameter|field|type|keyword)\b|\bnot (?:supported|allowed|permitted)\b/iu.test(text)) categories.push('unsupported');
    if (/\bmissing required\b|\brequired (?:field|property|parameter)\b|\bis required\b/iu.test(text)) categories.push('required');
    if (/\binvalid type\b|\btype mismatch\b/iu.test(text)) categories.push('type');
    if (/\binvalid (?:parameter|value)\b/iu.test(text)) categories.push('value');
    if (!categories.length) return undefined;
    const fields = parameterFields.filter(field => new RegExp(`(?:^|[^A-Za-z0-9_$])${field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[^A-Za-z0-9_$])`, 'u').test(text));
    const toolIndices: number[] = [];
    for (const match of text.matchAll(/\btools(?:\[(0|[1-9]\d{0,2})\]|\.(0|[1-9]\d{0,2}))(?=$|[.\s:])/gu)) {
      const index = Number(match[1] ?? match[2]);
      if (index < 128 && !toolIndices.includes(index) && toolIndices.length < 4) toolIndices.push(index);
    }
    return Object.freeze({fields:Object.freeze(fields),categories:Object.freeze(categories),toolIndices:Object.freeze(toolIndices)});
  } catch { return undefined; }
}
/** Narrow structural access to an arbitrary thrown value's `code`. */
export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code: unknown = (error as {code?: unknown}).code;
  return typeof code === 'string' ? code : undefined;
}
export function agentChatError(code: string = 'AGENT_CHAT_CONNECT_FAILED'): AgentChatFailure {
  const known = typeof code === 'string' && Object.hasOwn(errors, code);
  const resolved = (known ? code : 'AGENT_CHAT_CONNECT_FAILED') as AgentChatErrorCode;
  return Object.assign(new Error(errors[resolved][1]), {code: resolved, status: errors[resolved][0]});
}
/** Only transport-created errors retain a validated status, never response data. */
export function agentChatHttpError(statusCode: unknown, diagnosticBody?: Uint8Array): AgentChatFailure {
  const failure = agentChatError('AGENT_CHAT_HTTP_ERROR');
  if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 && (statusCode < 200 || statusCode >= 300)) {
    const hints = statusCode === 400 ? httpParameterHints(diagnosticBody) : undefined;
    httpEvidence.set(failure, {status:statusCode,...(hints ? {hints} : {})});
  }
  return failure;
}
/** Object properties, copies and wrapped causes cannot forge this evidence. */
export function agentChatHttpStatus(error: unknown): number | undefined {
  return error !== null && typeof error === 'object' ? httpEvidence.get(error)?.status : undefined;
}
export function safeAgentChatError(error: unknown): {code: AgentChatErrorCode; status: number; message: string} {
  const safe = agentChatError(errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
  const httpStatus = agentChatHttpStatus(error);
  if (safe.code === 'AGENT_CHAT_HTTP_ERROR' && httpStatus !== undefined) safe.message = `模型服务拒绝了请求（HTTP ${httpStatus}），请检查账户、模型和配置后手动重试。`;
  const hints = error !== null && typeof error === 'object' ? httpEvidence.get(error)?.hints : undefined;
  if (safe.code === 'AGENT_CHAT_HTTP_ERROR' && hints) safe.message += ` 服务返回的参数提示：${[
    hints.categories.map(category => parameterCategories[category]).join('、'),
    ...(hints.fields.length ? [`字段 ${hints.fields.join('、')}`] : []),
    ...(hints.toolIndices.length ? [`工具索引 ${hints.toolIndices.join('、')}`] : []),
  ].join('；')}。`;
  return {code: safe.code, status: safe.status, message: safe.message};
}
