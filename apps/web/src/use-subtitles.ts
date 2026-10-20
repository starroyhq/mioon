import type { AgentEditingProof } from './agent-editing-proof.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { createSubtitleController } from './subtitle-state.ts';
import type { SubtitleContext, SubtitleControllerOptions, SubtitleIntent, SubtitleState } from './subtitle-state.ts';

export type SubtitleController=ReturnType<typeof createSubtitleController>;
export interface UseSubtitlesOptions {
  collaboration?: AgentEditingProof | null;
  scope: string|null;
  projectId: string|null|undefined;
  timeline: unknown;
  connected: boolean;
  pending: boolean;
  visible: boolean;
  submit: (intent: SubtitleIntent)=>Promise<unknown>;
  createRequestId: ()=>string;
  getContext: ()=>SubtitleContext|null|undefined;
  onDirtyChange?: (dirty: boolean)=>void;
}
export interface UseSubtitlesResult {state: SubtitleState|null; controller: SubtitleController}

export function useSubtitles({ collaboration, scope, projectId, timeline, connected, pending, visible, submit, createRequestId, getContext, onDirtyChange }: UseSubtitlesOptions): UseSubtitlesResult {
  const callbacks = useRef<UseSubtitlesOptions|null>(null); callbacks.current = { collaboration, scope, projectId, timeline, connected, pending, visible, submit, createRequestId, getContext, onDirtyChange };
  const [state, setState] = useState<SubtitleState|null>(null), controller = useRef<SubtitleController|null>(null);
  if (!controller.current) controller.current = createSubtitleController({
    submit: (intent: SubtitleIntent) => callbacks.current!.submit(intent) as ReturnType<NonNullable<SubtitleControllerOptions['submit']>>, createRequestId: () => callbacks.current!.createRequestId(), getContext: () => callbacks.current!.getContext(),
    onChange: (next: SubtitleState) => { setState(next); callbacks.current?.onDirtyChange?.(Boolean(next.dirty || next.submitting)); },
  });
  useLayoutEffect(() => { controller.current!.activate(); return () => controller.current?.dispose(); }, []);
  useLayoutEffect(() => { controller.current!.setContext({ collaboration, scope, projectId: projectId ?? null, timeline: timeline as import('./subtitle-state.ts').SubtitleTimeline|null, connected, pending }); }, [scope, projectId, timeline, connected, pending, JSON.stringify(collaboration)]);
  useLayoutEffect(() => { controller.current!.setVisible(visible); }, [visible]);
  return { state: state?.scope === scope && state?.projectId === projectId ? state : null, controller: controller.current };
}
