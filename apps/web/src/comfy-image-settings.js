import { canonicalImageInput, comfyImageConfigurationSchema, comfyImageSettingsResultSchema, normalizeComfyImageBaseUrl, getComfyImageDestination, comfyImageCheckResultSchema, comfyConnectorAvailabilitySchema } from '@mioon/contracts';

const copy = value => structuredClone(value);
const failure = (code = 'NETWORK') => Object.assign(new Error('Local image connection request did not complete.'), { code });
const codes = new Set(['UNAUTHORIZED', 'COMFY_MODULE_UNAVAILABLE', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED', 'COMFY_ENDPOINT_INVALID', 'COMFY_ENDPOINT_DENIED', 'COMFY_CHECK_FAILED', 'COMFY_SETTINGS_VALIDATION', 'COMFY_SETTINGS_CONFLICT', 'COMFY_SETTINGS_CORRUPT', 'COMFY_SETTINGS_CLOSED', 'COMFY_SETTINGS_DESTINATION_DENIED', 'COMFY_SETTINGS_SAVE_FAILED', 'COMFY_SETTINGS_DISABLED', 'COMFY_SETTINGS_NOT_CONFIGURED', 'COMFY_SETTINGS_CHECK_REQUIRED']);
export function safeComfyConnectorAvailability(value) { const result = comfyConnectorAvailabilitySchema.safeParse(value); if (!result.success) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export const comfyConnectorAvailable = value => comfyConnectorAvailabilitySchema.safeParse(value).success && value.state === 'available';
export function comfyConnectorAvailabilityLabel(value) {
  if (!comfyConnectorAvailabilitySchema.safeParse(value).success) return '模块状态未确认：新的连接检查、生成审批与远端查询已暂停。可重新读取本地状态；已保存图像、任务与本地恢复仍可使用。';
  if (value.state === 'not_provided') return '当前发行版未提供 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询。';
  if (value.state === 'not_loaded') return '本次启动未加载 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询。';
  return '官方 ComfyUI 连接模块可用 · 实现版本 1。本次启动状态固定；这不代表外部 ComfyUI 服务或模型可用。';
}
export function safeComfyImageSettings(value) { const result = comfyImageSettingsResultSchema.safeParse(value); if (!result.success) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export function safeComfyImageCheck(value, baseUrl) { const result = comfyImageCheckResultSchema.safeParse(value); if (!result.success || result.data.baseUrl !== baseUrl) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export function comfyImageDestination(draft) { try { return getComfyImageDestination(normalizeComfyImageBaseUrl(draft.baseUrl)); } catch { return ''; } }
export function createComfyImageSettingsClient({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 12000, checkTimeoutMs = 45000 } = {}) {
  async function request(route, method, input) {
    const controller = new AbortController(); let timer;
    const duration = route === '/api/images/comfy-check' ? checkTimeoutMs : timeoutMs;
    const transport = (async () => {
      const response = await fetchImpl(route, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
      let envelope; try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || envelope?.ok !== true) throw failure(response.status === 401 ? 'UNAUTHORIZED' : codes.has(envelope?.error?.code) ? envelope.error.code : 'NETWORK');
      return route === '/api/images/comfy-availability' ? safeComfyConnectorAvailability(envelope.data) : route === '/api/images/comfy-check' ? safeComfyImageCheck(envelope.data, input.baseUrl) : safeComfyImageSettings(envelope.data);
    })();
    try { return duration > 0 ? await Promise.race([transport, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, duration); })]) : await transport; }
    catch (error) { throw failure(codes.has(error?.code) || error?.code === 'INVALID_RESPONSE' ? error.code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { readAvailability: () => request('/api/images/comfy-availability', 'GET'), read: () => request('/api/images/comfy-settings', 'GET'), write: input => request('/api/images/comfy-settings', 'PUT', input), check: input => request('/api/images/comfy-check', 'POST', input) };
}
export const initialComfyImageSettingsState = () => ({ phase: 'loading', availability: null, availabilityPhase: 'loading', snapshot: null, draft: null, check: null, recovery: null, message: '' });
export const comfyImageSettingsEditable = state => Boolean(state.snapshot) && !['loading', 'saving', 'reconciling', 'checking'].includes(state.phase);
export const comfyImageSettingsCanSave = state => comfyImageSettingsEditable(state) && !state.recovery && state.phase !== 'blocked';
export const comfyImageSettingsDirty = state => Boolean(state.snapshot && canonicalImageInput(state.draft) !== canonicalImageInput(state.snapshot.configuration));
export function comfyImageCheckLabel(check) {
  if (!check) return '未检查当前地址。保存设置不代表服务可用，也不会检查模型。';
  if (check.ok && check.checkpoints.length) return '本次只读检查已通过：版本、所需内置节点和 checkpoint 名单可读。尚未验证真实生成、模型兼容性或可信代码。';
  return '未发现可选 checkpoint。请自行准备兼容模型后，再明确检查；不会自动下载或安装。';
}

/** Local configuration persistence and explicit read-only check have separate intents. */
export function createComfyImageSettingsSession({ client = createComfyImageSettingsClient(), onChange = () => {}, onSnapshot = () => {}, onAvailability = () => {} } = {}) {
  let state = initialComfyImageSettingsState(), active = true, visible = true, epoch = 0, availabilityEpoch = 0;
  const publish = patch => { if (active) { state = { ...state, ...patch }; onChange(copy(state)); } };
  const current = token => active && token === epoch;
  const editable = () => active && visible && comfyImageSettingsEditable(state);
  const receive = value => { const safe = safeComfyImageSettings(value); onSnapshot(copy(safe)); return safe; };
  async function readAvailability() {
    if (!active) return false;
    const token = ++availabilityEpoch;
    publish({ availability: null, availabilityPhase: 'loading' }); onAvailability(null);
    try {
      const availability = safeComfyConnectorAvailability(await client.readAvailability());
      if (!active || token !== availabilityEpoch) return false;
      publish({ availability, availabilityPhase: 'ready' }); onAvailability(copy(availability)); return true;
    } catch {
      if (active && token === availabilityEpoch) { publish({ availability: null, availabilityPhase: 'error' }); onAvailability(null); }
      return false;
    }
  }
  async function read(recover = false) {
    if (!active || ['saving', 'reconciling', 'checking'].includes(state.phase)) return false;
    void readAvailability();
    const token = ++epoch; publish({ phase: recover ? 'reconciling' : 'loading', message: '' });
    try {
      const safe = safeComfyImageSettings(await client.read()); if (!current(token)) return false;
      receive(safe); publish({ snapshot: safe, draft: recover && state.draft ? state.draft : copy(safe.configuration), phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery || 'unknown' : null, check: null, message: recover ? '已读取当前保存状态。草稿保留，请核对后继续；没有检查服务或重试保存。' : '' }); return true;
    } catch { if (current(token)) publish({ phase: recover ? 'blocked' : 'load_error', message: '暂时无法读取本地连接设置。不会覆盖已有设置，请重新读取。' }); return false; }
  }
  async function save() {
    if (!active || !visible || !comfyImageSettingsCanSave(state)) return false;
    let configuration;
    try { configuration = { ...state.draft, baseUrl: state.draft.baseUrl === '' ? '' : normalizeComfyImageBaseUrl(state.draft.baseUrl) }; if (!comfyImageConfigurationSchema.safeParse(configuration).success) throw failure(); }
    catch { publish({ phase: 'error', message: '请填写明确的本机 HTTP 地址与端口，并从检查返回的名单选择 checkpoint；或同时清空地址与模型并关闭连接。' }); return false; }
    const token = ++epoch, revision = state.snapshot.revision; publish({ phase: 'saving', draft: copy(configuration), message: '' });
    try {
      const safe = safeComfyImageSettings(await client.write({ expectedRevision: revision, configuration: copy(configuration) })); if (!current(token)) return false;
      if (safe.revision !== revision + 1 || canonicalImageInput(safe.configuration) !== canonicalImageInput(configuration)) throw failure('INVALID_RESPONSE');
      receive(safe); publish({ snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, message: '本地连接设置已保存。没有探测服务或生成图像；每次生成仍需准备并审批。' }); return true;
    } catch (error) {
      if (!current(token)) return false;
      if (['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'COMFY_ENDPOINT_INVALID', 'COMFY_ENDPOINT_DENIED', 'COMFY_SETTINGS_VALIDATION', 'COMFY_SETTINGS_DESTINATION_DENIED'].includes(error?.code)) { publish({ phase: 'error', message: '此次设置未被接受。请检查本机地址、端口与 checkpoint；必要时重新登录。' }); return false; }
      const recovery = ['IMAGE_SETTINGS_CONFLICT', 'COMFY_SETTINGS_CONFLICT'].includes(error?.code) ? 'conflict' : 'unknown'; publish({ phase: 'reconciling', recovery, message: '正在读取当前保存状态，不会重试保存或检查服务。' });
      try { const safe = safeComfyImageSettings(await client.read()); if (!current(token)) return false; receive(safe); publish({ snapshot: safe, phase: 'review', check: null, message: recovery === 'conflict' ? '设置已在其他窗口变化。草稿保留，请核对后继续。' : '保存结果尚未确认。已读取当前设置，请核对；不会自动重试。' }); }
      catch { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿保留，请重新读取后再保存。' }); }
      return false;
    }
  }
  async function checkConnection() {
    if (!editable() || state.recovery || !comfyConnectorAvailable(state.availability)) return false;
    let baseUrl; try { baseUrl = normalizeComfyImageBaseUrl(state.draft.baseUrl); } catch { publish({ message: '请填写 HTTP 127.0.0.1 或 [::1] 与明确端口。没有发起检查。' }); return false; }
    const token = ++epoch; publish({ phase: 'checking', check: null, message: '' });
    try { const check = safeComfyImageCheck(await client.check({ baseUrl, model: state.draft.model }), baseUrl); if (!current(token)) return false;
      // Refresh only local readiness metadata after the explicitly requested check.
      const snapshot = safeComfyImageSettings(await client.read()); if (!current(token)) return false; receive(snapshot);
      const changed = snapshot.revision !== state.snapshot.revision || canonicalImageInput(snapshot.configuration) !== canonicalImageInput(state.snapshot.configuration);
      publish({ snapshot, phase: changed ? 'review' : 'ready', recovery: changed ? 'conflict' : null, check, message: changed ? '检查完成，但保存设置已在其他窗口变化。草稿保留，请核对后继续。' : '检查完成；没有保存设置或生成图像。' }); return true; }
    catch { if (current(token)) publish({ phase: 'error', check: null, message: '无法核验当前连接或依赖。没有生成图像，也不会自动重试检查。' }); return false; }
  }
  return { getState: () => copy(state), load: () => read(), reload: () => read(Boolean(state.snapshot)), refreshAvailability: () => editable() ? readAvailability() : false, save, checkConnection,
    setEnabled(enabled) { if (!editable() || typeof enabled !== 'boolean') return false; publish({ draft: { ...state.draft, enabled } }); return true; },
    setBaseUrl(baseUrl) { if (!editable() || typeof baseUrl !== 'string') return false; publish({ draft: { ...state.draft, baseUrl, model: '' }, check: null }); return true; },
    selectModel(model) { if (!editable() || !state.check?.checkpoints.includes(model)) return false; publish({ draft: { ...state.draft, model } }); return true; },
    acknowledge() { if (!editable() || state.phase !== 'review' || !state.recovery) return false; publish({ recovery: null, phase: 'ready', message: '草稿已保留。请重新核对后明确保存。' }); return true; },
    useLatest() { if (!editable() || state.phase === 'blocked') return false; publish({ draft: copy(state.snapshot.configuration), check: null, recovery: null, phase: 'ready', message: '已使用当前已保存设置。连接仍未重新检查。' }); return true; },
    setVisible(value) { visible = Boolean(value); },
    dispose() { active = false; epoch++; availabilityEpoch++; state = initialComfyImageSettingsState(); },
  };
}
