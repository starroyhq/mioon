import { message } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { timelineDeliveryNameSchema, timelineDeliveryNameFields, isTimelineDeliveryNameSnapshot } from '@mioon/contracts/timeline-delivery';
import type { TimelineDeliveryNameInput } from '@mioon/contracts/timeline-delivery';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const DELIVERY_NAME_PLACEHOLDER = '留空使用默认文件名';
export const DELIVERY_NAME_HELP = '仅用于本次时间线导出；导出记录会保留此名称。留空沿用默认文件名，不会保存一个新名称。';
export const DELIVERY_NAME_ERROR = '请输入 1–120 个字符，不能只有空格，也不能包含换行或控制字符。';

export function deliveryNameError(value: unknown): string {
  return value === '' || value === undefined || timelineDeliveryNameSchema.safeParse(value).success ? '' : DELIVERY_NAME_ERROR;
}

export interface DeliveryNameContextFields {
  deliveryName: string | undefined;
  deliveryNameKey: string | null;
  deliveryNameVersion: number;
}

/** UI omission is explicit: only an actually empty field means no name. Every
 * nonempty value is validated unchanged, including surrounding spaces. */
export function deliveryNameContextFields(context: unknown): DeliveryNameContextFields {
  const value = object(context) ? context.deliveryName : undefined;
  const version = object(context) && typeof context.deliveryNameVersion === 'number' && Number.isSafeInteger(context.deliveryNameVersion) ? context.deliveryNameVersion : 0;
  if (value === undefined || value === '') return { deliveryName: undefined, deliveryNameKey: 'legacy', deliveryNameVersion: version };
  const parsed = timelineDeliveryNameSchema.safeParse(value);
  return { deliveryName: typeof value === 'string' ? value : undefined, deliveryNameKey: parsed.success ? JSON.stringify(parsed.data) : null, deliveryNameVersion: version };
}

export function sameDeliveryNameContext(left: unknown, right: unknown): boolean {
  return object(left) && object(right) && left.deliveryNameKey === right.deliveryNameKey && left.deliveryNameVersion === right.deliveryNameVersion;
}

export function deliveryNameRequestFields(context: unknown): TimelineDeliveryNameInput {
  const fields = deliveryNameContextFields(context);
  if (fields.deliveryNameKey === null) throw new Error(DELIVERY_NAME_ERROR);
  return fields.deliveryName === undefined ? {} : timelineDeliveryNameFields({ deliveryName: fields.deliveryName });
}

export interface DeliveryNameContext { scope: string | null; projectId: string | null; enabled: boolean }
export interface DeliveryNameState extends DeliveryNameContext { value: string; version: number; dirty: boolean; error: string }
export interface DeliveryNameCapture { readonly scope: string | null; readonly projectId: string | null; readonly value: string; readonly version: number }
interface DeliveryNameControllerOptions { getContext?: () => DeliveryNameContext; onChange?: (state: DeliveryNameState) => void }

/** Local per-export draft only. It never edits a project, a submitted request,
 * its retry receipt, or an already-created immutable export snapshot. */
export function createTimelineDeliveryNameController({ getContext, onChange = () => {} }: DeliveryNameControllerOptions = {}) {
  let version = 0, acceptedValue = '';
  const issuedCaptures = new WeakSet<DeliveryNameCapture>();
  let state: DeliveryNameState = { scope: null, projectId: null, enabled: false, value: '', version, dirty: false, error: '' };
  const emit = (patch: Partial<DeliveryNameState>) => { state = { ...state, ...patch }; onChange(state); };
  const controller = {
    getState: () => state,
    getName: (scope: string | null): string => state.scope === scope ? state.value : '',
    getVersion: (scope: string | null): number => state.scope === scope ? state.version : 0,
    hasUnsaved: (scope?: string | null): boolean => (scope === undefined || state.scope === scope) && state.dirty,
    setContext(context: DeliveryNameContext) {
      const next = { scope: context.scope, projectId: context.projectId, enabled: Boolean(context.enabled) };
      if (next.scope === state.scope && next.projectId === state.projectId && next.enabled === state.enabled) return;
      const changed = next.scope !== state.scope || next.projectId !== state.projectId;
      if (changed) acceptedValue = '';
      emit({ ...next, ...(changed ? { value: '', version: ++version, dirty: false, error: '' } : {}) });
    },
    choose(value: string, scope: string | null, expectedVersion?: number): boolean {
      if (getContext) controller.setContext(getContext());
      if (scope !== state.scope || !state.enabled || expectedVersion !== undefined && expectedVersion !== state.version) return false;
      if (typeof value !== 'string') return false;
      if (value === state.value) return true;
      emit({ value, version: ++version, dirty: true, error: deliveryNameError(value) });
      return true;
    },
    capture(): DeliveryNameCapture | null {
      if (getContext) controller.setContext(getContext());
      if (!state.projectId) return null;
      const captured = Object.freeze({ scope: state.scope, projectId: state.projectId, value: state.value, version: state.version });
      issuedCaptures.add(captured); return captured;
    },
    acknowledge(captured: DeliveryNameCapture | null, validatedResponse: unknown): boolean {
      if (getContext) controller.setContext(getContext());
      if (state.error || !captured || !issuedCaptures.has(captured) || captured.scope !== state.scope || captured.projectId !== state.projectId || captured.version !== state.version || captured.value !== state.value ||
          !object(validatedResponse) || validatedResponse.projectId !== captured.projectId || validatedResponse.mode !== 'timeline' || validatedResponse.purpose !== 'export' ||
          !['queued', 'running', 'succeeded'].includes(typeof validatedResponse.status === 'string' ? validatedResponse.status : '') ||
          !isTimelineDeliveryNameSnapshot(validatedResponse.snapshot, { purpose: 'export', input: deliveryNameRequestFields({ deliveryName: captured.value }) })) return false;
      acceptedValue = captured.value; issuedCaptures.delete(captured);
      emit({ dirty: false }); return true;
    },
    discardDraft(expectedCapture?: DeliveryNameCapture | null): boolean {
      if (getContext) controller.setContext(getContext());
      if (expectedCapture === null) return !state.projectId && !state.dirty;
      if (expectedCapture !== undefined && (!issuedCaptures.has(expectedCapture) || expectedCapture.scope !== state.scope || expectedCapture.projectId !== state.projectId || expectedCapture.version !== state.version || expectedCapture.value !== state.value)) return false;
      if (expectedCapture) issuedCaptures.delete(expectedCapture);
      emit({ value: acceptedValue, version: ++version, dirty: false, error: '' });
      return true;
    },
  };
  return controller;
}

interface DeliveryNameHookOptions extends DeliveryNameContext { getContext: () => DeliveryNameContext }
export function useTimelineDeliveryName({ scope, projectId, enabled, getContext }: DeliveryNameHookOptions) {
  const contextRef = useRef(getContext); contextRef.current = getContext;
  const [state, setState] = useState<DeliveryNameState | null>(null);
  const controllerRef = useRef<ReturnType<typeof createTimelineDeliveryNameController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createTimelineDeliveryNameController({ getContext: () => contextRef.current(), onChange: setState });
  const controller = controllerRef.current;
  useLayoutEffect(() => { controller.setContext({ scope, projectId, enabled }); }, [controller, scope, projectId, enabled]);
  const current = state?.scope === scope && state.projectId === projectId ? state : null;
  const value = current?.value ?? controller.getName(scope);
  return { scope, value, version: current?.version ?? controller.getVersion(scope), dirty: current?.dirty ?? false, error: deliveryNameError(value), controller };
}

const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export function hasNamedTimelineDelivery(value: unknown): boolean {
  return object(value) && value.mode === 'timeline' && value.purpose === 'export' && object(value.snapshot) && Object.hasOwn(value.snapshot, 'deliveryName');
}
export interface FrozenDeliveryDescription { dimensions: string; fps: number; rate: string; rateMessage?: MessageDescriptor; upscale: boolean }
export type NamedTimelineExportStatus = 'queued' | 'running' | 'succeeded' | 'failed';
const namedExportStatus = (value: unknown): value is NamedTimelineExportStatus => value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed';
export interface NamedTimelineDeliveryHistory {
  id: string; name: string; createdAt: string; revision: number; status: NamedTimelineExportStatus;
  error: string | null; output: FrozenDeliveryDescription | null; downloadHref: string | null;
}

/** Display-only adapter for frozen rate-control metadata. It intentionally
 * does not import the unchecked legacy settings module, revalidate/change the
 * accepted history projection, or translate the old source-language rate. */
function frozenRateMessage(delivery: unknown): MessageDescriptor | undefined {
  if (!object(delivery) || !object(delivery.exportSettings) || !object(delivery.exportSettings.rateControl)) return undefined;
  const rate = delivery.exportSettings.rateControl;
  if (rate.mode === 'bitrate' && (rate.targetKbps === 2000 || rate.targetKbps === 4000 || rate.targetKbps === 8000))
    return message('export.settings.rateTarget', { rate: rate.targetKbps / 1000 });
  if (rate.mode === 'crf') {
    if (rate.quality === 'compact') return message('export.settings.compact');
    if (rate.quality === 'standard') return message('export.settings.standard');
    if (rate.quality === 'high') return message('export.settings.high');
  }
  return undefined;
}

/** Validate the narrow display projection supplied by the existing profile
 * validator. Never read current project geometry or editable export settings. */
function frozenDeliveryDescription(value: unknown, snapshot: Record<string, unknown>): FrozenDeliveryDescription | null {
  const timeline = snapshot.timeline;
  if (!object(timeline) || !positiveInteger(timeline.width) || !positiveInteger(timeline.height) || timeline.fps !== 30) return null;
  if (!Object.hasOwn(snapshot, 'delivery')) return { dimensions: `${timeline.width} × ${timeline.height}`, fps: timeline.fps, rate: '原有编码设置', rateMessage: message('export.history.legacyRate'), upscale: false };
  if (!object(value) || !positiveInteger(value.width) || !positiveInteger(value.height) || value.width > 1920 || value.height > 1920 || value.fps !== 30 || typeof value.rate !== 'string' ||
      !['紧凑 · CRF 28', '标准 · CRF 23', '高画质 · CRF 18', '平均目标 2 Mb/s', '平均目标 4 Mb/s', '平均目标 8 Mb/s'].includes(value.rate)) return null;
  const rateMessage = frozenRateMessage(snapshot.delivery);
  return { dimensions: `${value.width} × ${value.height}`, fps: value.fps, rate: value.rate, ...(rateMessage ? { rateMessage } : {}), upscale: value.width > timeline.width || value.height > timeline.height };
}

export function namedTimelineDeliveryHistory(value: unknown, frozenDelivery?: unknown): NamedTimelineDeliveryHistory | null {
  if (!object(value) || !hasNamedTimelineDelivery(value) || !object(value.snapshot) || !uuid(value.id) || !positiveInteger(value.timelineRevision) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !namedExportStatus(value.status)) return null;
  const name = timelineDeliveryNameSchema.safeParse(value.snapshot.deliveryName);
  if (!name.success) return null;
  const error = typeof value.error === 'string' ? value.error : object(value.error) && typeof value.error.message === 'string' ? value.error.message : null;
  // A row URL and user-supplied name never confer media/path authority. Both IDs
  // are exact managed UUIDs and the server derives its attachment filename.
  const downloadHref = uuid(value.assetId) && value.status === 'succeeded'
    ? `/media/${value.assetId}?download=1&exportId=${value.id}` : null;
  return { id: value.id, name: name.data, createdAt: value.createdAt, revision: value.timelineRevision, status: value.status,
    error, output: frozenDeliveryDescription(frozenDelivery, value.snapshot), downloadHref };
}
