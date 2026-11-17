/** The active media binding owns the live frame. Workspace preferences only
 * receive positions from explicit seeks or when the binding settles. */
export function createTimelinePlaybackClock() {
  let owner: object | null = null;
  let frame: number | null = null;
  let seekFrame: number | null = null;
  let seekRevision = 0;
  const listeners = new Set<() => void>();
  function publish() {
    for (const listener of listeners) listener();
  }
  function setFrame(next: number | null) {
    if (next === frame) return;
    frame = next;
    publish();
  }
  return {
    getSnapshot: () => frame,
    getSeekFrame: () => seekFrame,
    getSeekRevision: () => seekRevision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(binding: object, next: number) {
      owner = binding;
      setFrame(next);
    },
    tick(binding: object, next: number) {
      if (owner === binding) setFrame(next);
    },
    stop(binding: object) {
      if (owner !== binding) return false;
      owner = null;
      setFrame(null);
      return true;
    },
    seek(next: number, changesMedia = false) {
      // The next binding reads the saved playhead on mount. Do not seek the
      // retiring element or let its queued pause replace that destination.
      if (changesMedia) {
        owner = null;
        setFrame(null);
        return;
      }
      seekFrame = next;
      seekRevision++;
      if (owner !== null) frame = next;
      publish();
    },
  };
}

export type TimelinePlaybackClock = ReturnType<typeof createTimelinePlaybackClock>;
