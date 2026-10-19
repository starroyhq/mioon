import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, timelineExportSettingsSchema, resolveTimelineExportDelivery, isTimelineExportDelivery } from '@mioon/contracts';
import type { TimelineExportSettings } from '@mioon/contracts';

export interface ExportTimelineView { width: number; height: number; durationFrames?: number; [key: string]: unknown }
export interface ExportDeliveryDescription {
  width: number; height: number; fps: number; dimensions: string; rate: string; rateMessage: DisplayMessage; upscale: boolean; bitrate: boolean;
}
export interface ExportSettingsState { scope: string | null; enabled: boolean; version: number; exportSettings: TimelineExportSettings }
export interface ExportSettingsContext { scope?: string | null; enabled?: unknown; [key: string]: unknown }
export interface ExportSettingsControllerOptions { getContext?: (() => ExportSettingsContext | null | undefined) | null; onChange?: (state: ExportSettingsState) => void }
interface ExportRateEffective { rateControl?: { crf?: unknown } | null }

// This is per-export UI state only. Never write it to project/workspace storage,
// the timeline, an existing request receipt, or the durable edit-task ledger.
export function freezeExportSettings(value: unknown): Readonly<TimelineExportSettings> | undefined {
  if (value === undefined) return undefined;
  const parsed = timelineExportSettingsSchema.parse(value);
  return Object.freeze({ ...parsed, rateControl: Object.freeze({ ...parsed.rateControl }) });
}
export function exportSettingsKey(value: unknown): string | null {
  if (value === undefined) return 'legacy';
  const parsed = timelineExportSettingsSchema.safeParse(value);
  if (!parsed.success) return null;
  const settings = parsed.data, rate = settings.rateControl;
  return JSON.stringify([settings.profileId, settings.resolution, rate.mode, rate.mode === 'crf' ? rate.quality : rate.targetKbps]);
}
export function exportRateLabel(settings: TimelineExportSettings, effective: ExportRateEffective | null | undefined): string {
  if (settings.rateControl.mode === 'bitrate') return `平均目标 ${settings.rateControl.targetKbps / 1000} Mb/s`;
  const labels: Record<string, string> = { compact: '紧凑', standard: '标准', high: '高画质' };
  return `${labels[settings.rateControl.quality]} · CRF ${String(effective?.rateControl?.crf)}`;
}
export function exportRateMessage(settings: TimelineExportSettings): DisplayMessage {
  if (settings.rateControl.mode === 'bitrate') return message('export.settings.rateTarget', { rate: settings.rateControl.targetKbps / 1000 });
  return message(({ compact: 'export.settings.compact', standard: 'export.settings.standard', high: 'export.settings.high' } as Record<string, 'export.settings.compact' | 'export.settings.standard' | 'export.settings.high'>)[settings.rateControl.quality]);
}
export function describeExportDelivery(delivery: unknown, timeline: ExportTimelineView | null | undefined): ExportDeliveryDescription | null {
  if (!timeline || !delivery || !isTimelineExportDelivery(delivery, timeline, (delivery as { exportSettings?: unknown }).exportSettings)) return null;
  const { effective, exportSettings } = delivery as { effective: { width: number; height: number; fps: number; rateControl?: { crf?: unknown } }; exportSettings: TimelineExportSettings };
  return { width: effective.width, height: effective.height, fps: effective.fps,
    dimensions: `${effective.width} × ${effective.height}`, rate: exportRateLabel(exportSettings, effective), rateMessage: exportRateMessage(exportSettings),
    upscale: effective.width > timeline.width || effective.height > timeline.height,
    bitrate: exportSettings.rateControl.mode === 'bitrate' };
}
export function selectedExportDelivery(timeline: unknown, settings: unknown): ExportDeliveryDescription | null {
  if (!timeline || !timelineExportSettingsSchema.safeParse(settings).success) return null;
  try { return describeExportDelivery(resolveTimelineExportDelivery(timeline, settings as TimelineExportSettings), timeline as ExportTimelineView); }
  catch { return null; }
}
export function exportHistoryDelivery(item: Record<string, unknown> | null | undefined): ExportDeliveryDescription | null {
  const snapshot = item && typeof item.snapshot === 'object' && item.snapshot !== null ? item.snapshot as Record<string, unknown> : null;
  if (item?.mode !== 'timeline' || item?.purpose !== 'export' || !snapshot?.delivery) return null;
  return describeExportDelivery(snapshot.delivery, snapshot.timeline as ExportTimelineView | null | undefined);
}
export function createExportSettingsController({ getContext, onChange = () => {} }: ExportSettingsControllerOptions = {}) {
  let version = 0, state: ExportSettingsState = { scope: null, enabled: false, version, exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS };
  const emit = (patch: Partial<ExportSettingsState>): void => { state = { ...state, ...patch }; onChange(state); };
  const controller = {
    getState: (): ExportSettingsState => state,
    getVersion: (scope: string | null): number => state.scope === scope ? state.version : 0,
    getSettings: (scope: string | null): TimelineExportSettings => state.scope === scope ? state.exportSettings : TIMELINE_EXPORT_DEFAULT_SETTINGS,
    setContext(context: ExportSettingsContext | null | undefined): void {
      const next = { scope: context?.scope ?? null, enabled: Boolean(context?.enabled) };
      if (next.scope === state.scope && next.enabled === state.enabled) return;
      emit({ ...next, ...(next.scope !== state.scope ? { exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS, version: ++version } : {}) });
    },
    choose(settings: unknown, scope: string | null, expectedVersion?: number): boolean {
      if (getContext) controller.setContext(getContext());
      if (expectedVersion !== undefined && expectedVersion !== state.version) return false;
      if (scope !== state.scope || !state.enabled || !timelineExportSettingsSchema.safeParse(settings).success) return false;
      if (exportSettingsKey(settings) === exportSettingsKey(state.exportSettings)) return true;
      emit({ exportSettings: freezeExportSettings(settings) as TimelineExportSettings, version: ++version }); return true;
    },
  };
  return controller;
}
