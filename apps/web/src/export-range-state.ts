import { useLayoutEffect, useRef, useState } from 'react';
import { timelineExportRangeSchema, timelineExportRangeFields, isTimelineExportRangeInput, isTimelineExportRangeWithinDuration, isTimelineExportRangeSnapshot } from '@mioon/contracts/timeline-export-range';
import type { TimelineExportRange, TimelineExportRangeInput } from '@mioon/contracts/timeline-export-range';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const EXPORT_RANGE_HELP = '范围仅用于本次导出，不改变已保存时间线或编辑预览。未提交的范围不保存；重启或重新打开项目后请重新选择。';
export const EXPORT_RANGE_ERROR = '请输入有效整数帧：开始帧不能小于 0，结束帧必须大于开始帧且不超过已保存时间线，至少选择 1 帧。';
export interface ExportRangeDraft { mode: 'whole' | 'selected'; startText: string; endText: string }
export interface ExportRangeContext { scope: string | null; projectId: string | null; timelineId: string | null; revision: number | null; durationFrames: number | null; enabled: boolean }
export interface ExportRangeState extends ExportRangeContext { draft: Readonly<ExportRangeDraft>; value: Readonly<TimelineExportRange> | undefined | null; version: number; error: string }
export interface ExportRangeContextFields { exportRange: Readonly<TimelineExportRange> | undefined | null; exportRangeKey: string | null; rangeVersion: number }
const wholeDraft = (): Readonly<ExportRangeDraft> => Object.freeze({ mode: 'whole', startText: '', endText: '' });
const validDuration = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 18000;
const frame = (value: string): number => /^\d+$/.test(value) ? Number(value) : NaN;
function projectDraft(draft: Readonly<ExportRangeDraft>, durationFrames: unknown): Readonly<TimelineExportRange> | undefined | null {
  if (draft.mode === 'whole') return undefined;
  const candidate = { exportRange: { startFrame: frame(draft.startText), endFrame: frame(draft.endText) } };
  return validDuration(durationFrames) && isTimelineExportRangeWithinDuration(candidate, durationFrames)
    ? Object.freeze(timelineExportRangeFields(candidate).exportRange!) : null;
}

/** Only whole mode maps to omission. null is a UI-only invalid selection. */
export function exportRangeContextFields(context: unknown): ExportRangeContextFields {
  const value = object(context) ? context.exportRange : undefined;
  const rangeVersion = object(context) && typeof context.rangeVersion === 'number' && Number.isSafeInteger(context.rangeVersion) ? context.rangeVersion : 0;
  if (value === undefined) return { exportRange: undefined, exportRangeKey: 'legacy', rangeVersion };
  const parsed = timelineExportRangeSchema.safeParse(value);
  return parsed.success ? { exportRange: Object.freeze(parsed.data), exportRangeKey: JSON.stringify([parsed.data.startFrame, parsed.data.endFrame]), rangeVersion }
    : { exportRange: null, exportRangeKey: null, rangeVersion };
}
export function sameExportRangeContext(left: unknown, right: unknown): boolean {
  return object(left) && object(right) && left.exportRangeKey === right.exportRangeKey && left.rangeVersion === right.rangeVersion;
}
export function rangeFields(context: unknown): TimelineExportRangeInput {
  const fields = exportRangeContextFields(context);
  if (fields.exportRangeKey === null) throw new Error(EXPORT_RANGE_ERROR);
  return fields.exportRange === undefined ? {} : { exportRange: Object.freeze(timelineExportRangeFields({ exportRange: fields.exportRange }).exportRange!) };
}

/** A presentation projection only; absence never invents current timeline bounds. */
export function exportRangeDescription(input: unknown, durationFrames?: unknown): { startFrame: number; endFrame: number; frames: number; seconds: string } | null {
  if (!isTimelineExportRangeInput(input) || !object(input) || !Object.hasOwn(input, 'exportRange') ||
      durationFrames !== undefined && !isTimelineExportRangeWithinDuration(input, durationFrames)) return null;
  const range = timelineExportRangeFields(input).exportRange!;
  return { ...range, frames: range.endFrame - range.startFrame, seconds: ((range.endFrame - range.startFrame) / 30).toFixed(2) };
}

/** Range-present history must retain export purpose and its original bounds.
 * Legacy rows without this opt-in field keep their existing display behavior. */
export function hasInvalidExportRangeHistory(item: unknown): boolean {
  if (!object(item) || !object(item.snapshot) || !Object.hasOwn(item.snapshot, 'exportRange')) return false;
  return item.mode !== 'timeline' || item.purpose !== 'export' || !isTimelineExportRangeSnapshot(item.snapshot, { purpose: item.purpose });
}

export function createExportRangeController({ getContext, onChange = () => {} }: { getContext?: () => ExportRangeContext; onChange?: (state: ExportRangeState) => void } = {}) {
  let version = 0;
  let state: ExportRangeState = { scope: null, projectId: null, timelineId: null, revision: null, durationFrames: null, enabled: false, draft: wholeDraft(), value: undefined, version, error: '' };
  const emit = (patch: Partial<ExportRangeState>) => { state = { ...state, ...patch }; onChange(state); };
  const controller = {
    getState: () => state,
    getVersion: (scope: string | null): number => state.scope === scope ? state.version : 0,
    getRange(scope: string | null): Readonly<TimelineExportRange> | undefined | null {
      const live = getContext?.() ?? state;
      return state.scope === scope && live.scope === scope ? projectDraft(state.draft, live.durationFrames) : undefined;
    },
    setContext(context: ExportRangeContext) {
      const next = { scope: context.scope, projectId: context.projectId, timelineId: context.timelineId, revision: context.revision, durationFrames: context.durationFrames, enabled: Boolean(context.enabled) };
      if (Object.keys(next).every(key => state[key as keyof ExportRangeContext] === next[key as keyof ExportRangeContext])) return;
      const ownerChanged = next.scope !== state.scope || next.projectId !== state.projectId;
      const boundsChanged = next.timelineId !== state.timelineId || next.revision !== state.revision || next.durationFrames !== state.durationFrames;
      const draft = ownerChanged ? wholeDraft() : state.draft, value = projectDraft(draft, next.durationFrames);
      emit({ ...next, draft, value, error: value === null ? EXPORT_RANGE_ERROR : '', version: ownerChanged || boundsChanged ? ++version : state.version });
    },
    chooseRange(draft: ExportRangeDraft, scope: string | null, expectedVersion?: number): boolean {
      if (getContext) controller.setContext(getContext());
      if (scope !== state.scope || !state.enabled || expectedVersion !== undefined && expectedVersion !== state.version ||
          !draft || !['whole', 'selected'].includes(draft.mode) || typeof draft.startText !== 'string' || typeof draft.endText !== 'string') return false;
      const next = Object.freeze({ mode: draft.mode, startText: draft.startText, endText: draft.endText });
      if (next.mode === state.draft.mode && next.startText === state.draft.startText && next.endText === state.draft.endText) return true;
      const value = projectDraft(next, state.durationFrames);
      emit({ draft: next, value, error: value === null ? EXPORT_RANGE_ERROR : '', version: ++version }); return true;
    },
  };
  return controller;
}

export function useExportRange({ getContext, ...context }: ExportRangeContext & { getContext: () => ExportRangeContext }) {
  const callback = useRef(getContext); callback.current = getContext;
  const [state, setState] = useState<ExportRangeState | null>(null);
  const ref = useRef<ReturnType<typeof createExportRangeController> | null>(null);
  if (!ref.current) ref.current = createExportRangeController({ getContext: () => callback.current(), onChange: setState });
  const controller = ref.current;
  useLayoutEffect(() => { controller.setContext(context); }, [controller, context.scope, context.projectId, context.timelineId, context.revision, context.durationFrames, context.enabled]);
  const current = state?.scope === context.scope && state.projectId === context.projectId ? state : null;
  const draft = current?.draft ?? wholeDraft(), value = projectDraft(draft, context.durationFrames);
  return { scope: context.scope, value, draft, error: value === null ? EXPORT_RANGE_ERROR : '', version: current?.version ?? controller.getVersion(context.scope), controller };
}
