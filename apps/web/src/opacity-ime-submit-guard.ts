interface KeyObservation {
  readonly key: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly opacityTarget: boolean;
  readonly pending: boolean;
}
interface KeyUpObservation {
  readonly key: string;
  readonly keyCode?: number;
  readonly pending: boolean;
}

/** One Inspector's synthetic-submit fence. This never prevents a native IME
 * default or grants a Save; the existing controller owns every submission. */
export function createOpacityImeSubmitGuard() {
  let confirmation: object | null = null;
  return Object.freeze({
    /** Return only whether the composing key should stop bubbling to workbench
     * shortcuts. The native key default is deliberately left untouched. */
    keyDown(event: KeyObservation): boolean {
      // A held confirmation can produce repeated Enter after compositionend.
      // A repeat is not a new explicit save, even though isComposing is false.
      if (confirmation && event.key === 'Enter' && event.repeat === true) return true;
      const composing = event.pending || event.isComposing === true || event.keyCode === 229;
      if (!event.opacityTarget) {
        if (!composing) confirmation = null;
        return false;
      }
      if (composing && event.key !== 'Escape' && (event.key === 'Enter' || event.keyCode === 229)) confirmation = {};
      else if (!composing || event.key === 'Escape') confirmation = null;
      return composing && (event.key === 'Enter' || event.key === 'Escape');
    },
    keyUp(event: KeyUpObservation): void {
      if (event.pending || !['Enter', 'Process'].includes(event.key) && event.keyCode !== 229) return;
      const owner = confirmation;
      // Default submission from this event runs before release. An older
      // keyup must not release a later composition confirmation's owner.
      queueMicrotask(() => {if (confirmation === owner) confirmation = null;});
    },
    pointerDown(pending: boolean): void {
      // A later pointer gesture anywhere in the form is a new user action,
      // including focus on another field. Keyboard implicit clicks do not
      // produce this pointer event and cannot clear their own confirmation.
      if (!pending) confirmation = null;
    },
    blocksSubmit(): boolean {return confirmation !== null;},
  });
}
