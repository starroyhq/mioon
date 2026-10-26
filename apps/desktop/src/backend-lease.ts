export const BACKEND_LEASE_TIMING = Object.freeze({
  timeoutMs: 30000, checkIntervalMs: 5000, pauseGapMs: 15000,
});

interface Recovery {readonly probeId: number; remainingMs: number}
interface Options {
  now(): number;
  probe(probeId: number): void;
  expire(): void;
}

/** A monotonic clock avoids wall-clock adjustments, but can include system
 * sleep (including Darwin's continuous clock). A long local execution gap is
 * therefore a reason to prove the current parent, not evidence of its death. */
export function createBackendLease(options: Options) {
  let active = true, observedAt = options.now(), lastPing = observedAt, nextProbe = 0;
  let recovery: Recovery | null = null;
  function expire(): null {
    if (active) { active = false; options.expire(); }
    return null;
  }
  function observe(): number | null {
    if (!active) return null;
    const now = options.now(), elapsed = Math.max(0, now - observedAt);
    observedAt = now;
    if (recovery) {
      // A second sleep must not consume the entire proof budget on wake, nor
      // restart that budget indefinitely. Charge one check quantum for each
      // further long pause; ordinary execution consumes its full elapsed time.
      recovery.remainingMs -= elapsed > BACKEND_LEASE_TIMING.pauseGapMs ? BACKEND_LEASE_TIMING.checkIntervalMs : elapsed;
      if (recovery.remainingMs <= 0) return expire();
    } else if (elapsed > BACKEND_LEASE_TIMING.pauseGapMs) {
      if (nextProbe >= Number.MAX_SAFE_INTEGER) return expire();
      recovery = {probeId: ++nextProbe, remainingMs: BACKEND_LEASE_TIMING.timeoutMs};
      try { options.probe(recovery.probeId); } catch { return expire(); }
    }
    return active ? now : null;
  }
  return Object.freeze({
    check() {
      const now = observe();
      if (now !== null && !recovery && now - lastPing > BACKEND_LEASE_TIMING.timeoutMs) expire();
    },
    ping() {
      const now = observe();
      // An already queued ping cannot prove the parent survived the pause.
      if (now !== null && !recovery) lastPing = now;
    },
    acknowledge(probeId: number) {
      const pending = recovery;
      const now = observe();
      // This response must follow its probe. An unsolicited/old ACK that is
      // itself the first callback after sleep cannot acknowledge a new probe
      // created while observing that same callback.
      if (now !== null && pending && recovery === pending && pending.probeId === probeId) { recovery = null; lastPing = now; }
    },
    close() { active = false; recovery = null; },
  });
}
