import type { SettingsDiagnosticRecord, SettingsDiagnosticRequest, SettingsOpenMode, SettingsOpenOutcome, SettingsOpenPhase } from './settings-diagnostics-protocol.ts';

type Phases = Partial<Record<SettingsOpenPhase, number>>;
type PageRead = Extract<SettingsDiagnosticRequest, {kind: 'read'}>;
type Click = Extract<SettingsDiagnosticRequest, {kind: 'click'}>;
export interface SettingsOpeningDiagnostics<W extends object> {
  click(window: W, request: Click): void;
  begin(window: W, source: W | undefined, mode: SettingsOpenMode, receivedAt: number, phases: Phases): void;
  phase(window: W, phase: SettingsOpenPhase, at?: number): void;
  boot(window: W, phase: 'start' | 'import' | 'ready' | 'failed', at: number): void;
  read(window: W, request: PageRead): void;
  close(window: W): void;
  resetDocument(window: W): void;
}

const HISTORY_MS = 120_000;
const SLOW_MS = 3_000;
let nextAttempt = 0;
interface Attempt {
  id: number;
  origin: number;
  mode: SettingsOpenMode;
  phases: Phases;
  reads: Map<number, PageRead>;
  slow?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
  finished: boolean;
  slowRecorded: boolean;
  readBudget: number;
  budgetAt: number;
}

export function createSettingsOpeningDiagnostics<W extends object>({record, sample, signal, now = Date.now}: {
  record(value: SettingsDiagnosticRecord): void;
  sample(from: number, to: number, signal?: AbortSignal, onTimeout?: () => void): Promise<number | null>;
  signal: AbortSignal;
  now?: () => number;
}): SettingsOpeningDiagnostics<W> {
  const clicks = new WeakMap<W, Click>();
  const attempts = new Map<W, Attempt>();
  const write = (value: SettingsDiagnosticRecord) => setImmediate(() => {
    try { record(value); } catch { /* Evidence cannot interrupt settings. */ }
  }).unref();
  function sampleLater(from: number, to: number, report: (delay: number | null) => void, recoverable = false): void {
    // Even issuing the utility request stays off the UI path.
    setImmediate(() => {
      let recordedTimeout = false;
      const onTimeout = recoverable ? () => { recordedTimeout = true; report(null); } : undefined;
      const complete = (delay: number | null) => { if (!recordedTimeout || delay !== null) report(delay); };
      void Promise.resolve().then(() => sample(from, to, signal, onTimeout)).then(complete, () => complete(null));
    }).unref();
  }
  function snapshot(attempt: Attempt, outcome: SettingsOpenOutcome, at: number, slow = false): void {
    const elapsedMs = Math.max(0, Math.min(HISTORY_MS, at - attempt.origin));
    const phases = {...attempt.phases};
    const {id, mode, origin} = attempt;
    const recoverable = slow || outcome === 'closed' || outcome === 'pending' || elapsedMs >= SLOW_MS;
    sampleLater(origin, at, utilityMaxDelayMs => write({schemaVersion: 1, at: new Date(origin).toISOString(),
      event: slow ? 'settings-open-slow' : 'settings-open-timing', attempt: id, mode, outcome, elapsedMs, utilityMaxDelayMs, phases}), recoverable);
  }
  function slow(attempt: Attempt, outcome: SettingsOpenOutcome, at: number): void {
    if (attempt.slowRecorded) return;
    attempt.slowRecorded = true;
    snapshot(attempt, outcome, at, true);
  }
  function finish(attempt: Attempt, outcome: SettingsOpenOutcome, at: number): void {
    if (attempt.finished) return;
    attempt.finished = true;
    clearTimeout(attempt.slow); clearTimeout(attempt.expiry);
    if (at - attempt.origin >= SLOW_MS) slow(attempt, outcome, at);
    snapshot(attempt, outcome, at);
  }
  function phase(window: W, name: SettingsOpenPhase, at = now()): void {
    const attempt = attempts.get(window);
    if (!attempt || attempt.finished) return;
    if (name === 'warmFallback') {
      attempt.mode = 'warm-fallback';
      delete attempt.phases.didFinishLoad;
      delete attempt.phases.readyToShow;
    }
    attempt.phases[name] ??= at - attempt.origin;
  }
  signal.addEventListener('abort', () => {
    for (const attempt of attempts.values()) finish(attempt, 'closed', now());
    attempts.clear();
  }, {once: true});
  return {
    click(window, request) {
      const received = now();
      if (request.handledAt >= received - 15_000 && request.handledAt <= received + 250 &&
          request.eventAt >= received - HISTORY_MS) clicks.set(window, request);
    },
    begin(window, source, mode, receivedAt, prewarm) {
      if (signal.aborted) return;
      const click = source && clicks.get(source);
      if (source) clicks.delete(source);
      const correlated = click && click.handledAt <= receivedAt + 250 && receivedAt - click.handledAt <= 15_000 ? click : undefined;
      const origin = Math.min(receivedAt, correlated?.eventAt ?? receivedAt);
      const attempt: Attempt = {id: ++nextAttempt, mode, origin, phases: {mainReceived: receivedAt - origin}, reads: new Map(),
        finished: false, slowRecorded: false, readBudget: 64, budgetAt: receivedAt};
      if (correlated) {
        attempt.phases.rendererEvent = correlated.eventAt - origin;
        attempt.phases.rendererHandled = correlated.handledAt - origin;
      }
      for (const [name, at] of Object.entries(prewarm) as [SettingsOpenPhase, number][]) attempt.phases[name] = at - origin;
      const existing = attempts.get(window);
      if (mode === 'existing' && existing) {
        finish(attempt, 'shown', now());
        return;
      }
      if (existing) finish(existing, 'closed', now());
      attempts.set(window, attempt);
      attempt.slow = setTimeout(() => slow(attempt, 'pending', now()), Math.max(0, origin + SLOW_MS - now()));
      attempt.slow.unref();
      attempt.expiry = setTimeout(() => finish(attempt, 'pending', now()), 90_000);
      attempt.expiry.unref();
    },
    phase,
    boot(window, boot, at) {
      const attempt = attempts.get(window);
      if (!attempt) return;
      const received = now();
      const measured = at < attempt.origin || at > received + 250 ? received : at;
      const mark = {start: 'bootAck', import: 'bootStarted', ready: 'bootReady', failed: 'bootFailed'} as const;
      phase(window, mark[boot], measured);
      if (boot === 'ready' || boot === 'failed') finish(attempt, boot, received);
    },
    read(window, request) {
      const attempt = attempts.get(window);
      if (!attempt || Math.abs(request.at - now()) > HISTORY_MS) return;
      if (request.phase === 'start') {
        if (attempt.reads.size < 32 && !attempt.reads.has(request.requestId)) attempt.reads.set(request.requestId, request);
        return;
      }
      const start = attempt.reads.get(request.requestId);
      attempt.reads.delete(request.requestId);
      if (!start || start.page !== request.page || request.at < start.at || request.at - start.at > HISTORY_MS) return;
      if (now() - attempt.budgetAt >= 60_000) { attempt.budgetAt = now(); attempt.readBudget = 64; }
      if (attempt.readBudget-- <= 0) return;
      const durationMs = request.at - start.at;
      const startedMs = Math.max(0, start.at - attempt.origin);
      const withinOpening = startedMs + durationMs <= HISTORY_MS;
      sampleLater(start.at, request.at, utilityMaxDelayMs => {
        const read = {
          schemaVersion: 1 as const, at: new Date(withinOpening ? attempt.origin : start.at).toISOString(),
          attempt: attempt.id, page: request.page, startedMs: withinOpening ? startedMs : 0,
          endedMs: withinOpening ? startedMs + durationMs : durationMs, durationMs, utilityMaxDelayMs,
        };
        write({...read, event: 'settings-page-read'});
        if (durationMs >= SLOW_MS) write({...read, event: 'settings-page-read-slow'});
      });
    },
    close(window) {
      const attempt = attempts.get(window);
      if (attempt) finish(attempt, 'closed', now());
      attempts.delete(window); clicks.delete(window);
    },
    resetDocument(window) { attempts.get(window)?.reads.clear(); clicks.delete(window); },
  };
}
