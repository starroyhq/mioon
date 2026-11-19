import { message, translate } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT, imageSettingsResultSchema, customImageSettingsResultSchema, customImageConfigurationSchema, normalizeCustomImageBaseUrl, getCustomImageDestination, canonicalImageInput } from '@mioon/contracts';
import { unavailableSecretStorage, watchPendingSecretStorage } from './settings-secret-storage.ts';
import { settingsRecoveryVerdict, settingsRecoveryRetryable, settingsRecoveryMessages, settingsRecoveryMessageText } from './settings-recovery.ts';

export { DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION, IMAGE_SETTINGS_LIMITS, CUSTOM_IMAGE_ENDPOINT_LIMIT };
export type ImageSettingsResult=ReturnType<typeof imageSettingsResultSchema.parse>;
export type CustomImageSettingsResult=ReturnType<typeof customImageSettingsResultSchema.parse>;
export type ImageSettingsSlot='official'|'custom';
export interface ImageConfiguration {enabled: boolean; baseUrl: string; model: string; [key: string]: unknown}
export interface CustomImageConfiguration extends ImageConfiguration {providerId: 'openai-compatible'; [key: string]: unknown}
export type ImageSettingsUpdate=Record<string, unknown>;
export interface ImageClientError extends Error {code: string}
export interface ImageSettingsClient {
  read(signal?: AbortSignal): Promise<ImageSettingsResult|CustomImageSettingsResult>;
  write(input: {expectedRevision: number; configuration: ImageConfiguration|CustomImageConfiguration; secret: Record<string, unknown>}): Promise<ImageSettingsResult|CustomImageSettingsResult>;
}
export interface ImageSettingsClientOptions {fetchImpl?: typeof fetch; timeoutMs?: number; slot?: ImageSettingsSlot}
export type ImageSecretAction='keep'|'remove';
export type ImageRecovery='conflict'|'unknown'|null;
export interface ImageSettingsState {
  phase: string;
  snapshot: ImageSettingsResult|CustomImageSettingsResult|null;
  keychainWaitConfirmed: boolean;
  draft: ImageConfiguration|CustomImageConfiguration|null;
  secretAction: ImageSecretAction;
  recovery: ImageRecovery;
  recoveryRetryable: boolean;
  recoverySecret: boolean;
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
  retryStorage(): void;
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
  async function request(method: string, body?: string, signal?: AbortSignal): Promise<ImageSettingsResult|CustomImageSettingsResult> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>|undefined;
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const transport = (async () => {
      const response = await fetchImpl(details.route, { method, credentials: 'same-origin', cache: 'no-store', signal: requestSignal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
      let envelope: unknown; try { envelope = await response.json(); } catch { throw failure('INVALID_RESPONSE'); }
      if (!response.ok || property(envelope,'ok') !== true) { const code=errorCode(property(envelope,'error')); throw failure(response.status === 401 ? 'UNAUTHORIZED' : code!==undefined&&codes.has(code) ? code : 'NETWORK'); }
      return safeImageSettings(property(envelope,'data'), slot);
    })();
    try { return timeoutMs > 0 ? await Promise.race([transport, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs); })]) : await transport; }
    catch (error) { const code=errorCode(error); throw failure(code!==undefined&&(codes.has(code) || code === 'INVALID_RESPONSE') ? code : 'NETWORK'); }
    finally { clearTimeout(timer); }
  }
  return { read: (signal?: AbortSignal) => request('GET', undefined, signal), write: (input: {expectedRevision: number; configuration: ImageConfiguration|CustomImageConfiguration; secret: Record<string, unknown>}) => request('PUT', JSON.stringify(input)) };
}
export const initialImageSettingsState=(): ImageSettingsState => ({ phase: 'loading', snapshot: null, keychainWaitConfirmed: false, draft: null, secretAction: 'keep', recovery: null, recoveryRetryable: false, recoverySecret: false, message: '', displayMessages: [] });
export const imageSettingsBusy=(state: ImageSettingsState): boolean=>['loading', 'saving', 'reconciling'].includes(state.phase);
export const imageSettingsEditable=(state: ImageSettingsState): boolean=>Boolean(state.snapshot) && !imageSettingsBusy(state);
// A retry after an unknown save is an explicit user action with the freshly
// read revision; it is offered only when no replacement secret was consumed.
export const imageSettingsCanSave=(state: ImageSettingsState): boolean=>imageSettingsEditable(state) && state.phase !== 'blocked' &&
  (!state.recovery || state.recovery === 'unknown' && state.recoveryRetryable);
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
const errorText=(code: string): string => ({ UNAUTHORIZED: '登录会话已过期，请重新登录后打开设置。', IMAGE_SETTINGS_VALIDATION: '设置未通过校验，请检查地址、模型和密钥格式。', IMAGE_SETTINGS_STORAGE_UNAVAILABLE: translate('zh-Hans', 'connections.storage.unavailableReason'), IMAGE_SETTINGS_CORRUPT: '无法读取安全设置，不会覆盖已有设置。', IMAGE_SETTINGS_CLOSED: '设置服务已关闭，请重新打开应用。' } as Readonly<Record<string,string>>)[code] || '未收到保存确认，结果可能已经生效。';

/** Only redacted metadata belongs in state. A replacement secret is used once. */
export function createImageSettingsSession({ slot = 'official', client = createImageSettingsClient({ slot }), onChange = () => {}, onSnapshot = () => {} }: ImageSettingsSessionOptions = {}): ImageSettingsSession {
  slotDetails(slot);
  let state = initialImageSettingsState(), active = true, visible = true, epoch = 0;
  const refreshStorage = async (signal?: AbortSignal) => {
    const before = state.snapshot;
    if (!before) return;
    const {storage} = safeImageSettings(await client.read(signal), slot);
    if (!active || !visible || signal?.aborted || state.snapshot !== before) return;
    if (storage.reasonCode !== 'OS_SECRET_STORE_PENDING') {
      const snapshot = {...before, storage};
      onSnapshot(copy(snapshot));
      publish({snapshot});
    } else if (before.storage.reasonCode !== 'OS_SECRET_STORE_PENDING' || !state.keychainWaitConfirmed) publish({snapshot: {...before, storage}, keychainWaitConfirmed: true});
  };
  const watchStorage = watchPendingSecretStorage(refreshStorage);
  const observeStorage = () => watchStorage(active && visible && state.snapshot?.storage.reasonCode === 'OS_SECRET_STORE_PENDING');
  const publish = (patch: Partial<ImageSettingsState>): void => { if (active) {
    state = {...state, ...patch};
    if (state.snapshot?.storage.reasonCode !== 'OS_SECRET_STORE_PENDING') state.keychainWaitConfirmed = false;
    observeStorage(); onChange(copy(state));
  } };
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
      publish({ snapshot: safe, draft: recover && state.draft ? state.draft : copy(safe.configuration), phase: recover ? 'review' : 'ready', secretAction: 'keep',
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
    if (value && !snapshot.storage.persistentAvailable) return Promise.resolve(false);
    const configured=property(snapshot.secret,'configured')===true;
    const bindingNeedsKey = slot === 'custom' && configured && imageSettingsBindingChanged(state) && !value && state.secretAction !== 'remove';
    const issue = bindingNeedsKey ? '地址或模型已变化。请重新输入此连接的新密钥，或明确移除原密钥后保存；原密钥不会带到新地址。' : imageKeyIssue(value);
    const issueDisplayMessage = bindingNeedsKey ? message('image.settings.issue.binding') : imageKeyIssueDescriptor(value);
    if (issue) { publish({ phase: 'error', message: issue, displayMessages: issueDisplayMessage ? [issueDisplayMessage] : [] }); return Promise.resolve(false); }
    const token = ++epoch, revision = snapshot.revision;
    const secret = value ? { action: 'replace', storage: 'persistent', value } : { action: state.secretAction };
    const expectedSecret = secret.action === 'replace' ? { configured: true, storage: 'persistent' } : secret.action === 'remove' ? { configured: false, storage: 'none' } : copy(snapshot.secret);
    publish({ phase: 'saving', draft: copy(configuration), secretAction: 'keep', message: '', displayMessages: [] });
    let operation: Promise<ImageSettingsResult|CustomImageSettingsResult>; try { operation = client.write({ expectedRevision: revision, configuration, secret }); } catch (error) { operation = Promise.reject(error); }
    // Completion and recovery handlers retain no credential or retry body.
    return Promise.resolve(operation).then(value_ => {
      if (!current(token)) return false;
      const safe = safeImageSettings(value_, slot);
      if (safe.revision !== revision + 1 || canonicalImageInput(safe.configuration) !== canonicalImageInput(configuration) || property(safe.secret,'configured') !== expectedSecret.configured || property(safe.secret,'storage') !== expectedSecret.storage) throw failure('INVALID_RESPONSE');
      onSnapshot(copy(safe));
      const configuredNow=property(safe.secret,'configured')===true;
      const savedMessage = configuredNow ? 'image.settings.notice.savedPersistent' : 'image.settings.notice.savedNone';
      publish({snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, recoveryRetryable: false, recoverySecret: false, message: translate('zh-Hans', savedMessage), displayMessages: [message(savedMessage)]}); return true;
    }).catch((error: unknown) => {
      if (!current(token)) return false;
      const code=errorCode(error);
      if (code === 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE') {const unavailable = {...snapshot, storage: unavailableSecretStorage}; onSnapshot(copy(unavailable)); publish({snapshot: unavailable, phase: 'error', message: '', displayMessages: []}); return false;}
      if (code!==undefined&&['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION'].includes(code)) { publish({ phase: 'error', message: `${errorText(code)}新输入的密钥已清空。`, displayMessages: [errorDescriptor(code), message('image.settings.notice.keyCleared')] }); return false; }
      const recovery: ImageRecovery = code === 'IMAGE_SETTINGS_CONFLICT' ? 'conflict' : 'unknown';
      const secretReplaced = secret.action === 'replace';
      publish({ phase: 'reconciling', recovery, message: '正在读取当前状态。', displayMessages: [message('image.settings.notice.rereading')] });
      return Promise.resolve().then(() => client.read()).then(snapshotValue => {
        if (!current(token)) return false;
        const safe = receive(snapshotValue);
        const verdict = settingsRecoveryVerdict({ revision: safe.revision, fingerprint: canonicalImageInput(safe.configuration), secret: { configured: property(safe.secret,'configured') === true, storage: String(property(safe.secret,'storage') ?? '') } },
          { revision, fingerprint: canonicalImageInput(configuration), secret: { configured: expectedSecret.configured, storage: expectedSecret.storage }, secretReplaced, conflict: recovery === 'conflict' });
        if (verdict === 'applied') {
          const configuredNow = property(safe.secret,'configured') === true, savedMessage = configuredNow ? 'image.settings.notice.savedPersistent' : 'image.settings.notice.savedNone';
          publish({ snapshot: safe, draft: copy(safe.configuration), phase: 'saved', recovery: null, recoveryRetryable: false, recoverySecret: false, message: translate('zh-Hans', savedMessage), displayMessages: [message(savedMessage)] });
          return true;
        }
        publish({ snapshot: safe, phase: 'review', recovery, recoveryRetryable: settingsRecoveryRetryable(verdict, secretReplaced), recoverySecret: secretReplaced,
          message: settingsRecoveryMessageText(verdict, secretReplaced), displayMessages: settingsRecoveryMessages(verdict, secretReplaced) });
        return false;
      }).catch(() => { if (current(token)) publish({ phase: 'blocked', recoveryRetryable: true, recoverySecret: secretReplaced, message: '暂时无法核实保存结果。草稿保留，请重新读取后再保存。', displayMessages: [message('connections.notice.blocked')] }); return false; });
    });
  }
  return { getState: () => copy(state), load: () => read(), reload: () => read({ recover: Boolean(state.snapshot) }), save,
    setEnabled(enabled: unknown): boolean { if (!editable() || typeof enabled !== 'boolean' || !state.draft) return false; publish({ draft: { ...state.draft, enabled } }); return true; },
    setConfigurationField(field: unknown, value: unknown): boolean { if (!editable() || slot !== 'custom' || !['baseUrl', 'model'].includes(String(field)) || typeof value !== 'string' || !state.draft) return false; publish({ draft: { ...state.draft, [String(field)]: value } }); return true; },
    retryStorage(): void {if (editable()) void refreshStorage().catch(() => {});},
    removeKey(remove = true): boolean { if (!editable()) return false; publish({ secretAction: remove ? 'remove' : 'keep' }); return true; },
    acknowledge(): boolean { if (!editable() || state.phase !== 'review' || !state.recovery) return false; publish({ recovery: null, phase: 'ready', message: '已保留草稿，请重新确认密钥操作后保存。', displayMessages: [message('image.settings.notice.keepDraft')] }); return true; },
    useLatest(): boolean { if (!editable() || state.phase === 'blocked' || !state.snapshot) return false; publish({ draft: copy(state.snapshot.configuration), secretAction: 'keep', recovery: null, phase: 'ready', message: '已使用当前已保存设置。', displayMessages: [message('connections.notice.useSaved')] }); return true; },
    setVisible(value: unknown): void { visible = Boolean(value); observeStorage(); if (!visible && state.keychainWaitConfirmed) publish({keychainWaitConfirmed: false}); },
    dispose(): void { active = false; watchStorage(false); epoch++; state = initialImageSettingsState(); },
  };
}

// Display descriptors are transient UI metadata. Legacy diagnostics and request payloads remain unchanged.
export const imageKeyIssueDescriptor=(value: unknown): DisplayMessage|null => (typeof value==='string' && value && (!/^[\x21-\x7e]+$/.test(value) || value.length > IMAGE_SETTINGS_LIMITS.secretBytes) ? message('image.settings.issue.key', { bytes: IMAGE_SETTINGS_LIMITS.secretBytes }) : null);

const errorDescriptor=(code: string): DisplayMessage => ({ UNAUTHORIZED: message('connections.error.unauthorized'), IMAGE_SETTINGS_VALIDATION: message('image.settings.error.validation'), IMAGE_SETTINGS_STORAGE_UNAVAILABLE: message('connections.storage.unavailableReason'), IMAGE_SETTINGS_CORRUPT: message('image.settings.error.corrupt'), IMAGE_SETTINGS_CLOSED: message('image.settings.error.closed') } as unknown as Readonly<Record<string,DisplayMessage>>)[['UNAUTHORIZED', 'IMAGE_SETTINGS_VALIDATION', 'IMAGE_SETTINGS_STORAGE_UNAVAILABLE', 'IMAGE_SETTINGS_CORRUPT', 'IMAGE_SETTINGS_CLOSED'].includes(code) ? code : 'UNKNOWN'] ?? message('connections.error.unknown');
