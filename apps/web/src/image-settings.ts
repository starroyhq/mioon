import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT, imageSettingsResultSchema, customImageSettingsResultSchema, customImageConfigurationSchema, normalizeCustomImageBaseUrl, getCustomImageDestination, canonicalImageInput } from '@mioon/contracts';

export { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT };
export type ImageSettingsResult=ReturnType<typeof imageSettingsResultSchema.parse>;
export type CustomImageSettingsResult=ReturnType<typeof customImageSettingsResultSchema.parse>;
export type ImageSettingsSlot='official'|'custom';
export interface ImageConfiguration {enabled: boolean; baseUrl: string; model: string; [key: string]: unknown}
export interface CustomImageConfiguration extends ImageConfiguration {providerId: 'openai-compatible'; [key: string]: unknown}
export type ImageSettingsUpdate=Record<string, unknown>;
export interface ImageClientError extends Error {code: string}
export interface ImageSettingsClient {
  read(): Promise<ImageSettingsResult|CustomImageSettingsResult>;
  write(input: {expectedRevision: number; configuration: ImageConfiguration|CustomImageConfiguration; secret: Record<string, unknown>}): Promise<ImageSettingsResult|CustomImageSettingsResult>;
}
export interface ImageSettingsClientOptions {fetchImpl?: typeof fetch; timeoutMs?: number; slot?: ImageSettingsSlot}
export type ImageSecretAction='keep'|'remove';
export type ImageRecovery='conflict'|'unknown'|null;
export interface ImageSettingsState {
  phase: string;
  snapshot: ImageSettingsResult|CustomImageSettingsResult|null;
  draft: ImageConfiguration|CustomImageConfiguration|null;
  storage: string;
  secretAction: ImageSecretAction;
  recovery: ImageRecovery;
  message: string;
  displayMessages: DisplayMessage[];
}
export interface ImageSettingsSessionOptions {
  slot?: ImageSettingsSlot;
  client?: ImageSettingsClient;
  onChange?: (state: ImageSettingsState)=>void;
  onSnapshot?: (snapshot: ImageSettingsResult|CustomImageSettingsResult)=>void;
}
export interface ImageSettingsSession {
  getState(): ImageSettingsState;
  load(): Promise<boolean>;
  reload(): Promise<boolean>;
  save(value?: string): Promise<boolean>;
  setEnabled(enabled: unknown): boolean;
  setConfigurationField(field: unknown, value: unknown): boolean;
  setStorage(storage: unknown): boolean;
  removeKey(remove?: boolean): boolean;
  acknowledge(): boolean;
  useLatest(): boolean;
  setVisible(value: unknown): void;
  dispose(): void;
}

const copy=<T>(value: T): T=>structuredClone(value);
const failure=(code = 'NETWORK'): ImageClientError=>Object.assign(new Error('Image settings request did not complete.'), { code });
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorCode=(error: unknown): string|undefined=>typeof property(error,'code')==='string'?property(error,'code') as string:undefined;
const codes = new Set(['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_CONFLICT', 'IMAGE_SETTINGS_DISABLED', 'IMAGE_SETTINGS_NOT_CONFIGURED', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_SAVE_FAILED', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED']);
interface SlotDetail {readonly route: string; readonly schema: typeof imageSettingsResultSchema|typeof customImageSettingsResultSchema}
const slots: Readonly<Record<ImageSettingsSlot,SlotDetail>> = Object.freeze({ official: Object.freeze({ route: '/api/images/settings', schema: imageSettingsResultSchema }), custom: Object.freeze({ route: '/api/images/custom-settings', schema: customImageSettingsResultSchema }) });
const slotDetails=(slot: unknown): SlotDetail => { if (slot!=='official'&&slot!=='custom') throw failure('INVALID_SLOT'); return slots[slot]; };
export function safeImageSettings(value: unknown,slot: ImageSettingsSlot = 'official'): ImageSettingsResult|CustomImageSettingsResult {
  const result = slotDetails(slot).schema.safeParse(value);
  if (!result.success) throw failure('INVALID_RESPONSE');
  return copy(result.data) as ImageSettingsResult|CustomImageSettingsResult;
}
export function createImageSettingsClient({ fetchImpl = (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => globalThis.fetch(...args), timeoutMs = 12000, slot = 'official' }: ImageSettingsClientOptions = {}): ImageSettingsClient {
  const details = slotDetails(slot);
  async function request(method: string, body?: string): Promise<ImageSettingsResult|CustomImageSettingsResult> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>|undefined;
    const transport = (async () => {
      const response = await fetchImpl(details.route, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope: unknown; try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || property(envelope,'ok') !== true) { const code=errorCode(property(envelope,'error')); throw failure(response.status === 401 ? 'UNAUTHORIZED' : code!==undefined&&codes.has(code) ? code : 'NETWORK'); }
      return safeImageSettings(property(envelope,'data'), slot);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); })]) : await transport; }
    catch (error) { const code=errorCode(error); throw failure(code!==undefined&&(codes.has(code) || code === 'INVALID_RESPONSE') ? code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: () => request('GET'), write: (input: {expectedRevision: number; configuration: ImageConfiguration|CustomImageConfiguration; secret: Record<string, unknown>}) => request('PUT', JSON.stringify(input)) };
}
export const initialImageSettingsState=(): ImageSettingsState => ({ phase: 'loading', snapshot: null, draft: null, storage: '', secretAction: 'keep', recovery: null, message: '', displayMessages: [] });
export const imageSettingsBusy=(state: ImageSettingsState): boolean=>['loading', 'saving', 'reconciling'].includes(state.phase);
export const imageSettingsEditable=(state: ImageSettingsState): boolean=>Boolean(state.snapshot) && !imageSettingsBusy(state);
export const imageSettingsCanSave=(state: ImageSettingsState): boolean=>imageSettingsEditable(state) && !state.recovery && state.phase !== 'blocked';
export const imageSettingsDirty=(state: ImageSettingsState): boolean=>Boolean(state.snapshot && (canonicalImageInput(state.draft) !== canonicalImageInput(state.snapshot.configuration) || state.secretAction === 'remove'));
export function customImageDraftConfiguration(draft: ImageConfiguration): CustomImageConfiguration {
  return { ...draft, providerId: 'openai-compatible', baseUrl: draft.baseUrl === '' ? '' : normalizeCustomImageBaseUrl(draft.baseUrl) };
}
export function imageSettingsDestination(draft: ImageConfiguration|null|undefined): string {
  try { return draft?.providerId === 'openai-compatible' ? getCustomImageDestination(customImageDraftConfiguration(draft).baseUrl) : draft?.baseUrl ? `${draft.baseUrl}/images/generations` : ''; } catch { return ''; }
}
export function imageSettingsBindingChanged(state: ImageSettingsState): boolean {
  if (!state.snapshot || state.draft?.providerId !== 'openai-compatible') return false;
  try { const draft = customImageDraftConfiguration(state.draft); return draft.baseUrl !== String(property(state.snapshot.configuration,'baseUrl') ?? '') || draft.model !== property(state.snapshot.configuration,'model'); } catch { return true; }
}
export const imageKeyIssue=(value: unknown): string=>typeof value==='string' && value !== '' && (!/^[\x21-\x7e]+$/.test(value) || value.length > IMAGE_SETTINGS_LIMITS.secretBytes) ? `密钥只能包含非空白 ASCII 字符，最多 ${IMAGE_SETTINGS_LIMITS.secretBytes} 字节。` : '';
const errorText=(code: string): string => ({ UNAUTHORIZED: '登录会话已过期，请重新登录后打开设置。', IMAGE_SETTINGS_VALIDATION: '设置未通过校验，请检查地址、模型和密钥格式。', IMAGE_SETTINGS_STORAGE_UNAVAILABLE: '系统安全存储当前不可用。请明确选择仅本次运行，并重新输入密钥。', IMAGE_SETTINGS_CORRUPT: '无法读取安全设置，不会覆盖已有设置。', IMAGE_SETTINGS_CLOSED: '设置服务已关闭，请重新打开应用。' } as Readonly<Record<string,string>>)[code] || '未收到保存确认，结果可能已经生效。';

/** Only redacted metadata belongs in state. A replacement secret is used once. */
export function createImageSettingsSession({ slot = 'official', client = createImageSettingsClient({ slot }), onChange = () => {}, onSnapshot = () => {} }: ImageSettingsSessionOptions = {}): ImageSettingsSession {
  slotDetails(slot);
  let state = initialImageSettingsState(), active = true, visible = true, epoch = 0;
  const publish = (patch: Partial<ImageSettingsState>): void => { if (active) { state = { ...state, ...patch }; onChange(copy(state)); } };
  const current = (token: number): boolean => active && epoch === token;
  const editable = (): boolean => active && visible && imageSettingsEditable(state);
  const receive = (snapshot: unknown): ImageSettingsResult|CustomImageSettingsResult => { const safe = safeImageSettings(snapshot, slot); onSnapshot(copy(safe)); return safe; };
  function read({ recover = false }: {recover?: boolean} = {}): Promise<boolean> {
    if (!active || imageSettingsBusy(state) && state.phase !== 'loading') return Promise.resolve(false);
    const token = ++epoch;
    publish({ phase: recover ? 'reconciling' : 'loading', message: '', displayMessages: [] });
    return Promise.resolve().then(() => client.read()).then(snapshot => {
      if (!current(token)) return false;
      const safe = receive(snapshot);
      const storage=property(safe.secret,'storage');
      publish({ snapshot: safe, draft: recover && state.draft ? state.draft : copy(safe.configuration), phase: recover ? 'review' : 'ready', secretAction: 'keep', storage: recover ? (state.storage === 'persistent' && !property(safe.storage,'persistentAvailable') ? '' : state.storage) : storage === 'none' ? '' : String(storage ?? ''),
        recovery: recover ? state.recovery || 'unknown' : null, message: recover ? '已读取当前设置，草稿保留。请核对后继续；替换密钥需重新输入。' : '', displayMessages: (recover ? [message('image.settings.notice.review')] : []) });
      return true;
    }).catch((error: unknown) => { const code=errorCode(error); if (current(token)) publish({ phase: recover ? 'blocked' : 'load_error', message: recover ? '暂时无法核实保存结果。请重新读取，暂不能保存。' : code!==undefined&&codes.has(code) ? errorText(code) : '暂时无法读取图像设置，请重新读取。', displayMessages: (recover ? [message('image.settings.notice.readBlocked')] : (code!==undefined&&codes.has(code) ? [errorDescriptor(code)] : [message('image.settings.notice.loadError')])) }); return false; });
  }
  function save(value = ''): Promise<boolean> {
    if (!active || !visible || !imageSettingsCanSave(state)) return Promise.resolve(false);
    const draft=state.draft;
    if(!draft)return Promise.resolve(false);
    let configuration: ImageConfiguration|CustomImageConfiguration;
    try {
      configuration = slot === 'custom' ? customImageDraftConfiguration(draft) : copy(draft);
      if (slot === 'custom' && !customImageConfigurationSchema.safeParse(configuration).success) throw failure();
    } catch { publish({ phase: 'error', message: '请填写完整的 HTTPS 公网域名地址和模型标识，或同时清空地址与模型并关闭连接。地址不得含查询、凭据或非 443 端口。', displayMessages: [message('image.settings.issue.configuration')] }); return Promise.resolve(false); }
    const snapshot=state.snapshot;
    if(!snapshot)return Promise.resolve(false);
    const configured=property(snapshot.secret,'configured')===true, persistentAvailable=property(snapshot.storage,'persistentAvailable')===true;
    const issue = (slot === 'custom' && configured && imageSettingsBindingChanged(state) && !value && state.secretAction !== 'remove' ? '地址或模型已变化。请重新输入此连接的新密钥，或明确移除原密钥后保存；原密钥不会带到新地址。' : '') || imageKeyIssue(value) || (value && !['session', 'persistent'].includes(state.storage) ? '请选择密钥的保存方式。' : '') || (value && state.storage === 'persistent' && !persistentAvailable ? errorText('IMAGE_SETTINGS_STORAGE_UNAVAILABLE') : ''), issueDisplayMessage = ((slot === 'custom' && configured && imageSettingsBindingChanged(state) && !value && state.secretAction !== 'remove' ? message('image.settings.issue.binding') : null)) || imageKeyIssueDescriptor(value) || ((value && !['session', 'persistent'].includes(state.storage) ? message('image.settings.issue.storage') : null)) || ((value && state.storage === 'persistent' && !persistentAvailable ? errorDescriptor('IMAGE_SETTINGS_STORAGE_UNAVAILABLE') : null));
    if (issue) { publish({ phase: 'error', message: issue, displayMessages: issueDisplayMessage ? [issueDisplayMessage] : [] }); return Promise.resolve(false); }
    const token = ++epoch, revision = snapshot.revision;
    const secret = value ? { action: 'replace', storage: state.storage, value } : { action: state.secretAction };
    const expectedSecret = secret.action === 'replace' ? { configured: true, storage: state.storage } : secret.action === 'remove' ? { configured: false, storage: 'none' } : copy(snapshot.secret);
    publish({ phase: 'saving', draft: copy(configuration), secretAction: 'keep', message: '', displayMessages: [] });
    let operation: Promise<ImageSettingsResult|CustomImageSettingsResult>; try { operation = client.write({ expectedRevision: revision, configuration, secret }); } catch (error) { operation = Promise.reject(error); }
    // Completion and recovery handlers retain no credential or retry body.
    return Promise.resolve(operation).then(value_ => {
      if (!current(token)) return false;
      const safe = safeImageSettings(value_, slot);
      if (safe.revision !== revision + 1 || canonicalImageInput(safe.configuration) !== canonicalImageInput(configuration) || property(safe.secret,'configured') !== expectedSecret.configured || property(safe.secret,'storage') !== expectedSecret.storage) throw failure('INVALID_RESPONSE');
      onSnapshot(copy(safe));
      const configuredNow=property(safe.secret,'configured')===true,storageNow=property(safe.secret,'storage');
      publish({ snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, message: `图像设置已保存。${configuredNow ? storageNow === 'persistent' ? '密钥由系统加密保存。' : '密钥仅在本次后端运行中保留。' : '尚未配置密钥。'}保存不会发送图像请求；真实调用尚未验证。`, displayMessages: [message(configuredNow ? storageNow === 'persistent' ? 'image.settings.notice.savedPersistent' : 'image.settings.notice.savedSession' : 'image.settings.notice.savedNone')] }); return true;
    }).catch((error: unknown) => {
      if (!current(token)) return false;
      const code=errorCode(error);
      if (code!==undefined&&['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION'].includes(code)) { publish({ phase: 'error', message: `${errorText(code)}新输入的密钥已清空。`, displayMessages: [errorDescriptor(code), message('image.settings.notice.keyCleared')] }); return false; }
      const recovery: ImageRecovery = code === 'IMAGE_SETTINGS_CONFLICT' ? 'conflict' : 'unknown';
      publish({ phase: 'reconciling', recovery, message: '正在读取当前状态，不会自动重新保存。', displayMessages: [message('image.settings.notice.rereading')] });
      return Promise.resolve().then(() => client.read()).then(snapshotValue => {
        if (!current(token)) return false;
        const safe = receive(snapshotValue);
        publish({ snapshot: safe, phase: 'review', storage: state.storage === 'persistent' && !property(safe.storage,'persistentAvailable') ? '' : state.storage,
          message: recovery === 'conflict' ? '设置已在其他窗口变化。你的草稿保留，请核对后继续；替换密钥需重新输入。' : `${errorText(code ?? '')}已读取当前状态，未自动重试。请核对后继续；替换密钥需重新输入。`, displayMessages: (recovery === 'conflict' ? [message('image.settings.notice.conflict')] : [errorDescriptor(code ?? ''), message('image.settings.notice.unknown')]) }); return false;
      }).catch(() => { if (current(token)) publish({ phase: 'blocked', message: '暂时无法核实保存结果。草稿保留，请重新读取后再保存。', displayMessages: [message('connections.notice.blocked')] }); return false; });
    });
  }
  return { getState: () => copy(state), load: () => read(), reload: () => read({ recover: Boolean(state.snapshot) }), save,
    setEnabled(enabled: unknown): boolean { if (!editable() || typeof enabled !== 'boolean' || !state.draft) return false; publish({ draft: { ...state.draft, enabled } }); return true; },
    setConfigurationField(field: unknown, value: unknown): boolean { if (!editable() || slot !== 'custom' || !['baseUrl', 'model'].includes(String(field)) || typeof value !== 'string' || !state.draft) return false; publish({ draft: { ...state.draft, [String(field)]: value } }); return true; },
    setStorage(storage: unknown): boolean { if (!editable() || typeof storage!=='string' || !['session', 'persistent'].includes(storage) || !state.snapshot) return false; const persistentAvailable=property(state.snapshot.storage,'persistentAvailable')===true; if(storage === 'persistent' && !persistentAvailable) return false; publish({ storage }); return true; },
    removeKey(remove = true): boolean { if (!editable()) return false; publish({ secretAction: remove ? 'remove' : 'keep' }); return true; },
    acknowledge(): boolean { if (!editable() || state.phase !== 'review' || !state.recovery) return false; publish({ recovery: null, phase: 'ready', message: '已保留草稿，请重新确认密钥操作后保存。', displayMessages: [message('image.settings.notice.keepDraft')] }); return true; },
    useLatest(): boolean { if (!editable() || state.phase === 'blocked' || !state.snapshot) return false; publish({ draft: copy(state.snapshot.configuration), secretAction: 'keep', recovery: null, phase: 'ready', message: '已使用当前已保存设置。', displayMessages: [message('connections.notice.useSaved')] }); return true; },
    setVisible(value: unknown): void { visible = Boolean(value); },
    dispose(): void { active = false; epoch++; state = initialImageSettingsState(); },
  };
}

// Display descriptors are transient UI metadata. Legacy diagnostics and request payloads remain unchanged.
export const imageKeyIssueDescriptor=(value: unknown): DisplayMessage|null => (typeof value==='string' && value && (!/^[\x21-\x7e]+$/.test(value) || value.length > IMAGE_SETTINGS_LIMITS.secretBytes) ? message('image.settings.issue.key', { bytes: IMAGE_SETTINGS_LIMITS.secretBytes }) : null);

const errorDescriptor=(code: string): DisplayMessage => ({ UNAUTHORIZED: message('connections.error.unauthorized'), IMAGE_SETTINGS_VALIDATION: message('image.settings.error.validation'), IMAGE_SETTINGS_STORAGE_UNAVAILABLE: message('image.settings.error.storage'), IMAGE_SETTINGS_CORRUPT: message('image.settings.error.corrupt'), IMAGE_SETTINGS_CLOSED: message('image.settings.error.closed') } as unknown as Readonly<Record<string,DisplayMessage>>)[['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED'].includes(code) ? code : 'UNKNOWN'] ?? message('connections.error.unknown');
