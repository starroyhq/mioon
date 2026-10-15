import { isClipAudioRole } from '../../../packages/contracts/src/timeline-audio-role.ts';
import { clipAudioRoleChanged } from './clip-audio-role-state.ts';
import { message as displayMessage } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';
import { recoveryDisplayError, recoveryErrorMessage } from './recovery-display.ts';
import { clipColourSchema } from '../../../packages/contracts/src/timeline-colour.ts';
import type { ClipColour } from '../../../packages/contracts/src/timeline-colour.ts';
import { clipDraftFailure } from './clip-draft-client.ts';
import type { ClipDraftFailure } from './clip-draft-client.ts';
import type { EditorCloseOwnerSnapshot } from './editor-window-close.ts';
import type { ClipDraftKey, ClipDraftSource, ClipDraftRaw, ClipDraftValue, ClipDraftWrite, ClipDraftDelete, ClipDraftEnvelope as WireEnvelope } from '../../../packages/contracts/src/local-drafts.ts';
export type { ClipDraftKey, ClipDraftSource, ClipDraftRaw, ClipDraftWrite, ClipDraftDelete } from '../../../packages/contracts/src/local-drafts.ts';
/** Unsent local form state. None of these methods executes a business request. */
export type ClipDraftNumber = number | string;
export type ClipDraftRecord = ClipDraftValue;
export type ClipDraftEnvelope = Extract<WireEnvelope, { supported: true }>;
export type ClipDraftUnsupported = Extract<WireEnvelope, { supported: false }>;
export type ClipDraftRead = WireEnvelope;
export interface ClipDraftClient { get(key: ClipDraftKey): Promise<ClipDraftRead>; put(value: ClipDraftWrite): Promise<ClipDraftEnvelope>; remove(value: ClipDraftDelete): Promise<ClipDraftEnvelope> }
export interface ClipDraftContext extends ClipDraftKey {
  scope: string; restored: boolean; connected: boolean; busy: boolean; visible: boolean;
  audioRoleEditable?: boolean;
  timelineRevision: number; source: ClipDraftSource; saved: ClipDraftRaw;
}
export interface ClipDraftCapture extends Readonly<ClipDraftKey> { readonly scope: string; readonly serial: number; readonly generation: number }
export type ClipDraftPhase = 'loading' | 'ready' | 'saving' | 'saved' | 'error' | 'conflict' | 'unsupported';
export interface ClipDraftState {
  raw: ClipDraftRaw; dirty: boolean; baseRevision: number; source: ClipDraftSource; conflict: boolean;
  phase: ClipDraftPhase; error: string; errorDisplay?: MessageDescriptor; candidate: ClipDraftRecord | null; savedAt: string | null; submitting: boolean; businessPending: boolean;
  autosavePaused: boolean; failure: ClipDraftFailure | null; retainedRecord: boolean;
}
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const copy = <T>(value: T): T => structuredClone(value);
export const sameClipDraftValue = (left: unknown, right: unknown): boolean => JSON.stringify(left, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value) === JSON.stringify(right, (_, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const keyOf = (context: ClipDraftContext): ClipDraftKey => ({ projectId: context.projectId, timelineId: context.timelineId, clipId: context.clipId });
const message = (error: unknown): string => error instanceof Error ? error.message : '本地草稿未能确认保存；当前输入仍保留。';
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const number = (value: ClipDraftNumber): number => typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? NaN : Number(value);

/** No empty/whitespace numeric input is silently normalized to zero. */
export function clipDraftPatch(raw: ClipDraftRaw): Record<string, unknown> | null {
  const patch: Record<string, unknown> = { name: raw.name, trackId: raw.trackId };
  if (!raw.name.length || raw.name.length > 200) return null;
  for (const field of ['startFrame', 'durationFrames', 'sourceInFrame', 'gain', 'fadeInFrames', 'fadeOutFrames'] as const) {
    if (!own(raw, field)) continue;
    const value = number(raw[field]!);
    if (!Number.isFinite(value) || field !== 'gain' && !Number.isSafeInteger(value)) return null;
    patch[field] = value;
  }
  if (Number(patch.startFrame) < 0 || Number(patch.durationFrames) < 1 || Number(patch.durationFrames) > 18000 || Number(patch.startFrame) + Number(patch.durationFrames) > 18000 || Number(patch.sourceInFrame) < 0 || Number(patch.gain) < 0 || Number(patch.gain) > 2) return null;
  const rect = Object.fromEntries(Object.entries(raw.rect).map(([key, value]) => [key, number(value)]));
  if (Object.values(rect).some(value => !Number.isSafeInteger(value) || value % 2 !== 0) || rect.x < 0 || rect.y < 0 || rect.width < 2 || rect.height < 2) return null;
  for (const field of ['fadeInFrames', 'fadeOutFrames']) if (own(patch, field) && (Number(patch[field]) < 0 || Number(patch[field]) > Number(patch.durationFrames))) return null;
  if (Number(patch.fadeInFrames ?? 0) + Number(patch.fadeOutFrames ?? 0) > Number(patch.durationFrames)) return null;
  if (own(raw, 'audioRole')) {
    if (!isClipAudioRole(raw.audioRole)) return null;
    patch.audioRole = raw.audioRole;
  }
  if (own(raw, 'colour')) {
    if (raw.colour !== null && !clipColourSchema.safeParse(raw.colour).success) return null;
    patch.colour = copy(raw.colour);
  }
  return { ...patch, rect };
}
export function clipDraftRaw(clip: Record<string, unknown>): ClipDraftRaw {
  const rect = object(clip.rect) ? clip.rect : {};
  return { name: typeof clip.name === 'string' ? clip.name : '', trackId: String(clip.trackId), startFrame: clip.startFrame as number,
    durationFrames: clip.durationFrames as number, sourceInFrame: clip.sourceInFrame as number, rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }, gain: clip.gain as number,
    ...(own(clip, 'audioRole') ? { audioRole: clip.audioRole as ClipDraftRaw['audioRole'] } : {}),
    ...(own(clip, 'colour') ? { colour: copy(clip.colour as ClipColour | null) } : {}),
    ...(own(clip, 'fadeInFrames') ? { fadeInFrames: clip.fadeInFrames as number } : {}), ...(own(clip, 'fadeOutFrames') ? { fadeOutFrames: clip.fadeOutFrames as number } : {}) };
}
export function clipDraftSource(clip: Record<string, unknown>, asset: Record<string, unknown> | undefined): ClipDraftSource {
  return { assetId: String(clip.assetId), assetSha256: typeof asset?.sha256 === 'string' ? asset.sha256 : '',
    ...Object.fromEntries(['versionId', 'shotId', 'jobId'].filter(key => own(clip, key)).map(key => [key, clip[key]])) } as ClipDraftSource;
}
function acknowledged(value: unknown, context: ClipDraftContext, base: number, source: ClipDraftSource, patch: Record<string, unknown>): Record<string, unknown> | null {
  if (!object(value) || value.id !== context.timelineId || value.projectId !== context.projectId || value.revision !== base + 1 || !Array.isArray(value.clips)) return null;
  const saved: unknown = value.clips.find((item: unknown) => object(item) && item.id === context.clipId);
  if (!object(saved) || saved.assetId !== source.assetId || !Object.entries(patch).every(([key, expected]) => sameClipDraftValue(saved[key], expected))) return null;
  if (['versionId', 'shotId', 'jobId'].some(key => own(source, key) !== own(saved, key) || (source as unknown as Record<string, unknown>)[key] !== saved[key])) return null;
  return saved;
}

export function createClipDraftController({ context: initial, client, validateTimeline = () => false, onChange = () => {}, delay = 250 }: { context: ClipDraftContext; client: ClipDraftClient; validateTimeline?: (value: unknown, projectId: string) => boolean; onChange?: (state: ClipDraftState) => void; delay?: number }) {
  let context = copy(initial), generation = 1, serial = 0, active = true, readSerial = 0, loaded = false;
  let deleting: object | null = null;
  let envelope: ClipDraftEnvelope | null = null, timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | null = null;
  let closeFlight: Promise<boolean> | null = null;
  let state: ClipDraftState = { raw: copy(context.saved), dirty: false, baseRevision: context.timelineRevision, source: copy(context.source), conflict: false,
    phase: context.restored ? 'unsupported' : 'loading', error: '', errorDisplay: undefined, candidate: null, savedAt: null, submitting: false, businessPending: false, autosavePaused: false, failure: null, retainedRecord: false };
  const captures = new WeakSet<ClipDraftCapture>();
  const emit = (patch: Partial<ClipDraftState>) => { state = { ...state, ...patch }; if (active) onChange(state); };
  function pausePersistence(error: unknown, prefix = '', readOnly = false, display?: MessageDescriptor) {
    const observed = clipDraftFailure(error);
    // A failed reread cannot rewrite evidence about an earlier write.
    const failure = state.failure && (state.failure.kind === 'unknown' || readOnly) ? state.failure : observed;
    emit({ autosavePaused: true, failure, phase: 'error', error: prefix + message(error), errorDisplay: display ?? recoveryErrorMessage(error) });
  }
  const belongs = (owner: number) => active && owner === generation;
  const conflict = () => context.timelineRevision !== state.baseRevision || !sameClipDraftValue(context.source, state.source);
  const draftMatches = () => Boolean(envelope?.draft && sameClipDraftValue(envelope.draft.raw, state.raw) && envelope.draft.baseRevision === state.baseRevision && sameClipDraftValue(envelope.draft.source, state.source));
  // Business dirty remains true after a sidecar ACK. A clean form (including an
  // explicit local-only abandonment) has no current raw input left to persist.
  const hasUnpersisted = () => Boolean(flight || deleting || state.dirty && (!active || context.restored || !loaded || state.autosavePaused || ['loading', 'error', 'unsupported'].includes(state.phase) || !draftMatches()));
  const readyToWrite = () => active && !state.autosavePaused && !deleting && loaded && envelope && context.connected && !context.restored && state.dirty && !state.candidate && !['loading', 'error', 'unsupported'].includes(state.phase);
  function schedule() { if (timer) clearTimeout(timer); timer = undefined; if (readyToWrite() && !flight && !closeFlight) timer = setTimeout(() => { timer = undefined; void flush(); }, delay); }
  function accept(next: ClipDraftEnvelope, expected: ClipDraftEnvelope | null, write = false) {
    if (!sameClipDraftValue(next.key, keyOf(context)) || expected && (next.workspaceScope !== expected.workspaceScope || next.instanceId !== expected.instanceId || next.revision !== expected.revision + (write ? 1 : 0))) throw recoveryDisplayError(Error('本地草稿确认与当前记录不一致；已停止覆盖。'), displayMessage('recovery.clip.error.ackMismatch'));
    if (expected && envelope && envelope.revision !== expected.revision && !sameClipDraftValue(envelope, next)) throw recoveryDisplayError(Error('另一个本地草稿确认已更新记录；忽略旧回复。'), displayMessage('recovery.clip.error.newerAck'));
    envelope = copy(next);
  }
  async function load() {
    if (!active || context.restored || flight || deleting || state.submitting) return;
    const owner = generation, reading = ++readSerial, key = keyOf(context), existing = envelope;
    emit({ phase: 'loading', error: state.autosavePaused ? state.error : '', errorDisplay: state.autosavePaused ? state.errorDisplay : undefined });
    try {
      const next = await client.get(key);
      if (!belongs(owner) || reading !== readSerial) return;
      if (!next.supported) { loaded = false; emit({ phase: 'unsupported' }); return; }
      if (existing && (next.workspaceScope !== existing.workspaceScope || next.instanceId !== existing.instanceId)) throw recoveryDisplayError(Error('工作区或服务实例已变化。当前输入仍保留；请重新载入页面并明确恢复草稿。'), displayMessage('recovery.clip.error.identity'));
      if (existing && next.revision < existing.revision) throw recoveryDisplayError(Error('本地草稿返回了旧版本；当前输入仍保留。'), displayMessage('recovery.clip.error.oldRevision'));
      if (!sameClipDraftValue(next.key, key)) throw recoveryDisplayError(Error('本地草稿归属不匹配；已停止载入。'), displayMessage('recovery.clip.error.owner'));
      envelope = copy(next); loaded = true;
      emit({ candidate: next.draft ? copy(next.draft) : null, phase: next.draft ? 'ready' : 'ready', savedAt: next.draft?.updatedAt ?? null, error: state.autosavePaused ? state.error : next.draft && state.dirty ? '发现另一个已保存草稿。当前输入未被替换；请明确处理已保存草稿。' : '', errorDisplay: state.autosavePaused ? state.errorDisplay : next.draft && state.dirty ? displayMessage('recovery.clip.otherDraft') : undefined });
      // A read observes one moment. Even an empty slot cannot revoke an older
      // unknown write that may still publish after this GET.
      if (!next.draft && !state.autosavePaused) schedule();
    } catch (error) { if (belongs(owner) && reading === readSerial) { loaded = false; pausePersistence(error, '', true); } }
  }
  async function flushOnce(): Promise<void> {
    if (timer) clearTimeout(timer); timer = undefined;
    if (flight) { await flight; return; }
    if (!readyToWrite() || !envelope) return;
    if (draftMatches()) { emit({ phase: 'saved', savedAt: envelope.draft!.updatedAt }); return; }
    const owner = generation, capturedSerial = serial, previous = copy(envelope), raw = copy(state.raw), source = copy(state.source), baseRevision = state.baseRevision;
    readSerial++;
    emit({ phase: 'saving', error: '', errorDisplay: undefined });
    const work = (async () => {
      try {
        const next = await client.put({ ...keyOf(context), workspaceScope: previous.workspaceScope, instanceId: previous.instanceId, expectedRevision: previous.revision, baseRevision, source, raw });
        if (!belongs(owner)) return;
        if (!next.draft || next.draft.baseRevision !== baseRevision || !sameClipDraftValue(next.draft.source, source) || !sameClipDraftValue(next.draft.raw, raw)) throw recoveryDisplayError(Error('本地草稿保存确认无效；当前输入仍保留。'), displayMessage('recovery.clip.error.saveAck'));
        accept(next, previous, true);
        emit({ phase: capturedSerial === serial ? 'saved' : 'ready', savedAt: next.draft.updatedAt, conflict: state.conflict || next.targetStatus !== 'matching' || conflict() });
      } catch (error) { if (belongs(owner)) pausePersistence(error); }
    })();
    flight = work;
    try { await work; } finally { if (flight === work) flight = null; }
    if (belongs(owner) && capturedSerial !== serial) schedule();
  }
  async function flush(): Promise<void> {
    if (closeFlight) { await closeFlight; return; }
    const owner = generation;
    if (flight) await flight;
    // Concurrent callers join the same next write; they never recursively chase
    // input arriving during it. Ordinary autosave handles that later input.
    if (belongs(owner)) await flushOnce();
  }
  function flushForClose(): Promise<boolean> {
    if (closeFlight) return closeFlight;
    if (timer) clearTimeout(timer); timer = undefined;
    const token = capture();
    const draining = (async () => {
      if (!isCurrent(token) || deleting) return false;
      if (flight) await flight;
      if (!isCurrent(token) || deleting) return false;
      if (!hasUnpersisted()) return true;
      if (!readyToWrite()) return false;
      // At most one current-raw PUT after an older flight, under its accepted
      // next CAS. This never dispatches Save or retries a paused/unknown write.
      await flushOnce();
      return isCurrent(token) && !hasUnpersisted();
    })();
    const completed = draining.finally(() => {
      if (closeFlight !== completed) return;
      closeFlight = null;
      if (belongs(token.generation) && hasUnpersisted()) schedule();
    }).then(persisted => persisted && isCurrent(token) && !hasUnpersisted());
    closeFlight = completed;
    return completed;
  }
  function capture(): ClipDraftCapture { const token = Object.freeze({ ...keyOf(context), scope: context.scope, serial, generation }); captures.add(token); return token; }
  function isCurrent(token: ClipDraftCapture | null | undefined): boolean { return Boolean(token && captures.has(token) && active && token.scope === context.scope && sameClipDraftValue(keyOf(context), { projectId: token.projectId, timelineId: token.timelineId, clipId: token.clipId }) && token.generation === generation && token.serial === serial); }
  async function clearRecord(expected: ClipDraftEnvelope, owner: number): Promise<boolean> {
    if (deleting) return false;
    const deletion = {}; deleting = deletion; readSerial++;
    try {
      const next = await client.remove({ ...expected.key, workspaceScope: expected.workspaceScope, instanceId: expected.instanceId, expectedRevision: expected.revision });
      if (!belongs(owner)) return false;
      if (next.draft !== null) throw recoveryDisplayError(Error('本地草稿未被确认清除；已保留当前输入。'), displayMessage('recovery.clip.error.clearAck'));
      accept(next, expected, true); return true;
    } finally { if (deleting === deletion) deleting = null; }
  }
  const controller = {
    getState: () => state, getDirty: () => state.dirty, hasUnsaved: () => state.dirty || state.submitting, hasUnpersisted,
    getEditorCloseSnapshot: (): EditorCloseOwnerSnapshot => Object.freeze({
      dirty: state.dirty,
      inflight: Boolean(flight || deleting || state.submitting || state.businessPending),
      // Abandoning raw input does not acknowledge an uncertain PUT or DELETE.
      // A failed GET with no input/record alone is not a mutation owner.
      unknown: state.failure?.kind === 'unknown' && (state.retainedRecord || state.dirty || state.candidate !== null),
      identity: Object.freeze([serial, generation, context.scope, context.projectId, context.timelineId, context.clipId,
        state.baseRevision, state.retainedRecord, context.timelineRevision, context.source.assetId, context.source.assetSha256,
        context.source.versionId, context.source.shotId, context.source.jobId]),
    }),
    capture, isCurrent,
    canAbandon(token?: ClipDraftCapture) { return (!token || isCurrent(token)) && active && context.visible && !context.busy && !state.businessPending && !deleting && state.dirty; },
    abandonCurrentInput(token: ClipDraftCapture): boolean {
      if (!isCurrent(token) || !controller.canAbandon(token)) return false;
      // This only abandons the form owner. It neither cancels an in-flight PUT
      // nor deletes any persisted record or durable business request.
      const localWriteInFlight = flight !== null;
      if (timer) clearTimeout(timer); timer = undefined;
      generation++; serial++; readSerial++; flight = null; closeFlight = null; loaded = false;
      emit({ raw: copy(context.saved), baseRevision: context.timelineRevision, source: copy(context.source), dirty: false, conflict: false,
        submitting: false, businessPending: false, autosavePaused: true, retainedRecord: true, phase: 'ready',
        failure: localWriteInFlight ? { code: 'LOCAL_DRAFT_WRITE_RETAINED', status: null, kind: 'unknown' } : state.failure,
        error: '已放弃当前表单输入，未删除草稿记录，也未取消任何请求。已保存或稍后写入的草稿可能再次出现。', errorDisplay: displayMessage('recovery.clip.abandoned') });
      return true;
    },
    setContext(next: ClipDraftContext) {
      if (!active) return;
      if (next.scope !== context.scope || !sameClipDraftValue(keyOf(next), keyOf(context))) { controller.dispose(); return; } // A different mounted owner needs a fresh controller.
      if (sameClipDraftValue(context, next)) return;
      context = copy(next);
      if (state.dirty || state.submitting) { if (conflict()) emit({ conflict: true }); }
      else emit({ raw: copy(context.saved), baseRevision: context.timelineRevision, source: copy(context.source), conflict: false });
      schedule();
    },
    edit(key: keyof ClipDraftRaw, value: ClipDraftRaw[keyof ClipDraftRaw]) {
      if (key === 'audioRole' && (context.audioRoleEditable !== true || !context.connected || context.busy || state.submitting || state.businessPending || state.candidate || state.conflict || !isClipAudioRole(value))) return false;
      if (!active || !context.visible || !own(state.raw, key) && !['fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole'].includes(key)) return false;
      serial++; emit({ raw: { ...state.raw, [key]: copy(value) }, dirty: true, conflict: state.conflict || conflict() }); schedule(); return true;
    },
    restore(token = capture()) {
      if (!isCurrent(token) || !context.visible || state.dirty || !state.candidate || !envelope) return false;
      const candidate = state.candidate; serial++;
      emit({ raw: copy(candidate.raw), baseRevision: candidate.baseRevision, source: copy(candidate.source), dirty: true, candidate: null,
        conflict: envelope.targetStatus !== 'matching' || context.timelineRevision !== candidate.baseRevision || !sameClipDraftValue(context.source, candidate.source), phase: 'saved', savedAt: candidate.updatedAt, error: state.autosavePaused ? state.error : '', errorDisplay: state.autosavePaused ? state.errorDisplay : undefined }); return true;
    },
    async discard(token: ClipDraftCapture, canDiscard: () => boolean = () => true): Promise<boolean> {
      if (!isCurrent(token) || state.submitting || !canDiscard()) return false;
      if (timer) clearTimeout(timer); timer = undefined;
      const owner = generation;
      if (context.restored) { serial++; emit({ raw: copy(context.saved), baseRevision: context.timelineRevision, source: copy(context.source), dirty: false, conflict: false, candidate: null, savedAt: null, phase: 'unsupported', error: '', errorDisplay: undefined }); return true; }
      if (flight) await flight;
      if (!isCurrent(token) || !canDiscard()) { schedule(); return false; }
      try {
        // Unknown writes cannot be forgotten merely because their response failed.
        if (!loaded || !envelope || state.autosavePaused || state.phase === 'error') { emit({ error: '本地草稿状态尚未确认。可选择“放弃当前输入，保留草稿记录”安全离开；这不会删除或取消原记录。', errorDisplay: displayMessage('recovery.clip.leaveUnconfirmed') }); return false; }
        if (envelope.draft && !await clearRecord(copy(envelope), owner)) return false;
        // A DELETE already sent while the target was valid is not cancelled.
        // Its exact ACK may update the local record, but never clear stale input.
        if (!isCurrent(token) || !canDiscard()) { schedule(); return false; }
        serial++; emit({ raw: copy(context.saved), baseRevision: context.timelineRevision, source: copy(context.source), dirty: false, conflict: false, candidate: null, savedAt: null, phase: 'ready', error: '', errorDisplay: undefined }); return true;
      } catch (error) { if (belongs(owner)) pausePersistence(error); return false; }
    },
    async discardStored(token = capture()): Promise<boolean> {
      if (!isCurrent(token) || !state.candidate || !envelope || state.submitting || deleting) return false;
      const candidate = copy(state.candidate), owner = generation;
      try {
        if (!await clearRecord(copy(envelope), owner)) return false;
        if (!belongs(owner) || !sameClipDraftValue(state.candidate, candidate)) return false;
        emit({ candidate: null, savedAt: null, phase: 'ready', error: state.autosavePaused ? state.error : '', errorDisplay: state.autosavePaused ? state.errorDisplay : undefined }); schedule(); return true;
      } catch (error) { if (belongs(owner)) pausePersistence(error); return false; }
    },
    async save(onSave: (clipId: string, patch: Record<string, unknown>, baseRevision: number, options: { canExecute: () => boolean }) => Promise<unknown>): Promise<unknown> {
      if (!active || !context.visible || !context.connected || context.busy || state.conflict || state.submitting || !state.dirty || state.candidate) return null;
      const patch = clipDraftPatch(state.raw); if (!patch) return null;
      // Unavailable role capability cannot block unrelated edits or silently drop
      // a recovered role change. An unchanged role is omitted from that request.
      if (context.audioRoleEditable !== true) {
        if (clipAudioRoleChanged(state.raw, context.saved)) return null;
        delete patch.audioRole;
      }
      const owner = generation, savedSerial = serial, original = copy(context), base = state.baseRevision, source = copy(state.source);
      emit({ submitting: true, businessPending: false });
      await flush();
      if (!belongs(owner)) return null;
      if (savedSerial !== serial || context.busy || !context.visible || !context.connected || own(patch, 'audioRole') && context.audioRoleEditable !== true || conflict()) { emit({ submitting: false, businessPending: false }); return null; }
      const stored = envelope ? copy(envelope) : null, localUnconfirmed = !context.restored && (!loaded || state.autosavePaused || state.phase === 'error');
      emit({ error: localUnconfirmed ? state.error : '', errorDisplay: localUnconfirmed ? state.errorDisplay : undefined });
      try {
        const canExecute = () => (!own(patch, 'audioRole') || context.audioRoleEditable === true) && belongs(owner) && context.visible && context.connected && sameClipDraftValue(keyOf(context), keyOf(original)) && context.scope === original.scope && context.timelineRevision === base && sameClipDraftValue(context.source, source);
        emit({ businessPending: true });
        const result = await onSave(original.clipId, patch, base, { canExecute });
        if (!belongs(owner)) return null;
        if (!result) { emit({ submitting: false, businessPending: false }); return null; }
        const saved = validateTimeline(result, original.projectId) ? acknowledged(result, original, base, source, patch) : null;
        if (!saved) throw recoveryDisplayError(Error('片段保存确认与原始输入不一致；本地草稿仍保留。'), displayMessage('recovery.clip.error.timelineAck'));
        if (context.timelineRevision > base + 1 || !sameClipDraftValue(context.source, source)) { emit({ submitting: false, businessPending: false, conflict: true, error: '时间线已有更新；本地草稿仍保留，请核对最新片段。', errorDisplay: displayMessage('recovery.clip.timelineChanged') }); return result; }
        if (savedSerial !== serial) { emit({ submitting: false, businessPending: false, conflict: true, error: '原输入已保存到时间线。之后的新输入仍保留，请核对更新后的片段。', errorDisplay: displayMessage('recovery.clip.newerInput') }); schedule(); return result; }
        if (localUnconfirmed) { emit({ submitting: false, businessPending: false, conflict: true, error: '片段已保存到时间线，但本地草稿状态尚未确认。当前输入仍保留，请重新核对本地记录。', errorDisplay: displayMessage('recovery.clip.savedUnconfirmed') }); return result; }
        if (stored?.draft && envelope && sameClipDraftValue(stored, envelope)) {
          try { if (!await clearRecord(stored, owner)) return result; }
          catch (error) { if (belongs(owner)) { emit({ submitting: false, businessPending: false, conflict: true }); pausePersistence(error, '片段已保存，但本地草稿清除未确认。', false, displayMessage('recovery.clip.clearUnconfirmed')); } return result; }
        }
        if (!belongs(owner) || savedSerial !== serial) { if (belongs(owner)) emit({ submitting: false, businessPending: false, conflict: true }); return result; }
        serial++; emit({ raw: clipDraftRaw(saved), dirty: false, baseRevision: base + 1, source, conflict: false, submitting: false, businessPending: false, candidate: null, savedAt: null, phase: context.restored ? 'unsupported' : 'ready', error: '', errorDisplay: undefined }); return result;
      } catch (error) { if (belongs(owner)) emit({ submitting: false, businessPending: false, error: message(error), errorDisplay: recoveryErrorMessage(error) }); return null; }
    },
    load, flush, flushForClose,
    activate() { active = true; },
    dispose() { active = false; generation++; readSerial++; if (timer) clearTimeout(timer); timer = undefined; flight = null; closeFlight = null; deleting = null; loaded = false; },
  };
  return controller;
}
export type ClipDraftController = ReturnType<typeof createClipDraftController>;
