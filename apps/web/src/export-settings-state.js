import { TIMELINE_EXPORT_DEFAULT_SETTINGS, timelineExportSettingsSchema, resolveTimelineExportDelivery, isTimelineExportDelivery } from '@mioon/contracts';

// This is per-export UI state only. Never write it to project/workspace storage,
// the timeline, an existing request receipt, or the durable edit-task ledger.
export function freezeExportSettings(value) {
  if (value === undefined) return undefined;
  const parsed = timelineExportSettingsSchema.parse(value);
  return Object.freeze({ ...parsed, rateControl: Object.freeze({ ...parsed.rateControl }) });
}
export function exportSettingsKey(value) {
  if (value === undefined) return 'legacy';
  const parsed = timelineExportSettingsSchema.safeParse(value);
  if (!parsed.success) return null;
  const settings = parsed.data, rate = settings.rateControl;
  return JSON.stringify([settings.profileId, settings.resolution, rate.mode, rate.mode === 'crf' ? rate.quality : rate.targetKbps]);
}
export function exportRateLabel(settings, effective) {
  if (settings.rateControl.mode === 'bitrate') return `平均目标 ${settings.rateControl.targetKbps / 1000} Mb/s`;
  const labels = { compact: '紧凑', standard: '标准', high: '高画质' };
  return `${labels[settings.rateControl.quality]} · CRF ${effective.rateControl.crf}`;
}
export function describeExportDelivery(delivery, timeline) {
  if (!timeline || !delivery || !isTimelineExportDelivery(delivery, timeline, delivery.exportSettings)) return null;
  const { effective, exportSettings } = delivery;
  return { width: effective.width, height: effective.height, fps: effective.fps,
    dimensions: `${effective.width} × ${effective.height}`, rate: exportRateLabel(exportSettings, effective),
    upscale: effective.width > timeline.width || effective.height > timeline.height,
    bitrate: exportSettings.rateControl.mode === 'bitrate' };
}
export function selectedExportDelivery(timeline, settings) {
  if (!timeline || !timelineExportSettingsSchema.safeParse(settings).success) return null;
  try { return describeExportDelivery(resolveTimelineExportDelivery(timeline, settings), timeline); }
  catch { return null; }
}
export function exportHistoryDelivery(item) {
  if (item?.mode !== 'timeline' || item?.purpose !== 'export' || !item.snapshot?.delivery) return null;
  return describeExportDelivery(item.snapshot.delivery, item.snapshot.timeline);
}
export function createExportSettingsController({ getContext, onChange = () => {} } = {}) {
  let version = 0, state = { scope: null, enabled: false, version, exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const controller = {
    getState: () => state,
    getVersion: scope => state.scope === scope ? state.version : 0,
    getSettings: scope => state.scope === scope ? state.exportSettings : TIMELINE_EXPORT_DEFAULT_SETTINGS,
    setContext(context) {
      const next = { scope: context?.scope ?? null, enabled: Boolean(context?.enabled) };
      if (next.scope === state.scope && next.enabled === state.enabled) return;
      emit({ ...next, ...(next.scope !== state.scope ? { exportSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS, version: ++version } : {}) });
    },
    choose(settings, scope, expectedVersion) {
      if (getContext) controller.setContext(getContext());
      if (expectedVersion !== undefined && expectedVersion !== state.version) return false;
      if (scope !== state.scope || !state.enabled || !timelineExportSettingsSchema.safeParse(settings).success) return false;
      if (exportSettingsKey(settings) === exportSettingsKey(state.exportSettings)) return true;
      emit({ exportSettings: freezeExportSettings(settings), version: ++version }); return true;
    },
  };
  return controller;
}
