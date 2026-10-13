import { useLayoutEffect, useRef, useState } from 'react';
import { createClipDraftClient } from './clip-draft-client.ts';
import { createClipDraftController } from './clip-draft-state.ts';
import type { ClipDraftContext, ClipDraftController, ClipDraftState } from './clip-draft-state.ts';

interface Options {
  context: ClipDraftContext;
  onDirtyChange: (dirty: boolean) => void;
  onReviewBlockedChange?: (blocked: boolean) => void;
  validateTimeline: (value: unknown, projectId: string) => boolean;
  onDraftController?: (controller: ClipDraftController) => (() => void) | void;
}
export function useClipDraft({ context, onDirtyChange, onDraftController, onReviewBlockedChange, validateTimeline }: Options) {
  const callbacks = useRef({ onDirtyChange, onDraftController, onReviewBlockedChange }); callbacks.current = { onDirtyChange, onDraftController, onReviewBlockedChange };
  const [state, setState] = useState<ClipDraftState | null>(null);
  const ref = useRef<ClipDraftController | null>(null);
  if (!ref.current) ref.current = createClipDraftController({ context, client: createClipDraftClient(), validateTimeline, onChange: next => { setState(next); callbacks.current.onDirtyChange(next.dirty || next.submitting); callbacks.current.onReviewBlockedChange?.(next.dirty || next.submitting || next.businessPending || Boolean(next.candidate) || !['ready', 'saved'].includes(next.phase)); } });
  const controller = ref.current;
  const contextKey = JSON.stringify(context);
  useLayoutEffect(() => { controller.setContext(context); }, [controller, contextKey]);
  useLayoutEffect(() => {
    controller.activate();
    callbacks.current.onReviewBlockedChange?.(true);
    const unregister = callbacks.current.onDraftController?.(controller);
    void controller.load();
    return () => { unregister?.(); controller.dispose(); callbacks.current.onDirtyChange(false); callbacks.current.onReviewBlockedChange?.(true); };
  }, [controller]);
  return { state: state ?? controller.getState(), controller };
}
