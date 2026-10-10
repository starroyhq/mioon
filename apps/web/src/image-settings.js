import { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT, imageSettingsResultSchema, customImageSettingsResultSchema, customImageConfigurationSchema, normalizeCustomImageBaseUrl, getCustomImageDestination, canonicalImageInput } from '@mioon/contracts';

export { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT };
const copy = value => structuredClone(value);
const failure = (code = 'NETWORK') => Object.assign(new Error('Image settings request did not complete.'), { code });
const codes = new Set(['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_SAVE_FAILED', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED']);
const slots = Object.freeze({ official: Object.freeze({ route: '/api/images/settings', schema: imageSettingsResultSchema }), custom: Object.freeze({ route: '/api/images/custom-settings', schema: customImageSettingsResultSchema }) });
const slotDetails = slot => { if (!Object.hasOwn(slots, slot)) throw failure('INVALID_SLOT'); return slots[slot]; };
export function safeImageSettings(value, slot = 'official') {
  const result = slotDetails(slot).schema.safeParse(value);
  if (!result.success) throw failure('INVALID_RESPONSE');
  return copy(result.data);
}
export function createImageSettingsClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 12000, slot = 'official' } = {}) {
  const details = slotDetails(slot);
  async function request(method, body) {
    const controller = new AbortController(); let timer;
    const transport = (async () => {
      const response = await fetchImpl(details.route, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope; try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || envelope?.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : codes.has(envelope?.error?.code) ? envelope.error.code : 'NETWORK');
      return safeImageSettings(envelope.data, slot);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); })]) : await transport; }
    catch (error) { throw failure(codes.has(error?.code) || error?.code === 'INVALID_RESPONSE' ? error.code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: () => request('GET'), write: input => request('PUT', JSON.stringify(input)) };
}
export const initialImageSettingsState = () => ({ phase: 'loading', snapshot: null, draft: null, storage: '', secretAction: 'keep', recovery: null, message: '' });
export const imageSettingsBusy = state => ['loading', 'saving', 'reconciling'].includes(state.phase);
export const imageSettingsEditable = state => Boolean(state.snapshot) && !imageSettingsBusy(state);
export const imageSettingsCanSave = state => imageSettingsEditable(state) && !state.recovery && state.phase !== 'blocked';
export const imageSettingsDirty = state => Boolean(state.snapshot && (canonicalImageInput(state.draft) !== canonicalImageInput(state.snapshot.configuration) || state.secretAction === 'remove'));
export function customImageDraftConfiguration(draft) {
  return { ...draft, baseUrl: draft.baseUrl === '' ? '' : normalizeCustomImageBaseUrl(draft.baseUrl) };
}
export function imageSettingsDestination(draft) {
  try { return draft?.providerId === 'openai-compatible' ? getCustomImageDestination(customImageDraftConfiguration(draft).baseUrl) : draft?.baseUrl ? `${draft.baseUrl}/images/generations` : ''; } catch { return ''; }
}
export function imageSettingsBindingChanged(state) {
  if (!state.snapshot || state.draft?.providerId !== 'openai-compatible') return false;
  try { const draft = customImageDraftConfiguration(state.draft); return draft.baseUrl !== state.snapshot.configuration.baseUrl || draft.model !== state.snapshot.configuration.model; } catch { return true; }
}
export const imageKeyIssue = value => value && (!/^[\x21-\x7e]+$/.test(value) || value.length > IMAGE_SETTINGS_LIMITS.secretBytes) ? `密钥只能包含非空白 ASCII 字符，最多 ${IMAGE_SETTINGS_LIMITS.secretBytes} 字节。` : '';
const errorText = code => ({ UNAUTHORIZED: '登录会话已过期，请重新登录后打开设置。', IMAGE_SETTINGS_VALIDATION: '设置未通过校验，请检查地址、模型和密钥格式。', IMAGE_SETTINGS_STORAGE_UNAVAILABLE: '系统安全存储当前不可用。请明确选择仅本次运行，并重新输入密钥。', IMAGE_SETTINGS_CORRUPT: '无法读取安全设置，不会覆盖已有设置。', IMAGE_SETTINGS_CLOSED: '设置服务已关闭，请重新打开应用。' }[code] || '未收到保存确认，结果可能已经生效。');

/** Only redacted metadata belongs in state. A replacement secret is used once. */
export function createImageSettingsSession({ slot = 'official', client = createImageSettingsClient({ slot }), onChange = () => {}, onSnapshot = () => {} } = {}) {
  slotDetails(slot);
  let state = initialImageSettingsState(), active = true, visible = true, epoch = 0;
  const publish = patch => { if (active) { state = { ...state, ...patch }; onChange(copy(state)); } };
  const current = token => active && epoch === token;
  const editable = () => active && visible && imageSettingsEditable(state);
  const receive = snapshot => { const safe = safeImageSettings(snapshot, slot); onSnapshot(copy(safe)); return safe; };
  function read({ recover = false } = {}) {
    if (!active || imageSettingsBusy(state) && state.phase !== 'loading') return Promise.resolve(false);
    const token = ++epoch;
    publish({ phase: recover ? 'reconciling' : 'loading', message: '' });
    return Promise.resolve().then(() => client.read()).then(snapshot => {
      if (!current(token)) return false;
      const safe = receive(snapshot);
      publish({ snapshot: safe, draft: recover && state.draft ? state.draft : copy(safe.configuration), phase: recover ? 'review' : 'ready', secretAction: 'keep', storage: recover ? (state.storage === 'persistent' && !safe.storage.persistentAvailable ? '' : state.storage) : safe.secret.storage === 'none' ? '' : safe.secret.storage,
        recovery: recover ? state.recovery || 'unknown' : null, message: recover ? '已读取当前设置，草稿保留。请核对后继续；替换密钥需重新输入。' : '' });
      return true;
    }).catch(error => { if (current(token)) publish({ phase: recover ? 'blocked' : 'load_error', message: recover ? '暂时无法核实保存结果。请重新读取，暂不能保存。' : codes.has(error?.code) ? errorText(error.code) : '暂时无法读取图像设置，请重新读取。' }); return false; });
  }
  function save(value = '') {
    if (!active || !visible || !imageSettingsCanSave(state)) return Promise.resolve(false);
    let configuration;
    try {
      configuration = slot === 'custom' ? customImageDraftConfiguration(state.draft) : copy(state.draft);
      if (slot === 'custom' && !customImageConfigurationSchema.safeParse(configuration).success) throw failure();
    } catch { publish({ phase: 'error', message: '请填写完整的 HTTPS 公网域名地址和模型标识，或同时清空地址与模型并关闭连接。地址不得含查询、凭据或非 443 端口。' }); return Promise.resolve(false); }
    const issue = (slot === 'custom' && state.snapshot.secret.configured && imageSettingsBindingChanged(state) && !value && state.secretAction !== 'remove' ? '地址或模型已变化。请重新输入此连接的新密钥，或明确移除原密钥后保存；原密钥不会带到新地址。' : '') || imageKeyIssue(value) || (value && !['session', 'persistent'].includes(state.storage) ? '请选择密钥的保存方式。' : '') || (value && state.storage === 'persistent' && !state.snapshot.storage.persistentAvailable ? errorText('IMAGE_SETTINGS_STORAGE_UNAVAILABLE') : '');
    if (issue) { publish({ phase: 'error', message: issue }); return Promise.resolve(false); }
    const token = ++epoch, revision = state.snapshot.revision;
    const secret = value ? { action: 'replace', storage: state.storage, value } : { action: state.secretAction };
    const expectedSecret = secret.action === 'replace' ? { configured: true, storage: state.storage } : secret.action === 'remove' ? { configured: false, storage: 'none' } : copy(state.snapshot.secret);
    publish({ phase: 'saving', draft: copy(configuration), secretAction: 'keep', message: '' });
    let operation; try { operation = client.write({ expectedRevision: revision, configuration, secret }); } catch (error) { operation = Promise.reject(error); }
    // Completion and recovery handlers retain no credential or retry body.
    return Promise.resolve(operation).then(snapshot => {
      if (!current(token)) return false;
      const safe = safeImageSettings(snapshot, slot);
      if (safe.revision !== revision + 1 || canonicalImageInput(safe.configuration) !== canonicalImageInput(configuration) || safe.secret.configured !== expectedSecret.configured || safe.secret.storage !== expectedSecret.storage) throw failure('INVALID_RESPONSE');
      onSnapshot(copy(safe));
      publish({ snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, message: `图像设置已保存。${safe.secret.configured ? safe.secret.storage === 'persistent' ? '密钥由系统加密保存。' : '密钥仅在本次后端运行中保留。' : '尚未配置密钥。'}保存不会发送图像请求；真实调用尚未验证。` }); return true;
    }).catch(error => {
      if (!current(token)) return false;
      if (['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION'].includes(error?.code)) { publish({ phase: 'error', message: `${errorText(error.code)}新输入的密钥已清空。` }); return false; }
      const recovery = error?.code === 'IMAGE_SETTINGS_CONFLICT' ? 'conflict' : 'unknown';
      publish({ phase: 'reconciling', recovery, message: '正在读取当前状态，不会自动重新保存。' });
      return Promise.resolve().then(() => client.read()).then(snapshot => {
        if (!current(token)) return false;
        const safe = receive(snapshot);
        publish({ snapshot: safe, phase: 'review', storage: state.storage === 'persistent' && !safe.storage.persistentAvailable ? '' : state.storage,
          message: recovery === 'conflict' ? '设置已在其他窗口变化。你的草稿保留，请核对后继续；替换密钥需重新输入。' : `${errorText(error?.code)}已读取当前状态，未自动重试。请核对后继续；替换密钥需重新输入。` }); return false;
      }).catch(() => { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿保留，请重新读取后再保存。' }); return false; });
    });
  }
  return { getState: () => copy(state), load: () => read(), reload: () => read({ recover: Boolean(state.snapshot) }), save,
    setEnabled(enabled) { if (!editable() || typeof enabled !== 'boolean') return false; publish({ draft: { ...state.draft, enabled } }); return true; },
    setConfigurationField(field, value) { if (!editable() || slot !== 'custom' || !['baseUrl', 'model'].includes(field) || typeof value !== 'string') return false; publish({ draft: { ...state.draft, [field]: value } }); return true; },
    setStorage(storage) { if (!editable() || !['session', 'persistent'].includes(storage) || storage === 'persistent' && !state.snapshot.storage.persistentAvailable) return false; publish({ storage }); return true; },
    removeKey(remove = true) { if (!editable()) return false; publish({ secretAction: remove ? 'remove' : 'keep' }); return true; },
    acknowledge() { if (!editable() || state.phase !== 'review' || !state.recovery) return false; publish({ recovery: null, phase: 'ready', message: '已保留草稿，请重新确认密钥操作后保存。' }); return true; },
    useLatest() { if (!editable() || state.phase === 'blocked') return false; publish({ draft: copy(state.snapshot.configuration), secretAction: 'keep', recovery: null, phase: 'ready', message: '已使用当前已保存设置。' }); return true; },
    setVisible(value) { visible = Boolean(value); },
    dispose() { active = false; epoch++; state = initialImageSettingsState(); },
  };
}
