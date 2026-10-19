import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { isExportPreflightResponse, isTimelineExportCapabilitiesResponse } from '@mioon/contracts';
import { exportPreflightResponseSchema, timelineExportCapabilitiesResponseSchema } from '@mioon/contracts';
import { exportRangeContextFields, sameExportRangeContext, rangeFields } from './export-range-state.ts';
import { exportSettingsKey, freezeExportSettings } from './export-settings-state.ts';
import { deliveryNameContextFields, sameDeliveryNameContext, deliveryNameRequestFields } from './export-delivery-state.ts';

export type ExportPreflightReport=ReturnType<typeof exportPreflightResponseSchema.parse>;
export type ExportPreflightIssue=ExportPreflightReport['issues'][number];
export type ExportCapability=ReturnType<typeof timelineExportCapabilitiesResponseSchema.parse>;
export interface ExportPreflightContext {
  readonly scope?: unknown;
  readonly projectId?: unknown;
  readonly timelineId?: unknown;
  readonly revision?: unknown;
  readonly connected?: unknown;
  readonly settingsVersion?: unknown;
  readonly exportSettings?: unknown;
  readonly deliveryName?: unknown;
  readonly deliveryNameVersion?: unknown;
  readonly exportRange?: unknown;
  readonly rangeVersion?: unknown;
  readonly [key: string]: unknown;
}
export interface ExportPreflightState {
  scope: unknown;
  projectId: unknown;
  timelineId: unknown;
  revision: unknown;
  connected: boolean;
  exportSettings: unknown;
  settingsKey: string|null;
  settingsVersion: number;
  capability: ExportCapability|null;
  capabilityPhase: string;
  checkingStep: string|null;
  phase: string;
  report: ExportPreflightReport|null;
  binding: Record<string, unknown>|null;
  uncheckedIntent: Record<string, unknown>|null;
  error: string;
  errorCode?: unknown;
  attempted: boolean;
  deliveryNameKey?: unknown;
  deliveryNameVersion?: unknown;
  exportRangeKey?: unknown;
  rangeVersion?: unknown;
  [key: string]: unknown;
}
export interface ExportPreflightInvocation {readonly [key: string]: unknown}
export interface ExportPreflightReadOptions extends ExportPreflightInvocation {readonly signal?: AbortSignal}
export interface ExportPreflightControllerOptions {
  read: (input: Record<string, unknown>, options: ExportPreflightReadOptions)=>Promise<unknown>;
  readCapabilities?: (input: Record<string, unknown>, options: ExportPreflightReadOptions)=>Promise<unknown>;
  getContext?: ()=>ExportPreflightContext|null|undefined;
  getInvocation?: ()=>ExportPreflightInvocation;
  onChange?: (state: ExportPreflightState)=>void;
  onUnauthorized?: ()=>void;
}
export interface ExportPreflightController {
  getState(): ExportPreflightState;
  setContext(context: ExportPreflightContext|null|undefined): void;
  setVisible(next: unknown): void;
  check(): Promise<ExportPreflightReport|null>;
  takeExportBinding(binding: Record<string, unknown>|null|undefined): Record<string, unknown>|null;
  takeUncheckedExportIntent(intent: Record<string, unknown>|null|undefined): Record<string, unknown>|null;
  dispose(): void;
}
interface CapturedContext extends Record<string, unknown> {
  generation: number;
  scope: unknown;
  projectId: unknown;
  timelineId: unknown;
  revision: unknown;
  settingsKey: string|null;
  settingsVersion: number;
}

const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const errorCode=(error: unknown): string|undefined=>typeof property(error,'code')==='string'?property(error,'code') as string:undefined;
const initialState=(): ExportPreflightState => ({ ...exportRangeContextFields(null), ...deliveryNameContextFields(null), scope: null, projectId: null, timelineId: null, revision: null, connected: false, exportSettings: undefined, settingsKey: 'legacy', settingsVersion: 0, capability: null, capabilityPhase: 'idle', checkingStep: null, phase: 'idle', report: null, binding: null, uncheckedIntent: null, error: '', attempted: false });
const hasRevision=(value: unknown): value is number=>Number.isSafeInteger(value) && (value as number) > 0;
const knownIssueCodes = new Set(['EXPORT_RANGE_BOUNDS', 'TIMELINE_MISSING', 'EMPTY_TIMELINE', 'INVALID_TIMELINE_SNAPSHOT', 'TIMELINE_SOURCE_UNAVAILABLE', 'PREFLIGHT_SOURCE_INVALID', 'PREFLIGHT_SOURCE_CHANGED', 'PREFLIGHT_MEDIA_INVALID', 'PREFLIGHT_INCOMPLETE', 'PREFLIGHT_BUDGET', 'PREFLIGHT_SNAPSHOT_BUDGET', 'PREFLIGHT_TIMEOUT', 'PREFLIGHT_BUSY', 'PREFLIGHT_STALE']);
for (const code of ['TIMELINE_IMAGE_COMPOSITOR_BUDGET', 'INVALID_TIMELINE_COLOUR', 'TIMELINE_COLOUR_SOURCE_UNSUPPORTED', 'TIMELINE_COLOUR_SOURCE_MISMATCH', 'TIMELINE_COLOUR_RESOURCE_CHANGED', 'TIMELINE_COLOUR_LUT_BUDGET', 'TIMELINE_COLOUR_LOOK_UNAVAILABLE', 'SOURCE_BOUNDS', 'FADE_AUDIO_UNSUPPORTED', 'AUDIO_ROLE_CLIP_UNSUPPORTED', 'TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED', 'VOLUME_ENVELOPE_SOURCE_UNSUPPORTED', 'INVALID_CLIP_TYPE', 'INVALID_FADE']) knownIssueCodes.add(code);
const protocolError=(): Error&{code: string} => Object.assign(new Error('检查响应不完整或与当前快照不匹配，请重新检查。'), { code: 'BACKEND_PROTOCOL_ERROR' });

// Never surface raw transport errors, ffprobe output, or server file locations.
export function preflightErrorMessage(error: unknown,locale: Locale = 'zh-Hans'): string {
  const code=errorCode(error);
  if (code === 'UNAUTHORIZED') return translate(locale, 'export.preflight.error.unauthorized');
  if (code!==undefined&&['CONFLICT', 'REVISION_CONFLICT', 'PREFLIGHT_STALE'].includes(code)) return translate(locale, 'export.preflight.error.changed');
  if (code === 'BACKEND_PROTOCOL_ERROR') return translate(locale, 'export.preflight.error.protocol');
  if (code!==undefined&&knownIssueCodes.has(code)) return preflightIssueMessage({ code, severity: 'error' }, locale);
  return translate(locale, 'export.preflight.error.failed');
}

export function preflightIssueMessage(issue: unknown,locale: Locale = 'zh-Hans'): string {
  const code=property(issue,'code');
  if (typeof code==='string'&&knownIssueCodes.has(code)) return translate(locale, `export.preflight.issue.${code}` as never);
  // Unknown server messages must not leak paths, probe output or credentials.
  // Preserve the bounded issue code and source ID beside a safe explanation.
  return property(issue,'severity') === 'error' ? translate(locale, 'export.preflight.issue.unknownError') : translate(locale, 'export.preflight.issue.unknownNotice');
}

export function exportCapabilityMessage(status: unknown,locale: Locale = 'zh-Hans'): string {
  return ({ idle: translate(locale, 'export.preflight.capability.idle'), checking: translate(locale, 'export.preflight.capability.checking'), available: translate(locale, 'export.preflight.capability.available'), unavailable: translate(locale, 'export.preflight.capability.unavailable'), incomplete: translate(locale, 'export.preflight.capability.incomplete'), stale: translate(locale, 'export.preflight.capability.stale'), blocked: translate(locale, 'export.preflight.capability.blocked') } as Readonly<Record<string,string>>)[String(status)] || translate(locale, 'export.preflight.capability.unknown');
}

function boundReport(report: ExportPreflightReport,context: Record<string, unknown>): boolean {
  return report.projectId === context.projectId && report.timelineId === context.timelineId &&
    report.expectedRevision === context.revision && report.timelineRevision === context.revision;
}
function canBind(report: ExportPreflightReport|null|undefined,context: Record<string, unknown>): boolean {
  if(!report)return false;
  return boundReport(report, context) && ['ready', 'incomplete'].includes(report.status) &&
    typeof report.snapshotHash === 'string' && /^[a-f0-9]{64}$/.test(report.snapshotHash) &&
    Number(report.summary?.clipCount ?? 0) > 0 && Number(report.summary?.durationFrames ?? 0) > 0 &&
    !report.issues.some(issue => issue.severity === 'error') &&
    (report.status !== 'ready' || report.checks.checkedAssets === report.checks.totalAssets);
}

function canOfferUnchecked(report: ExportPreflightReport|null|undefined,context: Record<string, unknown>): boolean {
  return report?.status === 'incomplete' && Boolean(context.connected) && Boolean(context.timelineId) && hasRevision(context.revision) &&
    report.projectId === context.projectId && report.expectedRevision === context.revision &&
    (report.timelineId === null || report.timelineId === context.timelineId) &&
    (report.timelineRevision === null || report.timelineRevision === context.revision) &&
    !report.issues.some(issue => issue.severity === 'error') && !canBind(report, context);
}

// One in-memory report for the current project. Reads are explicit and never
// mutate a project, create a render, or reuse a report as a request receipt.
export function createExportPreflightController({ read, readCapabilities, getContext, getInvocation = () => ({}), onChange = () => {}, onUnauthorized = () => {} }: ExportPreflightControllerOptions): ExportPreflightController {
  let state = initialState(), generation = 0, activeRead: AbortController|null = null, visible = false;
  const invalidate = (): void => { generation++; activeRead?.abort(); activeRead = null; };
  const emit = (patch: Partial<ExportPreflightState>): void => { state = { ...state, ...patch }; onChange(state); };
  const current = (captured: CapturedContext): boolean => {
    if (captured.generation !== generation) return false;
    // App refs can change before React commits its next layout effect. Re-read
    // that live owner before publishing a response or acting on an auth error.
    if (getContext) controller.setContext(getContext());
    return captured.generation === generation && captured.scope === state.scope && captured.projectId === state.projectId && captured.timelineId === state.timelineId && captured.revision === state.revision && captured.settingsKey === state.settingsKey && captured.settingsVersion === state.settingsVersion && sameDeliveryNameContext(captured, state) && sameExportRangeContext(captured, state) && state.connected;
  };
  const capabilityAllows = (): boolean => state.exportSettings === undefined || state.capability?.status === 'available';
  const controller: ExportPreflightController = {
    getState: () => state,
    setContext(context: ExportPreflightContext|null|undefined) {
      const settingsKey = exportSettingsKey(context?.exportSettings);
      const next = context ? { ...exportRangeContextFields(context), ...deliveryNameContextFields(context), scope: context.scope, projectId: context.projectId || null, timelineId: context.timelineId || null, revision: hasRevision(context.revision) ? context.revision : null, connected: Boolean(context.connected), settingsVersion: context.settingsVersion ?? 0, settingsKey, exportSettings: settingsKey === null ? undefined : freezeExportSettings(context.exportSettings) } : initialState();
      if (['scope', 'projectId', 'timelineId', 'revision', 'connected', 'settingsKey', 'settingsVersion', 'deliveryNameKey', 'deliveryNameVersion', 'exportRangeKey', 'rangeVersion'].every(key => state[key] === (next as Record<string, unknown>)[key])) return;
      invalidate();
      const changedProject = next.scope !== state.scope || next.projectId !== state.projectId;
      if (changedProject) state = initialState();
      emit({ ...next, capability: null, capabilityPhase: 'idle', checkingStep: null, phase: state.report ? 'stale' : 'idle', binding: null, uncheckedIntent: null, error: '', attempted: false } as Partial<ExportPreflightState>);
    },
    setVisible(next: unknown): void {
      if (visible && !next && activeRead) {
        invalidate();
        emit({ capability: null, capabilityPhase: 'idle', checkingStep: null, phase: state.report ? 'stale' : 'idle', binding: null, uncheckedIntent: null, error: '' });
      }
      visible = Boolean(next);
    },
    async check(): Promise<ExportPreflightReport|null> {
      if (getContext) controller.setContext(getContext());
      if (state.exportRangeKey === null || state.deliveryNameKey === null || state.settingsKey === null || !state.projectId || !state.timelineId || !hasRevision(state.revision) || !state.connected) return null;
      invalidate();
      const captured: CapturedContext = { ...exportRangeContextFields(state), ...deliveryNameContextFields(state), scope: state.scope, projectId: state.projectId, timelineId: state.timelineId, revision: state.revision, settingsKey: state.settingsKey, settingsVersion: state.settingsVersion, exportSettings: state.exportSettings, generation };
      const invocation = Object.freeze({ ...getInvocation() });
      const abort = new AbortController(); activeRead = abort;
      const capabilityInput = { projectId: captured.projectId, expectedRevision: captured.revision, ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) };
      const input = { ...capabilityInput, ...deliveryNameRequestFields(captured), ...rangeFields(captured) };
      emit({ phase: 'checking', checkingStep: captured.exportSettings === undefined ? 'media' : 'capability', capability: null, capabilityPhase: captured.exportSettings === undefined ? 'idle' : 'checking', binding: null, uncheckedIntent: null, error: '', attempted: false });
      try {
        // The explicit capability operation may perform a bounded local synthetic
        // encode. Media preflight remains a separate read-only operation.
        if (captured.exportSettings !== undefined) {
          if (!readCapabilities) throw protocolError();
          const capability = await readCapabilities(capabilityInput, { ...invocation, signal: abort.signal });
          if (!current(captured)) return null;
          if (!isTimelineExportCapabilitiesResponse(capability, capabilityInput)) throw protocolError();
          const typedCapability=capability as ExportCapability;
          if (typedCapability.timelineId !== null && typedCapability.timelineId !== captured.timelineId ||
            typedCapability.timelineRevision !== null && typedCapability.timelineRevision !== captured.revision && typedCapability.status !== 'stale' ||
            typedCapability.status === 'available' && (typedCapability.timelineId !== captured.timelineId || typedCapability.timelineRevision !== captured.revision)) throw protocolError();
          emit({ capability: structuredClone(typedCapability), capabilityPhase: typedCapability.status });
          if (typedCapability.status !== 'available') {
            emit({ phase: ['unavailable', 'blocked'].includes(typedCapability.status) ? 'blocked' : typedCapability.status, checkingStep: null, report: null, binding: null, uncheckedIntent: null });
            return null;
          }
          emit({ checkingStep: 'media' });
        }
        const result = await read(input, { ...invocation, signal: abort.signal });
        if (!current(captured)) return null;
        if (!isExportPreflightResponse(result, input)) throw protocolError();
        const typedResult=result as ExportPreflightReport;
        // A bounded ownership read can end before a timeline tuple is available.
        // Keep that outcome incomplete without a checked binding; any returned
        // identity/revision still has to match the saved context we requested.
        if (typedResult.status === 'ready' && !boundReport(typedResult, captured)) throw protocolError();
        if (typedResult.status === 'incomplete' && ((typedResult.timelineId !== null && typedResult.timelineId !== captured.timelineId) ||
          (typedResult.timelineRevision !== null && typedResult.timelineRevision !== captured.revision))) throw protocolError();
        if (typedResult.status === 'ready' && !canBind(typedResult, captured)) throw protocolError();
        const report = structuredClone(typedResult);
        const binding = canBind(report, captured) ? Object.freeze({ projectId: report.projectId, expectedRevision: report.expectedRevision, preflightSnapshotHash: report.snapshotHash, ...deliveryNameRequestFields(captured), ...rangeFields(captured), ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) }) : null;
        // This is a separate, explicitly unreviewed intent for the current saved
        // revision. It must never masquerade as a checked snapshot binding.
        const uncheckedIntent = canOfferUnchecked(report, state) ? Object.freeze({ projectId: state.projectId, expectedRevision: state.revision, ...deliveryNameRequestFields(captured), ...rangeFields(captured), ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) }) : null;
        emit({ report, binding, uncheckedIntent, phase: report.status, checkingStep: null, error: '' });
        return report;
      } catch (error) {
        if (!current(captured)) return null;
        emit({ phase: 'error', capabilityPhase: state.checkingStep === 'capability' ? 'incomplete' : state.capabilityPhase, checkingStep: null, binding: null, uncheckedIntent: null, error: preflightErrorMessage(error), errorCode: errorCode(error) });
        if (errorCode(error) === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (activeRead === abort) activeRead = null; }
    },
    // Binding identity also fences an old click after a newer check of the same
    // revision/hash. Taking it once prevents double-clicks and automatic retries.
    takeExportBinding(binding: Record<string, unknown>|null|undefined): Record<string, unknown>|null {
      if (getContext) controller.setContext(getContext());
      if (!visible || !capabilityAllows() || !state.connected || !binding || binding !== state.binding || state.attempted || !canBind(state.report, state) || !['ready', 'incomplete'].includes(state.phase)) return null;
      emit({ binding: null, uncheckedIntent: null, attempted: true });
      return binding;
    },
    takeUncheckedExportIntent(intent: Record<string, unknown>|null|undefined): Record<string, unknown>|null {
      if (!intent || intent !== state.uncheckedIntent) return null;
      if (getContext) controller.setContext(getContext());
      if (!visible || !capabilityAllows() || !intent || intent !== state.uncheckedIntent || state.binding || state.attempted || state.phase !== 'incomplete' || !canOfferUnchecked(state.report, state)) return null;
      emit({ uncheckedIntent: null, attempted: true });
      return intent;
    },
    dispose(): void { invalidate(); state = initialState(); visible = false; },
  };
  return controller;
}
