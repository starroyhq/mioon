import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, MessageKey } from '../../../packages/i18n/src/index.ts';
import type { MessageArguments } from '../../../packages/i18n/src/index.ts';
import { AGENT_PROTOCOLS, deriveAgentEndpoint } from '@mioon/contracts';
import type { AgentEndpointConfiguration, AgentProtocol } from '../../../packages/contracts/src/agent-protocol.ts';
export { AGENT_PROTOCOLS, deriveAgentEndpoint };

// Agent settings are independent of video generation and project preferences.
// This module never caches credentials or sends requests to a model provider.
const fields = ['presetId', 'platformId', 'baseUrl', 'model', 'protocol'] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const optionalText = (value: unknown): string => typeof value === 'string' ? value : '';
export type Translate = <K extends MessageKey>(key: K, ...args: MessageArguments<K>) => string;
export type SecretStorage = 'none' | 'session' | 'persistent';
export interface AgentConfiguration { presetId: string; platformId: string; baseUrl: string; model: string; protocol: string }
export interface AgentProtocolConfiguration extends AgentConfiguration { protocol: AgentProtocol }
export interface AgentSettingsSource { label: string; url: string }
export interface AgentSettingsPlatform {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  defaultProtocol: AgentProtocol;
  availableProtocols: AgentProtocol[];
  supportedModelHints: Record<string, string[]>;
  protocolNotes: Record<string, string>;
  notes: string;
  baseUrlTemplate: string;
  sources: AgentSettingsSource[];
}
export interface AgentSettingsPreset { id: string; label: string; description: string; platforms: AgentSettingsPlatform[] }
export interface AgentSettingsSnapshot {
  revision: number;
  configuration: AgentProtocolConfiguration;
  secret: { configured: boolean; storage: SecretStorage };
  storage: { persistentAvailable: boolean; sessionScope: 'app' | 'server'; reasonCode: string | null };
  presets: AgentSettingsPreset[];
  scope: 'settings_only';
  verification: 'not_tested';
}
export type AgentSettingsPhase = 'loading' | 'ready' | 'saving' | 'reconciling' | 'review' | 'blocked' | 'load_error' | 'error' | 'saved';
export interface AgentSettingsState {
  phase: AgentSettingsPhase;
  snapshot: AgentSettingsSnapshot | null;
  draft: AgentConfiguration | null;
  secretAction: 'keep' | 'remove';
  storage: 'session' | 'persistent';
  message: string;
  displayMessages: DisplayMessage[];
  recovery: 'conflict' | 'unknown' | null;
}
export interface AgentSettingsClient { read: () => Promise<unknown>; write: (input: unknown) => Promise<unknown> }
export interface AgentSettingsSessionOptions { client?: AgentSettingsClient; onChange?: (state: AgentSettingsState) => void }

export const isAgentProtocol = (value: unknown): value is AgentProtocol => typeof value === 'string' && Object.hasOwn(AGENT_PROTOCOLS, value);
export const agentEndpointPreview = (configuration: AgentConfiguration): string => { try { return deriveAgentEndpoint(agentProtocolConfiguration(configuration) ?? configuration as AgentProtocolConfiguration); } catch { return ''; } };
export const agentConfiguration = (value: unknown): AgentConfiguration => {
  const source: Record<string, unknown> = record(value) ? value : {};
  return { presetId: text(source.presetId), platformId: text(source.platformId), baseUrl: text(source.baseUrl), model: text(source.model), protocol: text(source.protocol) };
};
/** Project the allowlisted string fields, then prove the protocol vocabulary is one of the closed values. */
export function agentProtocolConfiguration(value: unknown): AgentProtocolConfiguration | null {
  const configuration = agentConfiguration(value);
  return isAgentProtocol(configuration.protocol) ? { ...configuration, protocol: configuration.protocol } : null;
}
const failure = (code = 'NETWORK'): Error => Object.assign(new Error('Agent settings request did not complete.'), { code });
const codes = new Set(['UNAUTHORIZED', 'AGENT_SETTINGS_VALIDATION', 'AGENT_SETTINGS_CONFLICT', 'AGENT_SETTINGS_STORAGE_UNAVAILABLE', 'AGENT_SETTINGS_SAVE_FAILED', 'AGENT_SETTINGS_CORRUPT', 'AGENT_SETTINGS_CLOSED']);
const failureCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;
const normalizedBase = (value: string): string => {
  try { return new URL(value.trim()).href.replace(/\/+$/, ''); } catch { return value.trim(); }
};
const bindingFields = ['presetId', 'platformId'] as const;
export const agentBindingChanged = (saved: AgentConfiguration | null | undefined, draft: AgentConfiguration | null | undefined): boolean => !saved || bindingFields.some(key => saved[key] !== draft?.[key]) || normalizedBase(saved.baseUrl) !== normalizedBase(draft?.baseUrl ?? '');
export const agentConfigurationEqual = (left: Partial<AgentConfiguration> | null | undefined, right: Partial<AgentConfiguration> | null | undefined): boolean => fields.every(key => left?.[key] === right?.[key]);

// Project the allowlisted response, including on error recovery. Never surface
// arbitrary server fields/messages: an error can accidentally echo input secrets.
export function safeAgentSettings(value: unknown): AgentSettingsSnapshot {
  if (!record(value) || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw failure('INVALID_RESPONSE');
  const configurationValue = record(value.configuration) ? value.configuration : null;
  const secretValue = record(value.secret) ? value.secret : null;
  const storageValue = record(value.storage) ? value.storage : null;
  if (!configurationValue || !fields.every(key => typeof configurationValue[key] === 'string') || !isAgentProtocol(configurationValue.protocol) ||
      !secretValue || typeof secretValue.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(text(secretValue.storage)) ||
      (secretValue.configured === (secretValue.storage === 'none')) ||
      !storageValue || typeof storageValue.persistentAvailable !== 'boolean' || !['app', 'server'].includes(text(storageValue.sessionScope)) ||
      ![null, 'WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT'].includes(storageValue.reasonCode as string | null) ||
      value.scope !== 'settings_only' || value.verification !== 'not_tested' || !Array.isArray(value.presets) || !value.presets.length) throw failure('INVALID_RESPONSE');
  const configuration = agentProtocolConfiguration(configurationValue);
  if (!configuration) throw failure('INVALID_RESPONSE');
  try { deriveAgentEndpoint(configuration); } catch { throw failure('INVALID_RESPONSE'); }
  const presets = value.presets.map(presetValue => {
    const presetId = text(presetValue?.id), presetLabel = text(presetValue?.label);
    if (!record(presetValue) || !presetId || !presetLabel || !Array.isArray(presetValue.platforms) || !presetValue.platforms.length) throw failure('INVALID_RESPONSE');
    return { id: presetId, label: presetLabel, description: optionalText(presetValue.description), platforms: presetValue.platforms.map(platformValue => {
      if (!record(platformValue) || !text(platformValue.id) || !text(platformValue.label) || typeof platformValue.baseUrl !== 'string' || typeof platformValue.model !== 'string' ||
          !isAgentProtocol(platformValue.defaultProtocol) || !Array.isArray(platformValue.availableProtocols) || !platformValue.availableProtocols.length ||
          !platformValue.availableProtocols.every(isAgentProtocol) || new Set(platformValue.availableProtocols).size !== platformValue.availableProtocols.length ||
          !platformValue.availableProtocols.includes(platformValue.defaultProtocol)) throw failure('INVALID_RESPONSE');
      const availableProtocols = platformValue.availableProtocols as AgentProtocol[];
      const sources = (Array.isArray(platformValue.sources) ? platformValue.sources : []).flatMap(sourceValue => {
        try { const source = record(sourceValue) ? sourceValue : {}; const url = new URL(typeof source.url === 'string' ? source.url : ''); return url.protocol === 'https:' && !url.username && !url.password ? [{ label: optionalText(source.label) || '官方文档', url: url.href }] : []; } catch { return []; }
      });
      const supportedModelHints: Record<string, string[]> = {}, protocolNotes: Record<string, string> = {};
      const hintValues = record(platformValue.supportedModelHints) ? platformValue.supportedModelHints : {}, noteValues = record(platformValue.protocolNotes) ? platformValue.protocolNotes : {};
      for (const protocol of availableProtocols) {
        const hints = hintValues[protocol];
        if (hints !== undefined && (!Array.isArray(hints) || hints.length > 20 || !hints.every(model => typeof model === 'string' && model.length > 0 && model.length <= 200))) throw failure('INVALID_RESPONSE');
        if (hints) supportedModelHints[protocol] = [...hints as string[]];
        if (typeof noteValues[protocol] === 'string') protocolNotes[protocol] = (noteValues[protocol] as string).slice(0, 2000);
      }
      const platformId = text(platformValue.id), platformLabel = text(platformValue.label);
      return { id: platformId, label: platformLabel, baseUrl: platformValue.baseUrl, model: platformValue.model, defaultProtocol: platformValue.defaultProtocol, availableProtocols: [...availableProtocols], supportedModelHints, protocolNotes, notes: optionalText(platformValue.notes), baseUrlTemplate: optionalText(platformValue.baseUrlTemplate), sources };
    }) };
  });
  return { revision: value.revision, configuration,
    secret: { configured: secretValue.configured, storage: secretValue.storage as SecretStorage },
    storage: { persistentAvailable: storageValue.persistentAvailable, sessionScope: storageValue.sessionScope as 'app' | 'server', reasonCode: (storageValue.reasonCode as string | null) ?? null },
    presets, scope: 'settings_only', verification: 'not_tested' };
}

export function createAgentSettingsClient({ fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init), timeoutMs = 12000 }: { fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}) {
  async function request(method: string, body?: string): Promise<AgentSettingsSnapshot> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transport = (async () => {
      const response = await fetchImpl('/api/agent/settings', { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope: unknown;
      try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      const envelopeRecord = record(envelope) ? envelope : {};
      const errorRecord = record(envelopeRecord.error) ? envelopeRecord.error : {};
      if (!response.ok || envelopeRecord.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : codes.has(typeof errorRecord.code === 'string' ? errorRecord.code : '') ? errorRecord.code as string : 'NETWORK');
      return safeAgentSettings(envelopeRecord.data);
    })();
    try {
      return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
      })]) : await transport;
    } catch (error) { const code = failureCode(error); throw failure(code && (codes.has(code) || code === 'INVALID_RESPONSE') ? code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: () => request('GET'), write: (input: unknown) => request('PUT', JSON.stringify(input)) };
}

export const initialAgentSettingsState = (): AgentSettingsState => ({ phase: 'loading', snapshot: null, draft: null, secretAction: 'keep', storage: 'session', message: '', displayMessages: [], recovery: null });
export const agentSettingsBusy = (state: AgentSettingsState | null | undefined): boolean => Boolean(state && ['loading', 'saving', 'reconciling'].includes(state.phase));
export const agentSettingsEditable = (state: AgentSettingsState | null | undefined): boolean => Boolean(state?.snapshot) && !agentSettingsBusy(state);
export const agentSettingsCanSave = (state: AgentSettingsState | null | undefined): boolean => agentSettingsEditable(state) && Boolean(state && !state.recovery && state.phase !== 'blocked');
export const agentSettingsDirty = (state: AgentSettingsState | null | undefined): boolean => Boolean(state?.snapshot && (!agentConfigurationEqual(state.snapshot.configuration, state.draft) || state.secretAction === 'remove'));
export function agentSettingsIssue(draft: AgentConfiguration | null | undefined, secret = ''): string {
  if (!isAgentProtocol(draft?.protocol)) return '请选择明确的 API 协议。';
  if (!draft?.presetId || !draft?.platformId || !draft?.baseUrl.trim() || !draft?.model.trim()) return '请填写服务地址和模型名称。';
  if (draft.baseUrl.length > 2048 || draft.model.length > 200) return '服务地址最多 2048 个字符，模型名称最多 200 个字符。';
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '服务地址不能包含账号、密码、查询参数或片段。';
    if (draft.presetId !== 'ollama' && url.protocol !== 'https:') return '远程服务地址必须使用 HTTPS。';
  } catch { return '请输入完整的服务地址。'; }
  if (secret && (!secret.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(secret) || new TextEncoder().encode(secret).length > 8192)) return '密钥不能为空白、包含控制字符或超过 8192 字节。';
  return '';
}

const errorTexts: Record<string, string> = {
  UNAUTHORIZED: '登录会话已过期，请重新登录后打开设置。',
  AGENT_SETTINGS_VALIDATION: '设置未通过校验。请检查平台、服务地址、模型和密钥格式；内网地址不受支持，本机 Ollama 请使用专用预设。',
  AGENT_SETTINGS_STORAGE_UNAVAILABLE: '加密持久保存当前不可用。请查看最新存储状态，选择仅本次运行并重新输入密钥。',
  AGENT_SETTINGS_CORRUPT: '无法读取安全设置。请检查本机安全存储后重试，不会覆盖已有设置。',
  AGENT_SETTINGS_CLOSED: '设置服务已关闭，请重新打开应用后重试。',
};
const agentSettingsErrorKeys: Record<string, true> = Object.freeze({ UNAUTHORIZED: true, AGENT_SETTINGS_VALIDATION: true, AGENT_SETTINGS_STORAGE_UNAVAILABLE: true, AGENT_SETTINGS_CORRUPT: true, AGENT_SETTINGS_CLOSED: true });
const errorText = (code: string | undefined): string => code && Object.hasOwn(errorTexts, code) ? errorTexts[code] : '未收到保存确认，结果可能已经生效。';
const errorDescriptors: Record<string, DisplayMessage> = {
  UNAUTHORIZED: message('connections.error.unauthorized'),
  AGENT_SETTINGS_VALIDATION: message('agent.settings.error.validation'),
  AGENT_SETTINGS_STORAGE_UNAVAILABLE: message('agent.settings.error.storage'),
  AGENT_SETTINGS_CORRUPT: message('agent.settings.error.corrupt'),
  AGENT_SETTINGS_CLOSED: message('agent.settings.error.closed'),
};
const errorDescriptor = (code: string | undefined): DisplayMessage => code && Object.hasOwn(errorDescriptors, code) ? errorDescriptors[code] : message('connections.error.unknown');

/** A single settings-page lifetime. No secret is stored in state, recovery, or retries. */
export function createAgentSettingsSession({ client = createAgentSettingsClient(), onChange = () => {} }: AgentSettingsSessionOptions = {}) {
  let state = initialAgentSettingsState(), active = true, visible = true, epoch = 0;
  const publish = (patch: Partial<AgentSettingsState>): void => { if (!active) return; state = { ...state, ...patch }; onChange(state); };
  const current = (token: number): boolean => active && token === epoch;
  const editable = (): boolean => active && visible && agentSettingsEditable(state);
  function read({ recover = false }: { recover?: boolean } = {}): Promise<boolean> {
    if (!active || agentSettingsBusy(state) && state.phase !== 'loading') return Promise.resolve(false);
    const token = ++epoch;
    publish({ phase: recover ? 'reconciling' : 'loading', message: recover ? '正在重新读取服务器状态；不会再次提交。' : '', displayMessages: (recover ? [message('agent.settings.notice.rereading')] : []) });
    return Promise.resolve().then(() => client.read()).then(snapshot => {
      if (!current(token)) return false;
      const safe = safeAgentSettings(snapshot);
      publish({ snapshot: safe, draft: recover && state.draft ? state.draft : { ...safe.configuration }, phase: recover ? 'review' : 'ready',
        secretAction: 'keep', storage: safe.secret.storage === 'persistent' && safe.storage.persistentAvailable ? 'persistent' : 'session',
        recovery: recover ? state.recovery || 'unknown' : null,
        message: recover ? '已重新读取当前状态。草稿仍保留；请核对后继续，替换密钥需要重新输入。' : '', displayMessages: (recover ? [message('agent.settings.notice.review')] : []) });
      return true;
    }).catch((error: unknown) => {
      if (!current(token)) return false;
      const code = failureCode(error);
      publish({ phase: recover ? 'blocked' : 'load_error', message: recover ? '暂时无法核实保存结果。草稿已保留，请重新读取状态后再保存。' : !code || !Object.hasOwn(agentSettingsErrorKeys, code) ? '暂时无法读取 Agent 设置，请检查工作台连接后重试。' : errorText(code), displayMessages: (recover ? [message('agent.settings.notice.blocked')] : (!code || !Object.hasOwn(agentSettingsErrorKeys, code) ? [message('agent.settings.notice.loadError')] : [errorDescriptor(code)])) });
      return false;
    });
  }
  function edit(patch: Partial<AgentConfiguration>): boolean {
    if (!editable()) return false;
    const draft = agentConfiguration({ ...state.draft, ...patch });
    publish({ draft, message: state.recovery ? state.message : '', displayMessages: (state.recovery ? state.displayMessages : []), phase: state.recovery ? state.phase : 'ready' });
    return true;
  }
  function selectPreset(id: string): boolean {
    const preset = state.snapshot?.presets.find(item => item.id === id), platform = preset?.platforms[0];
    return preset && platform ? edit({ presetId: preset.id, platformId: platform.id, baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }) : false;
  }
  function selectPlatform(id: string): boolean {
    const platform = state.snapshot?.presets.find(item => item.id === state.draft?.presetId)?.platforms.find(item => item.id === id);
    return platform ? edit({ platformId: platform.id, baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }) : false;
  }
  function useLatest(): boolean {
    if (!editable() || state.phase === 'blocked') return false;
    const snapshot = state.snapshot;
    if (!snapshot) return false;
    publish({ draft: { ...snapshot.configuration }, secretAction: 'keep', phase: 'ready', recovery: null, message: '已使用当前已保存设置。', displayMessages: [message('connections.notice.useSaved')] });
    return true;
  }
  function acknowledge(): boolean {
    if (!editable() || state.phase !== 'review' || !state.recovery) return false;
    publish({ recovery: null, phase: 'ready', message: '已保留草稿。请确认目标与密钥操作，再点击保存。', displayMessages: [message('agent.settings.notice.keepDraft')] }); return true;
  }
  function save(value = ''): Promise<boolean> {
    const snapshot = state.snapshot, draft = state.draft;
    if (!active || !visible || !agentSettingsCanSave(state) || !snapshot || !draft) return Promise.resolve(false);
    const platform = snapshot.presets.find(item => item.id === draft.presetId)?.platforms.find(item => item.id === draft.platformId);
    const issue = agentSettingsIssue(draft, value) || (platform && !platform.availableProtocols.includes(draft.protocol as AgentProtocol) ? '此平台尚未提供所选协议配置，请明确选择可用协议。' : ''), issueDisplayMessage = agentSettingsIssueDescriptor(draft, value) || (platform && !platform.availableProtocols.includes(draft.protocol as AgentProtocol) ? message('agent.settings.issue.platformProtocol') : null);
    if (issue) { publish({ phase: 'error', message: issue, displayMessages: issueDisplayMessage ? [issueDisplayMessage] : [] }); return Promise.resolve(false); }
    if (value && state.storage === 'persistent' && !snapshot.storage.persistentAvailable) {
      publish({ phase: 'error', message: errorText('AGENT_SETTINGS_STORAGE_UNAVAILABLE'), displayMessages: [errorDescriptor('AGENT_SETTINGS_STORAGE_UNAVAILABLE')] }); return Promise.resolve(false);
    }
    const token = ++epoch, configuration = agentConfiguration(draft), revision = snapshot.revision;
    configuration.baseUrl = configuration.baseUrl.trim(); configuration.model = configuration.model.trim();
    const secret = value ? { action: 'replace', value, storage: state.storage } : { action: state.secretAction === 'remove' || agentBindingChanged(snapshot.configuration, configuration) ? 'remove' : 'keep' };
    const expectedSecret = secret.action === 'replace' ? { configured: true, storage: state.storage } : secret.action === 'remove' ? { configured: false, storage: 'none' } : { ...snapshot.secret };
    publish({ phase: 'saving', message: '正在保存连接设置…', displayMessages: [message('agent.settings.notice.saving')], secretAction: 'keep' });
    let operation: Promise<unknown>;
    try { operation = client.write({ expectedRevision: revision, configuration, secret }); } catch (error) { operation = Promise.reject(error); }
    // No value is captured in any of the completion/recovery handlers.
    return Promise.resolve(operation).then(snapshotValue => {
      if (!current(token)) return false;
      const safe = safeAgentSettings(snapshotValue);
      if (safe.revision !== revision + 1 || !agentConfigurationEqual(safe.configuration, { ...configuration, baseUrl: normalizedBase(configuration.baseUrl) }) ||
          safe.secret.configured !== expectedSecret.configured || safe.secret.storage !== expectedSecret.storage) throw failure('INVALID_RESPONSE');
      publish({ snapshot: safe, draft: { ...safe.configuration }, phase: 'saved', recovery: null,
        storage: safe.secret.storage === 'persistent' ? 'persistent' : state.storage,
        message: safe.secret.configured ? `连接设置已保存；${safe.secret.storage === 'persistent' ? '密钥由系统加密保存' : '密钥仅在本次运行保留'}。尚未验证连接。` : '连接设置已保存；未保存 API 密钥。尚未验证连接。', displayMessages: (safe.secret.configured ? [message(safe.secret.storage === 'persistent' ? 'agent.settings.notice.savedPersistent' : 'agent.settings.notice.savedSession')] : [message('agent.settings.notice.savedNone')]) });
      return true;
    }).catch((error: unknown) => {
      if (!current(token)) return false;
      const code = failureCode(error);
      if (code === 'UNAUTHORIZED' || code === 'AGENT_SETTINGS_VALIDATION') {
        publish({ phase: 'error', message: `${errorText(code)}${code === 'UNAUTHORIZED' ? '' : ' 新输入的密钥已清空，如需替换请重新输入。'}`, displayMessages: [errorDescriptor(code), ...(code === 'UNAUTHORIZED' ? [] : [message('agent.settings.notice.keyCleared')])] }); return false;
      }
      const recovery = code === 'AGENT_SETTINGS_CONFLICT' ? 'conflict' : 'unknown';
      publish({ phase: 'reconciling', recovery, message: recovery === 'conflict' ? '设置已在其他窗口更新，正在读取最新状态。' : `${errorText(code)}正在读取当前状态，不会自动重试。`, displayMessages: (recovery === 'conflict' ? [message('agent.settings.notice.conflictReading')] : [errorDescriptor(code), message('agent.settings.notice.readNoRetry')]) });
      return Promise.resolve().then(() => client.read()).then(snapshotValue => {
        if (!current(token)) return false;
        const safe = safeAgentSettings(snapshotValue);
        publish({ snapshot: safe, phase: 'review', storage: state.storage === 'persistent' && !safe.storage.persistentAvailable ? 'session' : state.storage,
          message: recovery === 'conflict' ? '保存冲突：已读取其他窗口的最新设置。你的连接草稿仍保留；请核对后继续，替换密钥需要重新输入。' : '未收到保存确认。已读取当前服务器状态，未自动重试；请核对后继续，替换密钥需要重新输入。', displayMessages: (recovery === 'conflict' ? [message('agent.settings.notice.conflict')] : [message('agent.settings.notice.unknown')]) });
        return false;
      }).catch(() => { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿已保留，请重新读取状态后再保存。', displayMessages: [message('agent.settings.notice.blocked')] }); return false; });
    });
  }
  return { getState: (): AgentSettingsState => state, load: () => read(), reload: () => read({ recover: Boolean(state.snapshot) }), edit, selectPreset, selectPlatform, useLatest, acknowledge, save,
    setVisible(value: boolean): void { visible = Boolean(value); },
    setStorage(storage: string): boolean { const snapshot = state.snapshot; if (!editable() || (storage !== 'session' && storage !== 'persistent') || storage === 'persistent' && !snapshot?.storage.persistentAvailable) return false; publish({ storage }); return true; },
    removeKey(remove = true): boolean { if (!editable()) return false; publish({ secretAction: remove ? 'remove' : 'keep', phase: state.recovery ? state.phase : 'ready', message: state.recovery ? state.message : '', displayMessages: (state.recovery ? state.displayMessages : []) }); return true; },
    dispose(): void { active = false; epoch++; state = initialAgentSettingsState(); },
  };
}

// Display descriptors are transient UI metadata. Legacy diagnostics and request payloads remain unchanged.
export function agentSettingsIssueDescriptor(draft: AgentConfiguration | null | undefined, secret = ''): DisplayMessage | null {
  if (!isAgentProtocol(draft?.protocol)) return message('agent.settings.issue.protocol');
  if (!draft?.presetId || !draft?.platformId || !draft?.baseUrl.trim() || !draft?.model.trim()) return message('agent.settings.issue.required');
  if (draft.baseUrl.length > 2048 || draft.model.length > 200) return message('agent.settings.issue.length');
  try {
    const url = new URL(draft.baseUrl.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return message('agent.settings.issue.urlParts');
    if (draft.presetId !== 'ollama' && url.protocol !== 'https:') return message('agent.settings.issue.https');
  } catch { return message('agent.settings.issue.url'); }
  if (secret && (!secret.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(secret) || new TextEncoder().encode(secret).length > 8192)) return message('agent.settings.issue.key');
  return null;
}

const presetNames: Record<string, string> = Object.freeze({ openai: 'OpenAI', deepseek: 'DeepSeek', qwen: 'Qwen / DashScope', zhipu: 'Zhipu / Z.ai', kimi: 'Kimi / Moonshot', minimax: 'MiniMax', openrouter: 'OpenRouter' });
export const agentPresetLabel = (preset: { id: string }, t: Translate): string => preset.id === 'custom' ? t('agent.settings.presets.custom') : preset.id === 'ollama' ? t('agent.settings.presets.ollama') : (Object.hasOwn(presetNames, preset.id) ? presetNames[preset.id] : preset.id);
const platformKeys: Record<string, MessageKey> = Object.freeze({ beijing: 'agent.settings.platform.beijing', singapore: 'agent.settings.platform.singapore', 'workspace-cn-beijing': 'agent.settings.platform.workspaceBeijing', 'workspace-ap-southeast-1': 'agent.settings.platform.workspaceSingapore', 'workspace-us-east-1': 'agent.settings.platform.workspaceUs', 'workspace-cn-hongkong': 'agent.settings.platform.workspaceHongkong', 'workspace-ap-northeast-1': 'agent.settings.platform.workspaceTokyo', 'workspace-eu-central-1': 'agent.settings.platform.workspaceFrankfurt', custom: 'agent.settings.platform.custom', local: 'agent.settings.platform.local' });
export function agentPlatformLabel(presetId: string, platform: { id: string }, t: Translate): string {
  if (Object.hasOwn(platformKeys, platform.id)) return t(platformKeys[platform.id]);
  const brand = presetId === 'zhipu' ? platform.id === 'china' ? 'BigModel' : 'Z.ai' : presetId === 'kimi' ? 'Moonshot' : presetId === 'minimax' ? 'MiniMax' : null;
  if (brand && ['china', 'international'].includes(platform.id)) return t(platform.id === 'china' ? 'agent.settings.platform.china' : 'agent.settings.platform.international', { brand });
  return presetId === 'openai' ? 'OpenAI' : presetId === 'deepseek' ? 'DeepSeek API' : presetId === 'openrouter' ? 'OpenRouter' : platform.id;
}
const presetNoteKeys: Record<string, MessageKey> = Object.freeze({ openai: 'agent.settings.presets.openaiNote', deepseek: 'agent.settings.presets.deepseekNote', qwen: 'agent.settings.presets.qwenNote', zhipu: 'agent.settings.presets.zhipuNote', kimi: 'agent.settings.presets.kimiNote', minimax: 'agent.settings.presets.minimaxNote', openrouter: 'agent.settings.presets.openrouterNote', custom: 'agent.settings.presets.customNote', ollama: 'agent.settings.presets.ollamaNote' });
export const agentPresetNote = (preset: { id: string } | null | undefined, platform: { id?: string } | null | undefined, t: Translate): string => t(typeof preset?.id === 'string' && preset.id === 'qwen' && typeof platform?.id === 'string' && platform.id.startsWith('workspace-') ? 'agent.settings.presets.qwenWorkspace' : (typeof preset?.id === 'string' && Object.hasOwn(presetNoteKeys, preset.id) ? presetNoteKeys[preset.id] : 'agent.settings.presetFallback'));
