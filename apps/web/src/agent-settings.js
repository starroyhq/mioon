import { AGENT_PROTOCOLS, deriveAgentEndpoint } from '@mioon/contracts';
export { AGENT_PROTOCOLS, deriveAgentEndpoint };

// Agent settings are independent of video generation and project preferences.
// This module never caches credentials or sends requests to a model provider.
const fields = ['presetId', 'platformId', 'baseUrl', 'model', 'protocol'];
export const isAgentProtocol = value => typeof value === 'string' && Object.hasOwn(AGENT_PROTOCOLS, value);
export const agentEndpointPreview = configuration => { try { return deriveAgentEndpoint(configuration); } catch { return ''; } };
export const agentConfiguration = value => Object.fromEntries(fields.map(key => [key, typeof value?.[key] === 'string' ? value[key] : '']));
const failure = (code = 'NETWORK') => Object.assign(new Error('Agent settings request did not complete.'), { code });
const codes = new Set(['UNAUTHORIZED', 'AGENT_SETTINGS_VALIDATION', 'AGENT_SETTINGS_CONFLICT', 'AGENT_SETTINGS_STORAGE_UNAVAILABLE', 'AGENT_SETTINGS_SAVE_FAILED', 'AGENT_SETTINGS_CORRUPT', 'AGENT_SETTINGS_CLOSED']);
const text = value => typeof value === 'string' ? value : '';
const normalizedBase = value => {
  try { return new URL(value.trim()).href.replace(/\/+$/, ''); } catch { return value.trim(); }
};
export const agentBindingChanged = (saved, draft) => !saved || ['presetId', 'platformId'].some(key => saved[key] !== draft[key]) || normalizedBase(saved.baseUrl) !== normalizedBase(draft.baseUrl);
export const agentConfigurationEqual = (left, right) => fields.every(key => left?.[key] === right?.[key]);

// Project the allowlisted response, including on error recovery. Never surface
// arbitrary server fields/messages: an error can accidentally echo input secrets.
export function safeAgentSettings(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !value.configuration || !fields.every(key => typeof value.configuration[key] === 'string') || !isAgentProtocol(value.configuration.protocol) ||
      typeof value.secret?.configured !== 'boolean' || !['none', 'session', 'persistent'].includes(value.secret.storage) ||
      (value.secret.configured === (value.secret.storage === 'none')) ||
      typeof value.storage?.persistentAvailable !== 'boolean' || !['app', 'server'].includes(value.storage.sessionScope) ||
      ![null, 'WEB_SESSION_ONLY', 'OS_SECRET_STORE_UNAVAILABLE', 'LINUX_BASIC_TEXT'].includes(value.storage.reasonCode) ||
      value.scope !== 'settings_only' || value.verification !== 'not_tested' || !Array.isArray(value.presets) || !value.presets.length) throw failure('INVALID_RESPONSE');
  try { deriveAgentEndpoint(value.configuration); } catch { throw failure('INVALID_RESPONSE'); }
  const presets = value.presets.map(preset => {
    if (!preset || !text(preset.id) || !text(preset.label) || !Array.isArray(preset.platforms) || !preset.platforms.length) throw failure('INVALID_RESPONSE');
    return { id: preset.id, label: preset.label, description: text(preset.description), platforms: preset.platforms.map(platform => {
      if (!platform || !text(platform.id) || !text(platform.label) || typeof platform.baseUrl !== 'string' || typeof platform.model !== 'string' ||
          !isAgentProtocol(platform.defaultProtocol) || !Array.isArray(platform.availableProtocols) || !platform.availableProtocols.length ||
          !platform.availableProtocols.every(isAgentProtocol) || new Set(platform.availableProtocols).size !== platform.availableProtocols.length ||
          !platform.availableProtocols.includes(platform.defaultProtocol)) throw failure('INVALID_RESPONSE');
      const sources = (Array.isArray(platform.sources) ? platform.sources : []).flatMap(source => {
        try { const url = new URL(source.url); return url.protocol === 'https:' && !url.username && !url.password ? [{ label: text(source.label) || '官方文档', url: url.href }] : []; } catch { return []; }
      });
      const supportedModelHints = {}, protocolNotes = {};
      for (const protocol of platform.availableProtocols) {
        const hints = platform.supportedModelHints?.[protocol];
        if (hints !== undefined && (!Array.isArray(hints) || hints.length > 20 || !hints.every(model => typeof model === 'string' && model.length > 0 && model.length <= 200))) throw failure('INVALID_RESPONSE');
        if (hints) supportedModelHints[protocol] = [...hints];
        if (typeof platform.protocolNotes?.[protocol] === 'string') protocolNotes[protocol] = platform.protocolNotes[protocol].slice(0, 2000);
      }
      return { id: platform.id, label: platform.label, baseUrl: platform.baseUrl, model: platform.model, defaultProtocol: platform.defaultProtocol, availableProtocols: [...platform.availableProtocols], supportedModelHints, protocolNotes, notes: text(platform.notes), baseUrlTemplate: text(platform.baseUrlTemplate), sources };
    }) };
  });
  return { revision: value.revision, configuration: agentConfiguration(value.configuration),
    secret: { configured: value.secret.configured, storage: value.secret.storage },
    storage: { persistentAvailable: value.storage.persistentAvailable, sessionScope: value.storage.sessionScope, reasonCode: value.storage.reasonCode },
    presets, scope: 'settings_only', verification: 'not_tested' };
}

export function createAgentSettingsClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 12000 } = {}) {
  async function request(method, body) {
    const abort = new AbortController();
    let timer;
    const transport = (async () => {
      const response = await fetchImpl('/api/agent/settings', { method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope;
      try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || envelope?.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : codes.has(envelope?.error?.code) ? envelope.error.code : 'NETWORK');
      return safeAgentSettings(envelope.data);
    })();
    try {
      return timeoutMs > 0 ? await Promise.race([transport, new Promise((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(failure('NETWORK')); }, timeoutMs);
      })]) : await transport;
    } catch (error) { throw failure(codes.has(error?.code) || error?.code === 'INVALID_RESPONSE' ? error.code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: () => request('GET'), write: input => request('PUT', JSON.stringify(input)) };
}

export const initialAgentSettingsState = () => ({ phase: 'loading', snapshot: null, draft: null, secretAction: 'keep', storage: 'session', message: '', recovery: null });
export const agentSettingsBusy = state => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const agentSettingsEditable = state => Boolean(state.snapshot) && !agentSettingsBusy(state);
export const agentSettingsCanSave = state => agentSettingsEditable(state) && !state.recovery && state.phase !== 'blocked';
export const agentSettingsDirty = state => Boolean(state.snapshot && (!agentConfigurationEqual(state.snapshot.configuration, state.draft) || state.secretAction === 'remove'));
export function agentSettingsIssue(draft, secret = '') {
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

const errorText = code => ({
  UNAUTHORIZED: '登录会话已过期，请重新登录后打开设置。',
  AGENT_SETTINGS_VALIDATION: '设置未通过校验。请检查平台、服务地址、模型和密钥格式；内网地址不受支持，本机 Ollama 请使用专用预设。',
  AGENT_SETTINGS_STORAGE_UNAVAILABLE: '加密持久保存当前不可用。请查看最新存储状态，选择仅本次运行并重新输入密钥。',
  AGENT_SETTINGS_CORRUPT: '无法读取安全设置。请检查本机安全存储后重试，不会覆盖已有设置。',
  AGENT_SETTINGS_CLOSED: '设置服务已关闭，请重新打开应用后重试。',
}[code] || '未收到保存确认，结果可能已经生效。');

/** A single settings-page lifetime. No secret is stored in state, recovery, or retries. */
export function createAgentSettingsSession({ client = createAgentSettingsClient(), onChange = () => {} } = {}) {
  let state = initialAgentSettingsState(), active = true, visible = true, epoch = 0;
  const publish = patch => { if (!active) return; state = { ...state, ...patch }; onChange(state); };
  const current = token => active && token === epoch;
  const editable = () => active && visible && agentSettingsEditable(state);
  function read({ recover = false } = {}) {
    if (!active || agentSettingsBusy(state) && state.phase !== 'loading') return Promise.resolve(false);
    const token = ++epoch;
    publish({ phase: recover ? 'reconciling' : 'loading', message: recover ? '正在重新读取服务器状态；不会再次提交。' : '' });
    return Promise.resolve().then(() => client.read()).then(snapshot => {
      if (!current(token)) return false;
      const safe = safeAgentSettings(snapshot);
      publish({ snapshot: safe, draft: recover && state.draft ? state.draft : { ...safe.configuration }, phase: recover ? 'review' : 'ready',
        secretAction: 'keep', storage: safe.secret.storage === 'persistent' && safe.storage.persistentAvailable ? 'persistent' : 'session',
        recovery: recover ? state.recovery || 'unknown' : null,
        message: recover ? '已重新读取当前状态。草稿仍保留；请核对后继续，替换密钥需要重新输入。' : '' });
      return true;
    }).catch(error => {
      if (!current(token)) return false;
      publish({ phase: recover ? 'blocked' : 'load_error', message: recover ? '暂时无法核实保存结果。草稿已保留，请重新读取状态后再保存。' : errorText(error?.code) === '未收到保存确认，结果可能已经生效。' ? '暂时无法读取 Agent 设置，请检查工作台连接后重试。' : errorText(error?.code) });
      return false;
    });
  }
  function edit(patch) {
    if (!editable()) return false;
    const draft = agentConfiguration({ ...state.draft, ...patch });
    publish({ draft, message: state.recovery ? state.message : '', phase: state.recovery ? state.phase : 'ready' });
    return true;
  }
  function selectPreset(id) {
    const preset = state.snapshot?.presets.find(item => item.id === id), platform = preset?.platforms[0];
    return platform ? edit({ presetId: preset.id, platformId: platform.id, baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }) : false;
  }
  function selectPlatform(id) {
    const platform = state.snapshot?.presets.find(item => item.id === state.draft?.presetId)?.platforms.find(item => item.id === id);
    return platform ? edit({ platformId: platform.id, baseUrl: platform.baseUrl, model: platform.model, protocol: platform.defaultProtocol }) : false;
  }
  function useLatest() {
    if (!editable() || state.phase === 'blocked') return false;
    publish({ draft: { ...state.snapshot.configuration }, secretAction: 'keep', phase: 'ready', recovery: null, message: '已使用当前已保存设置。' });
    return true;
  }
  function acknowledge() {
    if (!editable() || state.phase !== 'review' || !state.recovery) return false;
    publish({ recovery: null, phase: 'ready', message: '已保留草稿。请确认目标与密钥操作，再点击保存。' }); return true;
  }
  function save(value = '') {
    if (!active || !visible || !agentSettingsCanSave(state)) return Promise.resolve(false);
    const platform = state.snapshot.presets.find(item => item.id === state.draft.presetId)?.platforms.find(item => item.id === state.draft.platformId);
    const issue = agentSettingsIssue(state.draft, value) || (platform && !platform.availableProtocols.includes(state.draft.protocol) ? '此平台尚未提供所选协议配置，请明确选择可用协议。' : '');
    if (issue) { publish({ phase: 'error', message: issue }); return Promise.resolve(false); }
    if (value && state.storage === 'persistent' && !state.snapshot.storage.persistentAvailable) {
      publish({ phase: 'error', message: errorText('AGENT_SETTINGS_STORAGE_UNAVAILABLE') }); return Promise.resolve(false);
    }
    const token = ++epoch, configuration = agentConfiguration(state.draft), revision = state.snapshot.revision;
    configuration.baseUrl = configuration.baseUrl.trim(); configuration.model = configuration.model.trim();
    const secret = value ? { action: 'replace', value, storage: state.storage } : { action: state.secretAction === 'remove' || agentBindingChanged(state.snapshot.configuration, configuration) ? 'remove' : 'keep' };
    const expectedSecret = secret.action === 'replace' ? { configured: true, storage: state.storage } : secret.action === 'remove' ? { configured: false, storage: 'none' } : { ...state.snapshot.secret };
    publish({ phase: 'saving', message: '正在保存连接设置…', secretAction: 'keep' });
    let operation;
    try { operation = client.write({ expectedRevision: revision, configuration, secret }); } catch (error) { operation = Promise.reject(error); }
    // No value is captured in any of the completion/recovery handlers.
    return Promise.resolve(operation).then(snapshot => {
      if (!current(token)) return false;
      const safe = safeAgentSettings(snapshot);
      if (safe.revision !== revision + 1 || !agentConfigurationEqual(safe.configuration, { ...configuration, baseUrl: normalizedBase(configuration.baseUrl) }) ||
          safe.secret.configured !== expectedSecret.configured || safe.secret.storage !== expectedSecret.storage) throw failure('INVALID_RESPONSE');
      publish({ snapshot: safe, draft: { ...safe.configuration }, phase: 'saved', recovery: null,
        storage: safe.secret.storage === 'persistent' ? 'persistent' : state.storage,
        message: safe.secret.configured ? `连接设置已保存；${safe.secret.storage === 'persistent' ? '密钥由系统加密保存' : '密钥仅在本次运行保留'}。尚未验证连接。` : '连接设置已保存；未保存 API 密钥。尚未验证连接。' });
      return true;
    }).catch(error => {
      if (!current(token)) return false;
      if (['UNAUTHORIZED', 'AGENT_SETTINGS_VALIDATION'].includes(error?.code)) {
        publish({ phase: 'error', message: `${errorText(error.code)}${error.code === 'UNAUTHORIZED' ? '' : ' 新输入的密钥已清空，如需替换请重新输入。'}` }); return false;
      }
      const recovery = error?.code === 'AGENT_SETTINGS_CONFLICT' ? 'conflict' : 'unknown';
      publish({ phase: 'reconciling', recovery, message: recovery === 'conflict' ? '设置已在其他窗口更新，正在读取最新状态。' : `${errorText(error?.code)}正在读取当前状态，不会自动重试。` });
      return Promise.resolve().then(() => client.read()).then(snapshot => {
        if (!current(token)) return false;
        const safe = safeAgentSettings(snapshot);
        publish({ snapshot: safe, phase: 'review', storage: state.storage === 'persistent' && !safe.storage.persistentAvailable ? 'session' : state.storage,
          message: recovery === 'conflict' ? '保存冲突：已读取其他窗口的最新设置。你的连接草稿仍保留；请核对后继续，替换密钥需要重新输入。' : '未收到保存确认。已读取当前服务器状态，未自动重试；请核对后继续，替换密钥需要重新输入。' });
        return false;
      }).catch(() => { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿已保留，请重新读取状态后再保存。' }); return false; });
    });
  }
  return { getState: () => state, load: () => read(), reload: () => read({ recover: Boolean(state.snapshot) }), edit, selectPreset, selectPlatform, useLatest, acknowledge, save,
    setVisible(value) { visible = Boolean(value); },
    setStorage(storage) { if (!editable() || !['session', 'persistent'].includes(storage) || storage === 'persistent' && !state.snapshot.storage.persistentAvailable) return false; publish({ storage }); return true; },
    removeKey(remove = true) { if (!editable()) return false; publish({ secretAction: remove ? 'remove' : 'keep', phase: state.recovery ? state.phase : 'ready', message: state.recovery ? state.message : '' }); return true; },
    dispose() { active = false; epoch++; state = initialAgentSettingsState(); },
  };
}
