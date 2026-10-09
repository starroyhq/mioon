// Never reflect provider bodies, headers, URLs, keys, socket errors or causes.
const errors = Object.freeze({
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
  AGENT_CHAT_TOOLS_UNSUPPORTED: [422, '模型尝试调用工具；当前阶段仅支持文本聊天，未执行任何工具。'],
  AGENT_CHAT_REASONING_UNSUPPORTED: [422, '模型返回了推理或续接数据；当前阶段仅支持非思考文本模式。'],
  AGENT_CHAT_PROVIDER_ERROR: [502, '模型服务在回复过程中报告错误，已保留收到的文本。'],
});
export function agentChatError(code = 'AGENT_CHAT_CONNECT_FAILED') {
  if (typeof code !== 'string' || !Object.hasOwn(errors, code)) code = 'AGENT_CHAT_CONNECT_FAILED';
  return Object.assign(new Error(errors[code][1]), {code, status: errors[code][0]});
}
export function safeAgentChatError(error) {
  const safe = agentChatError(error?.code);
  return {code: safe.code, status: safe.status, message: safe.message};
}
