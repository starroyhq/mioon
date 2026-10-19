// Documentation-backed starting values only. This catalog performs no network I/O.
// Account/model access and protocol compatibility remain untested.
const source = (label, url) => ({label, url});
const platform = (id, label, baseUrl, model, sources, notes, baseUrlTemplate) => ({id, label, baseUrl, model, sources, ...(notes ? {notes} : {}), ...(baseUrlTemplate ? {baseUrlTemplate} : {})});
const qwenSources = [source('官方端点与区域', 'https://www.alibabacloud.com/help/en/model-studio/base-url'), source('Responses API', 'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses')];
const catalog = [
  {id: 'openai', label: 'OpenAI', description: '非推理文本基线；可明确选择 Chat Completions 或 Responses。', platforms: [platform('global', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4.1-mini', [source('模型文档', 'https://developers.openai.com/api/docs/models/gpt-4.1-mini')])]},
  {id: 'deepseek', label: 'DeepSeek', description: '非思考模式文本基线；可明确选择 Chat Completions 或 Responses。', platforms: [platform('global', 'DeepSeek API', 'https://api.deepseek.com', 'deepseek-flash', [source('Chat API', 'https://api-docs.deepseek.com/api/create-chat-completion/'), source('Responses API', 'https://api-docs.deepseek.com/guides/responses_api/')])]},
  {id: 'qwen', label: 'Qwen / DashScope', description: '区域、工作空间和按量付费账户必须匹配；不继承 Coding Plan 凭证。', platforms: [
    platform('beijing', '北京 · 按量付费', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', qwenSources),
    platform('singapore', '新加坡 · 按量付费', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-plus', qwenSources),
    ...[['cn-beijing', '北京'], ['ap-southeast-1', '新加坡'], ['us-east-1', '美国东部'], ['cn-hongkong', '香港'], ['ap-northeast-1', '东京'], ['eu-central-1', '法兰克福']].map(([region, label]) => platform(`workspace-${region}`, `${label} · 工作空间端点`, '', 'qwen-plus', qwenSources, '请填写账户实际工作空间端点；模板不是可直接使用的地址。', `https://{WorkspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1`)),
  ]},
  {id: 'zhipu', label: 'Zhipu / Z.ai', description: '中国 BigModel 与国际 Z.ai 是独立平台，密钥不假定通用。', platforms: [
    platform('china', '中国 · BigModel', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.7', [source('中国平台', 'https://docs.bigmodel.cn/cn/guide/start/quick-start')]),
    platform('international', '国际 · Z.ai', 'https://api.z.ai/api/paas/v4', 'glm-4.7', [source('国际 Chat API', 'https://docs.z.ai/api-reference/llm/chat-completion')]),
  ]},
  {id: 'kimi', label: 'Kimi / Moonshot', description: 'K2.6 非思考模式基线；区域账户分别配置。', platforms: [
    platform('china', '中国 · Moonshot', 'https://api.moonshot.cn/v1', 'kimi-k2.6', [source('中国平台', 'https://platform.kimi.com/docs/get-api-key')]),
    platform('international', '国际 · Moonshot', 'https://api.moonshot.ai/v1', 'kimi-k2.6', [source('模型文档', 'https://platform.kimi.ai/docs/api/models-overview')]),
  ]},
  {id: 'minimax', label: 'MiniMax', description: 'MiniMax-M3 非思考模式基线；不自动切换到套餐专用模型。', platforms: [
    platform('china', '中国 · MiniMax', 'https://api.minimax.cn/v1', 'MiniMax-M3', [source('中国兼容接口', 'https://platform.minimax.cn/docs/api-reference/text-openai-api')]),
    platform('international', '国际 · MiniMax', 'https://api.minimax.io/v1', 'MiniMax-M3', [source('国际兼容接口', 'https://platform.minimax.io/docs/api-reference/text-openai-api')]),
  ]},
  {id: 'openrouter', label: 'OpenRouter', description: '实际能力取决于所选模型和路由供应商。', platforms: [platform('global', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai/gpt-4.1-mini', [source('模型文档', 'https://openrouter.ai/openai/gpt-4.1-mini')])]},
  {id: 'custom', label: '自定义兼容服务', description: '仅远程 HTTPS；地址和模型由你填写，兼容性未验证。', platforms: [platform('custom', '自定义 · 远程 HTTPS', '', '', [])]},
  {id: 'ollama', label: 'Ollama 本地', description: '仅本机回环 /v1；通常无需密钥，不下载模型，不包含云端路由授权。', platforms: [platform('local', '本机 · Ollama', 'http://127.0.0.1:11434/v1', 'qwen3:8b', [source('OpenAI 兼容接口', 'https://docs.ollama.com/api/openai-compatibility')])]},
];
function freeze(value) { for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item); return Object.freeze(value); }
// These choices describe implemented request/parser profiles, not vendor-wide
// availability or a live compatibility certification. Defaults stay unchanged.
const responseModelHints = {
  openai: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'],
  deepseek: ['deepseek-flash'],
  qwen: ['qwen3.8-flash'],
  custom: [],
  ollama: ['qwen3:8b'],
};
export const AGENT_PRESETS = freeze(catalog.map(preset => {
  const hasResponses = Object.hasOwn(responseModelHints, preset.id);
  const protocols = {
    defaultProtocol: 'chat_completions',
    availableProtocols: hasResponses ? ['chat_completions', 'responses'] : ['chat_completions'],
    ...(hasResponses ? {supportedModelHints: {responses: responseModelHints[preset.id]}} : {}),
    ...(preset.id === 'qwen' ? {protocolNotes: {responses: '仅 qwen3.8-flash 非思考文本配置；本应用限制上下文大小，但供应商自动截断无法禁用。区域、工作空间与账户权限须匹配，未经真实调用验证。'}} : {}),
  };
  return {...preset, ...protocols, platforms: preset.platforms.map(item => ({...item, ...protocols}))};
}));
export const DEFAULT_AGENT_CONFIGURATION = Object.freeze({presetId: 'openai', platformId: 'global', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions'});
