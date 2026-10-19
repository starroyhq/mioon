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
export function safeAgentChatError(error: unknown): {code: AgentChatErrorCode; status: number; message: string} {
  const safe = agentChatError(errorCode(error) || 'AGENT_CHAT_CONNECT_FAILED');
  return {code: safe.code, status: safe.status, message: safe.message};
}
