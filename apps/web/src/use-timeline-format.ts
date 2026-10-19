import { useLayoutEffect, useRef, useState } from 'react';
import { createTimelineFormatController } from './timeline-format-state.ts';
import type { TimelineFormatContext, TimelineFormatControllerOptions, TimelineFormatIntent, TimelineFormatState } from './timeline-format-state.ts';

export type TimelineFormatController=ReturnType<typeof createTimelineFormatController>;
export interface UseTimelineFormatOptions {
  scope: string|null;
  projectId: string|null|undefined;
  projectRevision: number|undefined;
  timelineId: string|null|undefined;
  timelineRevision: number|undefined;
  connected: boolean;
  pending: boolean;
  refreshKey: unknown;
  visible: boolean;
  read: TimelineFormatControllerOptions['read'];
  submit: (intent: TimelineFormatIntent)=>Promise<unknown>;
  createRequestId: ()=>string;
  getContext: ()=>TimelineFormatContext|null|undefined;
  onUnauthorized?: ()=>void;
}
export interface UseTimelineFormatResult {state: TimelineFormatState|null; controller: TimelineFormatController}

export function useTimelineFormat({ scope, projectId, projectRevision, timelineId, timelineRevision, connected, pending, refreshKey, visible, read, submit, createRequestId, getContext, onUnauthorized }: UseTimelineFormatOptions): UseTimelineFormatResult {
  const callbacks = useRef<UseTimelineFormatOptions|null>(null); callbacks.current = { scope: scope ?? '', projectId, projectRevision, timelineId, timelineRevision, connected, pending, refreshKey, visible, read, submit, createRequestId, getContext, onUnauthorized };
  const [state, setState] = useState<TimelineFormatState|null>(null), controller = useRef<TimelineFormatController|null>(null);
  if (!controller.current) controller.current = createTimelineFormatController({
    read: (input: {projectId: string}, options: {signal: AbortSignal}) => callbacks.current!.read(input, options),
    submit: (intent: TimelineFormatIntent) => callbacks.current!.submit(intent) as ReturnType<NonNullable<TimelineFormatControllerOptions['submit']>>,
    createRequestId: () => callbacks.current!.createRequestId(), getContext: () => callbacks.current!.getContext(),
    onUnauthorized: () => callbacks.current?.onUnauthorized?.(), onChange: setState,
  });
  useLayoutEffect(() => { controller.current!.setContext({ scope, projectId: projectId ?? null, projectRevision: projectRevision ?? undefined, timelineId: timelineId ?? null, timelineRevision: timelineRevision ?? undefined, connected, pending }); }, [scope, projectId, projectRevision, timelineId, timelineRevision, connected, pending]);
  useLayoutEffect(() => { controller.current!.setVisible(visible); }, [visible]);
  useLayoutEffect(() => { if (projectId && connected && visible) void controller.current!.load(); }, [scope, projectId, projectRevision, timelineId, timelineRevision, connected, refreshKey, visible]);
  useLayoutEffect(() => () => controller.current?.dispose(), []);
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
