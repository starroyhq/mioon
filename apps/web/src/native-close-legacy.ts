import type { LocalShotTextCloseSnapshot } from './local-shot-text-state.ts';

/** Renderer-local evidence only. This is never serialized or sent to main. */
export interface NativeLegacyCloseSnapshot {
  readonly dirty: boolean;
  readonly identity: readonly unknown[];
}
export interface NativeShotLocalCloseSnapshot {
  readonly mounted: boolean;
  readonly formSerial: number; readonly textVersion: number; readonly dirty: boolean;
  readonly draft: object; readonly baseline: object; readonly baseRevision: number | null;
}
interface ShotOwner { getNativeCloseSnapshot(): LocalShotTextCloseSnapshot }
interface StateOwner<T> { getState(): T }
interface ClipState {
  readonly dirty: boolean; readonly submitting: boolean;
  readonly raw: object; readonly source: object; readonly baseRevision: number;
}
interface FormatBase {
  readonly projectId?: string; readonly projectRevision?: number;
  readonly timelineId?: string | null; readonly timelineRevision?: number | null;
  readonly presetId?: string;
}
interface FormatState {
  readonly dirty: boolean; readonly submitting: boolean;
  readonly scope: string | null; readonly projectId: string | null;
  readonly draftPresetId: string | null; readonly base: FormatBase | null;
}
interface DeliveryState {
  readonly dirty: boolean; readonly scope: string | null; readonly projectId: string | null;
  readonly value: string; readonly version: number;
}
interface SubjectState {
  readonly scope: string | null; readonly projectId: string | null;
  readonly createDraft: object; readonly versionDrafts: object; readonly bindingDrafts: object;
  readonly selectedSubjectId: string; readonly activeShotId: string | null;
  readonly saving: string | null; readonly uncertain: boolean;
}
interface NativeLegacyCloseOwners {
  readonly inspectorDirty?: boolean;
  readonly shot?: ShotOwner | null;
  readonly shotLocal?: (() => NativeShotLocalCloseSnapshot) | null;
  readonly clip?: StateOwner<ClipState> | null;
  readonly format?: StateOwner<FormatState> | null;
  readonly delivery?: StateOwner<DeliveryState> | null;
  readonly subtitle?: StateOwner<unknown> | null;
  readonly subject?: StateOwner<SubjectState> | null;
  readonly source?: StateOwner<unknown> | null;
}

/** Read only the existing synchronous state getters. In particular, shot's
 * legacy hasUnsaved/capture synchronize and may schedule writes, so close must
 * use its separate pure snapshot. Predicates are unchanged; optional inspector
 * owners add identity evidence only, never new busy/unknown/dirty semantics.
 * Phase, savedAt and sidecar ACK objects are deliberately not input identities. */
export function readNativeLegacyClose({ inspectorDirty = false, shot, shotLocal, clip, format, delivery, subtitle, subject, source }: NativeLegacyCloseOwners = {}): NativeLegacyCloseSnapshot {
  const text = shot?.getNativeCloseSnapshot(), clipState = clip?.getState(), formatState = format?.getState(), name = delivery?.getState();
  const local = shotLocal?.();
  // Deferred confirmation continuations can update these local refs before the
  // controller's layout synchronization. An equal/older dirty ref must not undo
  // the controller's explicit abandonment of that same input.
  const localDirty = Boolean(local?.mounted && text && (local.formSerial > text.formSerial || local.textVersion > text.textVersion) && local.dirty);
  const subtitleState = subtitle?.getState(), subjectState = subject?.getState(), sourceState = source?.getState();
  return Object.freeze({
    dirty: Boolean(inspectorDirty || text?.dirty || localDirty || clipState?.dirty || clipState?.submitting || formatState?.dirty || formatState?.submitting || name?.dirty),
    identity: Object.freeze([
      shot ?? null, text?.serial, text?.generation, text?.formSerial, text?.textVersion, text?.scope, text?.projectId, text?.shotId,
      text?.revision, text?.baseRevision, text?.executionEpoch,
      shotLocal ?? null, local?.mounted, local?.formSerial, local?.textVersion, local?.draft, local?.baseline, local?.baseRevision,
      clip ?? null, clipState?.raw, clipState?.baseRevision, clipState?.source,
      format ?? null, formatState?.scope, formatState?.projectId, formatState?.draftPresetId,
      formatState?.base?.projectId, formatState?.base?.projectRevision, formatState?.base?.timelineId, formatState?.base?.timelineRevision, formatState?.base?.presetId,
      delivery ?? null, name?.scope, name?.projectId, name?.value, name?.version,
      subtitle ?? null, subtitleState,
      // Returning from a native dialog triggers subject's focus refresh. Its
      // list/loading/result objects change even when all local inputs are the
      // same. Reads preserve these draft references and selected targets; a
      // new draft, owner, target or mutation certainty must still invalidate.
      subject ?? null, subjectState?.scope, subjectState?.projectId,
      subjectState?.createDraft, subjectState?.versionDrafts, subjectState?.bindingDrafts,
      subjectState?.selectedSubjectId, subjectState?.activeShotId, subjectState?.saving, subjectState?.uncertain,
      source ?? null, sourceState,
    ]),
  });
}
