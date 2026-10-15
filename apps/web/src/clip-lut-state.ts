import { isLookPackInspectResponse, lookPackInspectResponseSchema } from '../../../packages/contracts/src/look-pack-inspection.ts';
import type { LookPackInspection } from '../../../packages/contracts/src/look-pack.ts';
import { isLookPackBytes, parseLookPackBytes } from '../../../packages/business/src/look-pack.ts';
import { clipColourSchema, isTimelineColourSourceInspection, TIMELINE_CLIP_COLOUR_PROFILE, TIMELINE_COLOUR_SOURCE_PROFILE, timelineColourSourceEvidenceStatus } from '../../../packages/contracts/src/timeline-colour.ts';
import type { ClipColour, TimelineColourSourceInspection } from '../../../packages/contracts/src/timeline-colour.ts';
import { isLutResponse, lutImportInputSchema, lutImportResponseSchema, lutInspectResponseSchema, lutListResponseSchema, LUT_RESOURCE_LIMITS } from '../../../packages/contracts/src/lut-resources.ts';
import { clipDraftEnvelopeSchema } from '../../../packages/contracts/src/local-drafts.ts';
import type { ClipDraftKey } from '../../../packages/contracts/src/local-drafts.ts';
import { createClipLutRecovery, clipLutRecoveryMetadata, sameClipLutRecovery, clipLutRecoveryKey } from './clip-lut-recovery.ts';
import type { ClipLutRecovery, ClipLutRecoveryMetadata, ClipLutRecoveryIdentity } from './clip-lut-recovery.ts';
import type { LutImportInput, LutResource } from '../../../packages/contracts/src/lut-resources.ts';

export type ClipLutRpc = (operation: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
export interface ClipLutContext {
  scope: string; projectId: string; timelineId: string; clipId: string; assetId: string; assetSha256: string;
  colour?: ClipColour | null; blocked: boolean;
}
type Range = '' | 'limited' | 'full';
type Phase = 'idle' | 'loading' | 'ready' | 'error';
export interface ClipLutImportRecord {
  input: LutImportInput; sha256: string; sizeBytes: number;
  phase: 'sending' | 'unknown' | 'imported' | 'rejected'; error: string; resource: LutResource | null;
}
export interface ClipLutState {
  opened: boolean; sourcePhase: Phase; inspection: TimelineColourSourceInspection | null; sourceError: string;
  range: Range; sourceDeclared: boolean; listPhase: Phase; resources: LutResource[]; nextAfter: string | null; listError: string;
  selectedId: string; selected: LutResource | null; resourcePhase: Phase; resourceError: string; lookDeclared: boolean;
  importing: boolean; importRecord: ClipLutImportRecord | null; importError: string;
  recoveryPhase: Phase; recovery: ClipLutRecoveryMetadata | null; recoveryError: string;
  packPhase: Phase; pack: LookPackInspection | null; packError: string;
}
const copy = <T>(value: T): T => structuredClone(value);
const pendingImports = new Map<string, ClipLutImportRecord>();
const initial = (): ClipLutState => ({ opened: false, sourcePhase: 'idle', inspection: null, sourceError: '', range: '', sourceDeclared: false,
  listPhase: 'idle', resources: [], nextAfter: null, listError: '', selectedId: '', selected: null, resourcePhase: 'idle', resourceError: '', lookDeclared: false,
  importing: false, importRecord: null, importError: '', recoveryPhase: 'idle', recovery: null, recoveryError: '', packPhase: 'idle', pack: null, packError: '' });
const ownerKey = (c: ClipLutContext): string => JSON.stringify([c.scope, c.projectId, c.timelineId, c.clipId, c.assetId, c.assetSha256]);
const normalized = (tag: string | null): string => (tag ?? '').trim().toLowerCase();
const absent = (tag: string | null): boolean => ['', 'unknown', 'unspecified', 'reserved'].includes(normalized(tag));
/** Declarations cannot override known HDR/Log, conflicting colour tags or range.
 * The backend additionally verifies the selected stream and supported format. */
export function clipLutSourceIssue(value: TimelineColourSourceInspection | null, range: Range): string {
  if (!value) return '请先检查当前来源。';
  if (value.status === 'unsupported' || timelineColourSourceEvidenceStatus(value.evidence) === 'unsupported') return value.reason || '此来源不支持当前 Rec.709 SDR 流程；HDR / Log、冲突标签、RGB / alpha 与不受支持的像素格式不能通过声明覆盖。';
  if (value.streamIndex === null || value.evidence.hdrMetadata || [value.evidence.primaries, value.evidence.transfer, value.evidence.matrix].some(tag => !absent(tag) && normalized(tag) !== 'bt709')) return '来源存在 HDR、Log 或非 Rec.709 标签，不能用手动声明覆盖。';
  const known = normalized(value.evidence.range);
  if (!absent(known) && !['tv', 'mpeg', 'limited', 'pc', 'jpeg', 'full'].includes(known)) return '来源范围标签不受支持。';
  if (!range) return '请明确选择源素材的 Limited 或 Full 范围。';
  if ((['tv', 'mpeg', 'limited'].includes(known) && range !== 'limited') || (['pc', 'jpeg', 'full'].includes(known) && range !== 'full')) return '所选范围与来源已知标签冲突，不能覆盖。';
  return '';
}
const errorMessage = (error: unknown, fallback: string): string => error instanceof Error ? error.message : fallback;
export function clipLutFileIssue(file: { name: string; size: number }): string {
  if (!/\.cube$/iu.test(file.name) || !file.name.length || file.name.length > 200) return '请选择名称不超过 200 字符的 .cube 文件。';
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > LUT_RESOURCE_LIMITS.sourceBytes) return '仅支持非空且不超过 7 MiB 的 .cube 文件；不会自动改写或缩小原文件。';
  return '';
}
export async function prepareClipLutImport(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, projectId: string, requestId: string): Promise<ClipLutImportRecord> {
  const issue = clipLutFileIssue(file); if (issue) throw Error(issue);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw Error('读取的文件大小已变化，请重新选择文件。');
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const input = lutImportInputSchema.parse({ projectId, requestId, name: file.name, dataBase64: btoa(binary) });
  return { input, sha256, sizeBytes: bytes.length, phase: 'sending', error: '', resource: null };
}

/** All mutations here are local draft edits except explicitly chosen LUT file
 * admission. Source/list/resource responses are fenced by the current owner;
 * only bounded recovery metadata persists; replay after reopening requires the
 * user to reselect identical bytes, then explicitly retry the original ID. */
export function createClipLutController({ getContext, rpc, edit, onChange = () => {}, newRequestId = () => crypto.randomUUID(), now = () => new Date().toISOString(), imports = pendingImports, timeoutMs = 30000, recovery = createClipLutRecovery(), readWorkspace }: {
  getContext: () => ClipLutContext; rpc: ClipLutRpc; edit: (value: ClipColour | null) => void; onChange?: (state: ClipLutState) => void;
  newRequestId?: () => string; now?: () => string; imports?: Map<string, ClipLutImportRecord>; timeoutMs?: number;
  recovery?: ClipLutRecovery; readWorkspace: (key: ClipDraftKey) => Promise<unknown>;
}) {
  let context = copy(getContext()), state = initial(), generation = 1, active = true, sourceSerial = 0, listSerial = 0, resourceSerial = 0;
  let workspaceScope: string | null = null, recoverySerial = 0;
  const emit = (patch: Partial<ClipLutState>): void => { state = { ...state, ...patch }; if (active) onChange(state); };
  const sync = (): void => {
    const next = getContext();
    if (ownerKey(next) !== ownerKey(context)) { generation++; state = initial(); workspaceScope = null; }
    context = copy(next);
  };
  const owns = (owner: number): boolean => { sync(); return active && owner === generation; };
  const allowed = (): boolean => { sync(); return active && state.opened && !context.blocked; };
  const call = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([rpc(operation, input, { signal: controller.signal }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('请求尚未确认，请重试原请求。')); }, timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  async function verifyWorkspace(owner: number): Promise<ClipLutRecoveryIdentity> {
    const key = { projectId: context.projectId, timelineId: context.timelineId, clipId: context.clipId };
    const response = await readWorkspace(key);
    if (!owns(owner) || context.blocked) throw Error('项目或片段已变化，未提交导入。');
    const result = clipDraftEnvelopeSchema.safeParse(response);
    if (!result.success || !result.data.supported || result.data.targetStatus === 'missing' ||
        Object.entries(key).some(([name, value]) => result.data.supported && result.data.key[name as keyof ClipDraftKey] !== value)) throw Error('无法核对当前工作区身份，已阻止导入。');
    if (workspaceScope !== null && workspaceScope !== result.data.workspaceScope) throw Error('工作区身份已变化，已阻止导入。请重新打开项目核对，原恢复记录不会转移。');
    workspaceScope = result.data.workspaceScope;
    return { workspaceScope, projectId: key.projectId };
  }
  async function sendImport(record: ClipLutImportRecord, owner: number, replay: boolean): Promise<boolean> {
    let metadata: ClipLutRecoveryMetadata, key: string;
    emit({ importing: true, importError: '' });
    try {
      const identity = await verifyWorkspace(owner);
      metadata = clipLutRecoveryMetadata(identity, record); key = clipLutRecoveryKey(identity);
      if (replay) await recovery.verify(metadata); else await recovery.reserve(metadata);
      if (!owns(owner) || context.blocked) {
        if (owns(owner)) emit({ importing: false, recovery: metadata, recoveryPhase: 'ready', recoveryError: '原请求记录已保留，但当前不可提交；请恢复连接后核对原请求。' });
        return false;
      }
      emit({ recovery: metadata, recoveryPhase: 'ready', recoveryError: '' });
    } catch (error) {
      if (owns(owner)) emit({ importing: false, recoveryPhase: 'error', recoveryError: errorMessage(error, '无法保存原请求恢复记录，未提交导入。') });
      return false;
    }
    record.phase = 'sending'; record.error = ''; imports.set(key, record);
    emit({ importRecord: copy(record) });
    try {
      const value = await call('lut.import', record.input);
      if (!isLutResponse('lut.import', record.input, value)) throw Error('导入回复与原请求不一致，结果仍待确认。');
      const result = lutImportResponseSchema.parse(value);
      if (result.resource.sha256 !== record.sha256 || result.resource.sizeBytes !== record.sizeBytes) throw Error('导入回复与原文件指纹不一致，结果仍待确认。');
      record.phase = 'imported'; record.resource = result.resource;
    } catch (error) {
      const known = error as { definitive?: boolean; code?: string };
      record.phase = known.definitive === true && ['VALIDATION_ERROR', 'LUT_FORMAT_UNSUPPORTED', 'LUT_SOURCE_TOO_LARGE'].includes(known.code ?? '') ? 'rejected' : 'unknown';
      record.error = errorMessage(error, '导入结果尚未确认，请仅重试原请求。');
    }
    let retained: ClipLutRecoveryMetadata | null = metadata, cleanupError = '';
    if (record.phase === 'imported' || record.phase === 'rejected') {
      try { await recovery.complete(metadata); retained = null; imports.delete(key); }
      catch (error) { cleanupError = errorMessage(error, '原请求已确认，但恢复记录尚未安全清除。'); }
    }
    if (owns(owner)) {
      const resource = record.resource;
      emit({ importing: false, importRecord: copy(record), recovery: retained, recoveryPhase: cleanupError ? 'error' : 'ready', recoveryError: cleanupError,
        resources: resource && !state.resources.some(item => item.id === resource.id) ? [...state.resources, resource] : state.resources });
    }
    return record.phase === 'imported';
  }
  const controller = {
    getState: (): ClipLutState => state,
    activate(): void { active = true; sync(); },
    refresh(): void { sync(); emit({}); },
    open(): boolean {
      sync(); if (!active || context.blocked) return false;
      emit({ opened: true });
      void controller.inspectSource(); void controller.loadResources(); void controller.checkRecovery(); return true;
    },
    async checkRecovery(): Promise<void> {
      if (!allowed() || state.importing) return;
      const owner = generation, serial = ++recoverySerial;
      emit({ recoveryPhase: 'loading', recoveryError: '' });
      try {
        const identity = await verifyWorkspace(owner), metadata = await recovery.read(identity);
        if (!owns(owner) || serial !== recoverySerial) return;
        const record = imports.get(clipLutRecoveryKey(identity));
        if (record && (!metadata || !sameClipLutRecovery(metadata, clipLutRecoveryMetadata(identity, record)))) throw Error('LUT 恢复记录已变化，已停止导入；请核对原请求。');
        emit({ recoveryPhase: 'ready', recovery: metadata, importRecord: record ? copy(record) : null });
      } catch (error) { if (owns(owner) && serial === recoverySerial) emit({ recoveryPhase: 'error', recoveryError: errorMessage(error, '无法核对导入恢复记录。') }); }
    },
    async clearConfirmedRecovery(): Promise<boolean> {
      if (!allowed() || state.importing || !state.recovery || !state.importRecord || !['imported', 'rejected'].includes(state.importRecord.phase)) return false;
      const owner = generation, metadata = copy(state.recovery);
      try {
        const identity = await verifyWorkspace(owner);
        if (identity.workspaceScope !== metadata.workspaceScope || identity.projectId !== metadata.projectId) return false;
        await recovery.complete(metadata);
        if (!owns(owner)) return false;
        imports.delete(clipLutRecoveryKey(identity)); emit({ recovery: null, recoveryPhase: 'ready', recoveryError: '' }); return true;
      } catch (error) { if (owns(owner)) emit({ recoveryError: errorMessage(error, '已确认请求的恢复记录尚未安全清除。') }); return false; }
    },
    async inspectSource(): Promise<void> {
      if (!allowed()) return;
      const owner = generation, serial = ++sourceSerial, input = { projectId: context.projectId, assetId: context.assetId }, hash = context.assetSha256;
      emit({ sourcePhase: 'loading', inspection: null, sourceError: '', range: '', sourceDeclared: false });
      try {
        const value = await call('timeline.colour.source.inspect', input);
        if (!owns(owner) || serial !== sourceSerial) return;
        if (!isTimelineColourSourceInspection(value, input) || value.assetSha256 !== hash) throw Error('来源检查回复与当前素材或文件指纹不一致。');
        emit({ sourcePhase: 'ready', inspection: copy(value) });
      } catch (error) { if (owns(owner) && serial === sourceSerial) emit({ sourcePhase: 'error', sourceError: errorMessage(error, '来源检查失败。') }); }
    },
    chooseRange(value: string): void { if (allowed() && ['', 'limited', 'full'].includes(value)) emit({ range: value as Range, sourceDeclared: false }); },
    declareSource(value: boolean): void { if (allowed()) emit({ sourceDeclared: value }); },
    confirmSource(): boolean {
      if (!allowed() || !state.sourceDeclared || state.sourcePhase !== 'ready' || clipLutSourceIssue(state.inspection, state.range)) return false;
      const inspected = state.inspection!;
      if (inspected.assetId !== context.assetId || inspected.assetSha256 !== context.assetSha256) return false;
      const next: ClipColour = { profileId: TIMELINE_CLIP_COLOUR_PROFILE, source: { assetSha256: inspected.assetSha256, streamIndex: inspected.streamIndex!,
        profileId: TIMELINE_COLOUR_SOURCE_PROFILE, range: state.range as 'limited' | 'full', declaredBy: 'user', declaredAt: now() }, look: context.colour?.look ?? null };
      edit(clipColourSchema.parse(next)); emit({ sourceDeclared: false }); return true;
    },
    disableColour(): boolean { if (!allowed()) return false; edit(null); return true; },
    async loadResources(more = false): Promise<void> {
      if (!allowed() || state.listPhase === 'loading' || more && !state.nextAfter) return;
      const owner = generation, serial = ++listSerial, input = { projectId: context.projectId, limit: 50, ...(more ? { after: state.nextAfter! } : {}) };
      emit({ listPhase: 'loading', listError: '' });
      try {
        const value = await call('lut.list', input); if (!owns(owner) || serial !== listSerial) return;
        if (!isLutResponse('lut.list', input, value)) throw Error('LUT 列表回复与当前项目不一致。');
        const result = lutListResponseSchema.parse(value), merged = more ? [...state.resources, ...result.items] : result.items;
        emit({ listPhase: 'ready', resources: [...new Map(merged.map(item => [item.id, item])).values()], nextAfter: result.nextAfter });
      } catch (error) { if (owns(owner) && serial === listSerial) emit({ listPhase: 'error', listError: errorMessage(error, 'LUT 列表读取失败。') }); }
    },
    async selectResource(resourceId: string): Promise<void> {
      if (!allowed() || resourceId && !state.resources.some(item => item.id === resourceId)) return;
      const owner = generation, serial = ++resourceSerial;
      emit({ selectedId: resourceId, selected: null, resourcePhase: resourceId ? 'loading' : 'idle', resourceError: '', lookDeclared: false, packPhase: 'idle', pack: null, packError: '' });
      if (!resourceId) return;
      const input = { projectId: context.projectId, lutId: resourceId };
      try {
        const value = await call('lut.inspect', input); if (!owns(owner) || serial !== resourceSerial) return;
        if (!isLutResponse('lut.inspect', input, value)) throw Error('LUT 核验回复与当前选择不一致。');
        const resource = lutInspectResponseSchema.parse(value).resource, listed = state.resources.find(item => item.id === resourceId);
        if (!listed || resource.sha256 !== listed.sha256 || resource.profile !== listed.profile) throw Error('LUT 指纹已变化，请重新读取列表。');
        emit({ selected: resource, resourcePhase: 'ready' });
      } catch (error) { if (owns(owner) && serial === resourceSerial) emit({ resourcePhase: 'error', resourceError: errorMessage(error, 'LUT 核验失败。') }); }
    },
    async inspectSelectedPack(): Promise<void> {
      if (!allowed() || state.resourcePhase !== 'ready' || !state.selected || state.packPhase === 'loading') return;
      const owner = generation, selected = copy(state.selected), serial = resourceSerial;
      const input = { projectId: context.projectId, lutId: selected.id };
      emit({ packPhase: 'loading', pack: null, packError: '' });
      try {
        const value = await call('lut.look.inspect', input);
        if (!owns(owner) || serial !== resourceSerial) return;
        if (!isLookPackInspectResponse(value, input)) throw Error('数据包检查回复与所选项目资源不一致。');
        const result = lookPackInspectResponseSchema.parse(value);
        if (result.resource.sha256 !== selected.sha256 || result.resource.sizeBytes !== selected.sizeBytes) throw Error('数据包资源指纹已变化，请重新读取列表。');
        emit({ packPhase: 'ready', pack: result.pack });
      } catch (error) {
        if (owns(owner) && serial === resourceSerial) emit({ packPhase: 'error', packError: errorMessage(error, '无法核验所选资源的数据包声明。') });
      }
    },
    declareLook(value: boolean): void { if (allowed()) emit({ lookDeclared: value }); },
    applyLook(): boolean {
      if (!allowed() || !context.colour?.source || context.colour.source.assetSha256 !== context.assetSha256 || !state.lookDeclared || !state.selected || state.resourcePhase !== 'ready') return false;
      const resource = state.selected;
      if (resource.projectId !== context.projectId || resource.id !== state.selectedId) return false;
      edit({ ...context.colour, look: { resourceId: resource.id, resourceSha256: resource.sha256, resourceProfile: resource.profile,
        purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 1 } });
      emit({ lookDeclared: false }); return true;
    },
    changeLook(patch: { enabled?: boolean; strength?: number }): boolean {
      if (!allowed() || !context.colour?.look) return false;
      const next = { ...context.colour, look: { ...context.colour.look, ...patch } };
      if (!clipColourSchema.safeParse(next).success) return false; edit(next); return true;
    },
    removeLook(): boolean { if (!allowed() || !context.colour) return false; edit({ ...context.colour, look: null }); return true; },
    async importFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, options?: { lookPackConfirmed: true }): Promise<boolean> {
      if (!allowed() || state.importing || state.recoveryPhase !== 'ready' || workspaceScope === null) return false;
      if (state.recovery) { emit({ importError: '已有导入请求待确认，请重新选择原文件恢复原请求。' }); return false; }
      const owner = generation, projectId = context.projectId; emit({ importing: true, importError: '' });
      let record: ClipLutImportRecord;
      try {
        record = await prepareClipLutImport(file, projectId, newRequestId());
        // Data packs are still exact Cube bytes, but this UI never silently
        // bypasses the preview / publisher-license acknowledgement step.
        const bytes = Uint8Array.from(atob(record.input.dataBase64), char => char.charCodeAt(0));
        const packed = /\.mioon-look\.cube$/iu.test(file.name) || isLookPackBytes(bytes);
        if (packed && !options?.lookPackConfirmed) throw Error('这是单 Look 数据包，请使用“预览单 Look 数据包”入口查看声明后明确采用。');
        if (options?.lookPackConfirmed) await parseLookPackBytes(bytes);
      }
      catch (error) { if (owns(owner)) emit({ importing: false, importError: errorMessage(error, '文件读取失败。') }); return false; }
      if (!owns(owner) || context.blocked) { if (owns(owner)) emit({ importing: false }); return false; }
      return await sendImport(record, owner, false);
    },
    async reselectImportFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<boolean> {
      if (!allowed() || state.importing || state.recoveryPhase !== 'ready' || !state.recovery) return false;
      const owner = generation, metadata = copy(state.recovery); emit({ importing: true, importError: '' });
      try {
        if (file.name !== metadata.name || file.size !== metadata.sizeBytes) throw Error('必须重新选择原文件：文件名与字节数必须完全一致，不会更换原请求编号。');
        const record = await prepareClipLutImport(file, metadata.projectId, metadata.requestId);
        if (!owns(owner) || context.blocked) return false;
        const identity = await verifyWorkspace(owner);
        if (!sameClipLutRecovery(metadata, clipLutRecoveryMetadata(identity, record))) throw Error('文件 SHA-256 与原文件不一致，未恢复或提交原请求。');
        await recovery.verify(metadata);
        if (!owns(owner) || context.blocked) return false;
        record.phase = 'unknown'; record.error = '';
        imports.set(clipLutRecoveryKey(identity), record); emit({ importRecord: copy(record) }); return true;
      } catch (error) { if (owns(owner)) emit({ importError: errorMessage(error, '原文件核验失败，未提交导入。') }); return false; }
      finally { if (owns(owner)) emit({ importing: false }); }
    },
    async retryImport(): Promise<boolean> {
      if (!allowed() || state.importing || state.recoveryPhase !== 'ready' || !state.recovery || workspaceScope === null) return false;
      const record = imports.get(clipLutRecoveryKey({ workspaceScope, projectId: context.projectId }));
      if (!record || record.phase !== 'unknown') return false;
      return await sendImport(record, generation, true);
    },
    dispose(): void { active = false; generation++; },
  };
  return controller;
}
export type ClipLutController = ReturnType<typeof createClipLutController>;
