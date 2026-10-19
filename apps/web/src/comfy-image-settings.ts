import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { canonicalImageInput, comfyImageConfigurationSchema, comfyImageSettingsResultSchema, normalizeComfyImageBaseUrl, getComfyImageDestination, comfyImageCheckResultSchema, comfyConnectorAvailabilitySchema } from '@mioon/contracts';

export type ComfyConnectorAvailability=ReturnType<typeof comfyConnectorAvailabilitySchema.parse>;
export type ComfyImageSettingsResult=ReturnType<typeof comfyImageSettingsResultSchema.parse>;
export type ComfyImageCheckResult=ReturnType<typeof comfyImageCheckResultSchema.parse>;
export interface ComfyImageConfiguration {
  enabled: boolean;
  baseUrl: string;
  model: string;
  [key: string]: unknown;
}
export type ComfyImageClientError=Error&{code: string};
export interface ComfyImageSettingsClient {
  readAvailability(): Promise<ComfyConnectorAvailability>;
  read(): Promise<ComfyImageSettingsResult>;
  write(input: {expectedRevision: number; configuration: ComfyImageConfiguration}): Promise<ComfyImageSettingsResult>;
  check(input: {baseUrl: string; model: string}): Promise<ComfyImageCheckResult>;
}
export interface ComfyImageSettingsClientOptions {fetchImpl?: typeof fetch; timeoutMs?: number; checkTimeoutMs?: number}
export type ComfyRecovery='conflict'|'unknown'|null;
export interface ComfyImageSettingsState {
  phase: string;
  availability: ComfyConnectorAvailability|null;
  availabilityPhase: string;
  snapshot: ComfyImageSettingsResult|null;
  draft: ComfyImageConfiguration|null;
  check: ComfyImageCheckResult|null;
  recovery: ComfyRecovery;
  message: string;
  displayMessages: unknown[];
}
export interface ComfyImageSettingsSessionOptions {
  client?: ComfyImageSettingsClient;
  onChange?: (state: ComfyImageSettingsState)=>void;
  onSnapshot?: (snapshot: ComfyImageSettingsResult)=>void;
  onAvailability?: (availability: ComfyConnectorAvailability|null)=>void;
}
export interface ComfyImageSettingsSession {
  getState(): ComfyImageSettingsState;
  load(): Promise<boolean>;
  reload(): Promise<boolean>;
  refreshAvailability(): boolean|Promise<boolean>;
  save(): Promise<boolean>;
  checkConnection(): Promise<boolean>;
  setEnabled(enabled: unknown): boolean;
  setBaseUrl(baseUrl: unknown): boolean;
  selectModel(model: unknown): boolean;
  acknowledge(): boolean;
  useLatest(): boolean;
  setVisible(value: unknown): void;
  dispose(): void;
}

const copy=<T>(value: T): T=>structuredClone(value);
const failure=(code = 'NETWORK'): ComfyImageClientError=>Object.assign(new Error('Local image connection request did not complete.'), { code });
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const codes = new Set(['UNAUTHORIZED', 'COMFY_MODULE_UNAVAILABLE', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED', 'COMFY_ENDPOINT_INVALID', 'COMFY_ENDPOINT_DENIED', 'COMFY_CHECK_FAILED', 'COMFY_SETTINGS_VALIDATION', 'COMFY_SETTINGS_CONFLICT', 'COMFY_SETTINGS_CORRUPT', 'COMFY_SETTINGS_CLOSED', 'COMFY_SETTINGS_DESTINATION_DENIED', 'COMFY_SETTINGS_SAVE_FAILED', 'COMFY_SETTINGS_DISABLED', 'COMFY_SETTINGS_NOT_CONFIGURED', 'COMFY_SETTINGS_CHECK_REQUIRED']);
const errorCode=(error: unknown): string|undefined=>typeof property(error,'code')==='string'?property(error,'code') as string:undefined;

function safeAvailability(value: unknown): ComfyConnectorAvailability { const result = comfyConnectorAvailabilitySchema.safeParse(value); if (!result.success) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export function safeComfyConnectorAvailability(value: unknown): ComfyConnectorAvailability { return safeAvailability(value); }
export const comfyConnectorAvailable=(value: unknown): boolean=>comfyConnectorAvailabilitySchema.safeParse(value).success && property(value,'state')==='available';
export function comfyConnectorAvailabilityLabel(value: unknown): string {
  if (!comfyConnectorAvailabilitySchema.safeParse(value).success) return '模块状态未确认：新的连接检查、生成审批与远端查询已暂停。可重新读取本地状态；已保存图像、任务与本地恢复仍可使用。';
  if (property(value,'state') === 'not_provided') return '当前发行版未提供 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询。';
  if (property(value,'state') === 'not_loaded') return '本次启动未加载 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询。';
  return '官方 ComfyUI 连接模块可用 · 实现版本 1。本次启动状态固定；这不代表外部 ComfyUI 服务或模型可用。';
}
function safeSettings(value: unknown): ComfyImageSettingsResult { const result = comfyImageSettingsResultSchema.safeParse(value); if (!result.success) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export function safeComfyImageSettings(value: unknown): ComfyImageSettingsResult { return safeSettings(value); }
export function safeComfyImageCheck(value: unknown,baseUrl: unknown): ComfyImageCheckResult { const result = comfyImageCheckResultSchema.safeParse(value); if (!result.success || result.data.baseUrl !== baseUrl) throw failure('INVALID_RESPONSE'); return copy(result.data); }
export function comfyImageDestination(draft: {baseUrl?: unknown}|null|undefined): string { try { return getComfyImageDestination(normalizeComfyImageBaseUrl(property(draft,'baseUrl'))); } catch { return ''; } }
export function createComfyImageSettingsClient({ fetchImpl = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => globalThis.fetch(...args), timeoutMs = 12000, checkTimeoutMs = 45000 }: ComfyImageSettingsClientOptions = {}): ComfyImageSettingsClient {
  async function request(route: string, method: string, input?: unknown): Promise<ComfyConnectorAvailability|ComfyImageSettingsResult|ComfyImageCheckResult> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>|undefined;
    const duration = route === '/api/images/comfy-check' ? checkTimeoutMs : timeoutMs;
    const transport = (async () => {
      const response = await fetchImpl(route, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
      let envelope: unknown; try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || property(envelope,'ok') !== true) {
        const code=errorCode(property(envelope,'error'));
        throw failure(response.status === 401 ? 'UNAUTHORIZED' : code!==undefined&&codes.has(code) ? code : 'NETWORK');
      }
      const data=property(envelope,'data');
      return route === '/api/images/comfy-availability' ? safeAvailability(data) : route === '/api/images/comfy-check' ? safeComfyImageCheck(data, property(input,'baseUrl')) : safeSettings(data);
    })();
    try { return duration > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, duration); })]) : await transport; }
    catch (error) { const code=errorCode(error); throw failure(code!==undefined&&(codes.has(code) || code === 'INVALID_RESPONSE') ? code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return {
    readAvailability: () => request('/api/images/comfy-availability', 'GET') as Promise<ComfyConnectorAvailability>,
    read: () => request('/api/images/comfy-settings', 'GET') as Promise<ComfyImageSettingsResult>,
    write: (input: {expectedRevision: number; configuration: ComfyImageConfiguration}) => request('/api/images/comfy-settings', 'PUT', input) as Promise<ComfyImageSettingsResult>,
    check: (input: {baseUrl: string; model: string}) => request('/api/images/comfy-check', 'POST', input) as Promise<ComfyImageCheckResult>,
  };
}
export const initialComfyImageSettingsState=(): ComfyImageSettingsState => ({ phase: 'loading', availability: null, availabilityPhase: 'loading', snapshot: null, draft: null, check: null, recovery: null, message: '', displayMessages: [] });
export const comfyImageSettingsEditable=(state: ComfyImageSettingsState): boolean=>Boolean(state.snapshot) && !['loading', 'saving', 'reconciling', 'checking'].includes(state.phase);
export const comfyImageSettingsCanSave=(state: ComfyImageSettingsState): boolean=>comfyImageSettingsEditable(state) && !state.recovery && state.phase !== 'blocked';
export const comfyImageSettingsDirty=(state: ComfyImageSettingsState): boolean=>Boolean(state.snapshot && canonicalImageInput(state.draft) !== canonicalImageInput(state.snapshot.configuration));
export function comfyImageCheckLabel(check: ComfyImageCheckResult|null): string {
  if (!check) return '未检查当前地址。保存设置不代表服务可用，也不会检查模型。';
  if (check.ok && check.checkpoints.length) return '本次只读检查已通过：版本、所需内置节点和 checkpoint 名单可读。尚未验证真实生成、模型兼容性或可信代码。';
  return '未发现可选 checkpoint。请自行准备兼容模型后，再明确检查；不会自动下载或安装。';
}

/** Local configuration persistence and explicit read-only check have separate intents. */
export function createComfyImageSettingsSession({ client = createComfyImageSettingsClient(), onChange = () => {}, onSnapshot = () => {}, onAvailability = () => {} }: ComfyImageSettingsSessionOptions = {}): ComfyImageSettingsSession {
  let state = initialComfyImageSettingsState(), active = true, visible = true, epoch = 0, availabilityEpoch = 0;
  const publish = (patch: Partial<ComfyImageSettingsState>): void => { if (active) { state = { ...state, ...patch }; onChange(copy(state)); } };
  const current = (token: number): boolean => active && token === epoch;
  const editable = (): boolean => active && visible && comfyImageSettingsEditable(state);
  const receive = (value: unknown): ComfyImageSettingsResult => { const safe = safeSettings(value); onSnapshot(copy(safe)); return safe; };
  async function readAvailability(): Promise<boolean> {
    if (!active) return false;
    const token = ++availabilityEpoch;
    publish({ availability: null, availabilityPhase: 'loading' }); onAvailability(null);
    try {
      const availability = safeAvailability(await client.readAvailability());
      if (!active || token !== availabilityEpoch) return false;
      publish({ availability, availabilityPhase: 'ready' }); onAvailability(copy(availability)); return true;
    } catch {
      if (active && token === availabilityEpoch) { publish({ availability: null, availabilityPhase: 'error' }); onAvailability(null); }
      return false;
    }
  }
  async function read(recover = false): Promise<boolean> {
    if (!active || ['saving', 'reconciling', 'checking'].includes(state.phase)) return false;
    void readAvailability();
    const token = ++epoch; publish({ phase: recover ? 'reconciling' : 'loading', message: '', displayMessages: [] });
    try {
      const safe = safeSettings(await client.read()); if (!current(token)) return false;
      receive(safe); publish({ snapshot: safe, draft: recover && state.draft ? state.draft : copy(safe.configuration), phase: recover ? 'review' : 'ready', recovery: recover ? state.recovery || 'unknown' : null, check: null, message: recover ? '已读取当前保存状态。草稿保留，请核对后继续；没有检查服务或重试保存。' : '', displayMessages: (recover ? [message('connections.comfy.notice.review')] : []) }); return true;
    } catch { if (current(token)) publish({ phase: recover ? 'blocked' : 'load_error', message: '暂时无法读取本地连接设置。不会覆盖已有设置，请重新读取。', displayMessages: [message('connections.comfy.notice.loadError')] }); return false; }
  }
  async function save(): Promise<boolean> {
    if (!active || !visible || !comfyImageSettingsCanSave(state)) return false;
    let configuration: ComfyImageConfiguration;
    const draft=state.draft;
    if(!draft)return false;
    try { configuration = { ...draft, baseUrl: draft.baseUrl === '' ? '' : normalizeComfyImageBaseUrl(draft.baseUrl) }; if (!comfyImageConfigurationSchema.safeParse(configuration).success) throw failure(); }
    catch { publish({ phase: 'error', message: '请填写明确的本机 HTTP 地址与端口，并从检查返回的名单选择 checkpoint；或同时清空地址与模型并关闭连接。', displayMessages: [message('connections.comfy.issue.configuration')] }); return false; }
    if(!state.snapshot)return false;
    const token = ++epoch, revision = state.snapshot.revision; publish({ phase: 'saving', draft: copy(configuration), message: '', displayMessages: [] });
    try {
      const safe = safeSettings(await client.write({ expectedRevision: revision, configuration: copy(configuration) })); if (!current(token)) return false;
      if (safe.revision !== revision + 1 || canonicalImageInput(safe.configuration) !== canonicalImageInput(configuration)) throw failure('INVALID_RESPONSE');
      receive(safe); publish({ snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, message: '本地连接设置已保存。没有探测服务或生成图像；每次生成仍需准备并审批。', displayMessages: [message('connections.comfy.notice.saved')] }); return true;
    } catch (error) {
      if (!current(token)) return false;
      const code=errorCode(error);
      if (code!==undefined&&['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'COMFY_ENDPOINT_INVALID', 'COMFY_ENDPOINT_DENIED', 'COMFY_SETTINGS_VALIDATION', 'COMFY_SETTINGS_DESTINATION_DENIED'].includes(code)) { publish({ phase: 'error', message: '此次设置未被接受。请检查本机地址、端口与 checkpoint；必要时重新登录。', displayMessages: [message('connections.comfy.notice.rejected')] }); return false; }
      const recovery: ComfyRecovery = code!==undefined&&['IMAGE_SETTINGS_CONFLICT', 'COMFY_SETTINGS_CONFLICT'].includes(code) ? 'conflict' : 'unknown'; publish({ phase: 'reconciling', recovery, message: '正在读取当前保存状态，不会重试保存或检查服务。', displayMessages: [message('connections.comfy.notice.rereading')] });
      try { const safe = safeSettings(await client.read()); if (!current(token)) return false; receive(safe); publish({ snapshot: safe, phase: 'review', check: null, message: recovery === 'conflict' ? '设置已在其他窗口变化。草稿保留，请核对后继续。' : '保存结果尚未确认。已读取当前设置，请核对；不会自动重试。', displayMessages: (recovery === 'conflict' ? [message('connections.comfy.notice.conflict')] : [message('connections.comfy.notice.unknown')]) }); }
      catch { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿保留，请重新读取后再保存。', displayMessages: [message('connections.notice.blocked')] }); }
      return false;
    }
  }
  async function checkConnection(): Promise<boolean> {
    if (!editable() || state.recovery || !comfyConnectorAvailable(state.availability) || !state.draft) return false;
    let baseUrl: string; try { baseUrl = normalizeComfyImageBaseUrl(state.draft.baseUrl); } catch { publish({ message: '请填写 HTTP 127.0.0.1 或 [::1] 与明确端口。没有发起检查。', displayMessages: [message('connections.comfy.issue.endpoint')] }); return false; }
    const token = ++epoch; publish({ phase: 'checking', check: null, message: '', displayMessages: [] });
    try {
      const check = safeComfyImageCheck(await client.check({ baseUrl, model: state.draft.model }), baseUrl); if (!current(token)) return false;
      // Refresh only local readiness metadata after the explicitly requested check.
      const snapshot = safeSettings(await client.read()); if (!current(token)) return false; receive(snapshot);
      if(!state.snapshot)return false;
      const previous=state.snapshot;
      const changed = snapshot.revision !== previous.revision || canonicalImageInput(snapshot.configuration) !== canonicalImageInput(previous.configuration);
      publish({ snapshot, phase: changed ? 'review' : 'ready', recovery: changed ? 'conflict' : null, check, message: changed ? '检查完成，但保存设置已在其他窗口变化。草稿保留，请核对后继续。' : '检查完成；没有保存设置或生成图像。', displayMessages: (changed ? [message('connections.comfy.notice.checkedConflict')] : [message('connections.comfy.notice.checked')]) }); return true;
    }
    catch { if (current(token)) publish({ phase: 'error', check: null, message: '无法核验当前连接或依赖。没有生成图像，也不会自动重试检查。', displayMessages: [message('connections.comfy.notice.checkError')] }); return false; }
  }
  return { getState: () => copy(state), load: () => read(), reload: () => read(Boolean(state.snapshot)), refreshAvailability: () => editable() ? readAvailability() : false, save, checkConnection,
    setEnabled(enabled: unknown): boolean { if (!editable() || typeof enabled !== 'boolean' || !state.draft) return false; publish({ draft: { ...state.draft, enabled } }); return true; },
    setBaseUrl(baseUrl: unknown): boolean { if (!editable() || typeof baseUrl !== 'string' || !state.draft) return false; publish({ draft: { ...state.draft, baseUrl, model: '' }, check: null }); return true; },
    selectModel(model: unknown): boolean { if (!editable() || typeof model !== 'string' || !state.check?.checkpoints.includes(model) || !state.draft) return false; publish({ draft: { ...state.draft, model } }); return true; },
    acknowledge(): boolean { if (!editable() || state.phase !== 'review' || !state.recovery) return false; publish({ recovery: null, phase: 'ready', message: '草稿已保留。请重新核对后明确保存。', displayMessages: [message('connections.comfy.notice.keepDraft')] }); return true; },
    useLatest(): boolean { if (!editable() || state.phase === 'blocked' || !state.snapshot) return false; publish({ draft: copy(state.snapshot.configuration), check: null, recovery: null, phase: 'ready', message: '已使用当前已保存设置。连接仍未重新检查。', displayMessages: [message('connections.comfy.notice.useSaved')] }); return true; },
    setVisible(value: unknown): void { visible = Boolean(value); },
    dispose(): void { active = false; epoch++; availabilityEpoch++; state = initialComfyImageSettingsState(); },
  };
}

// Display descriptors are transient UI metadata. Legacy diagnostics and request payloads remain unchanged.
export function comfyConnectorAvailabilityDescriptor(value: unknown): DisplayMessage {
  if (!comfyConnectorAvailabilitySchema.safeParse(value).success) return message('connections.comfy.moduleUnknown');
  if (property(value,'state') === 'not_provided') return message('connections.comfy.moduleMissing');
  if (property(value,'state') === 'not_loaded') return message('connections.comfy.moduleUnloaded');
  return message('connections.comfy.moduleAvailable');
}

export function comfyImageCheckDescriptor(check: ComfyImageCheckResult|null): DisplayMessage {
  if (!check) return message('connections.comfy.checkNone');
  if (check.ok && check.checkpoints.length) return message('connections.comfy.checkPassed');
  return message('connections.comfy.checkEmpty');
}
