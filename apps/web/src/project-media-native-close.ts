import type {NativeEntryCloseSnapshot} from './native-entry-close.ts';

interface MediaCloseState {
  readonly applyAction: {readonly kind: string};
  readonly nativeOutcomeUnknown?: boolean;
}

/** Read the controller synchronously: React may not have committed the busy
 * render when main asks whether this document can close. Only metadata leaves
 * this owner; the picker token and request payload stay with the controller. */
export function createProjectMediaCloseReader(read: () => MediaCloseState): () => NativeEntryCloseSnapshot {
  let previous: MediaCloseState | null = null, version = 0;
  return () => {
    const state = read();
    if (state !== previous) {previous = state; version++;}
    return Object.freeze({dirty: false, busy: state.applyAction.kind === 'working', unknown: state.nativeOutcomeUnknown === true,
      identity: Object.freeze(['native-project-media', version])});
  };
}
