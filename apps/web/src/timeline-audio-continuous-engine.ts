/** The continuous protocol delivers a complete, already mixed stereo block.
 * AudioContext time owns playback; RAF only paints its disposable cursor. */
export interface ContinuousAudioPlanClock {
  startFrame: number;
  durationFrames: number;
  blockFrames: number;
  sampleRate: number;
  channels: number;
}
export interface ContinuousAudioBlock { startFrame: number; endFrame: number; buffer: AudioBuffer }
export type ContinuousAudioTransportStatus = 'ready' | 'starting' | 'playing' | 'paused' | 'buffering' | 'stopped' | 'ended' | 'disposed';
export type ContinuousAudioStopReason = 'explicit-stop' | 'outside-prepared-interval' | 'context-suspended' | 'context-closed' | 'audio-output-failed' | 'resume-failed' | 'schedule-failed' | 'load-failed' | 'revoked';
export interface ContinuousAudioTransportState {
  status: ContinuousAudioTransportStatus;
  sample: number;
  frame: number;
  reason: ContinuousAudioStopReason | null;
  errorCode: string;
  underruns: number;
  /** Conservative AudioBuffer payload and acquisition copy, excluding the
   * separately admitted decoder/HTTP transport allocation. */
  heldBytes: number;
  peakHeldBytes: number;
}
export interface ContinuousAudioTransportOptions {
  context: AudioContext;
  plan: ContinuousAudioPlanClock;
  initialBlock: ContinuousAudioBlock;
  /** This promise settles only after the exact request's resources settle,
   * including cancellation. Only one request is ever in flight. */
  loadBlock(startFrame: number, signal: AbortSignal): Promise<ContinuousAudioBlock>;
  /** Reset the server cursor before a discontinuous, unbuffered seek/replay. */
  onReset?: (startFrame: number, signal: AbortSignal) => Promise<void>;
  onChange?: (state: ContinuousAudioTransportState) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  destination?: AudioNode;
}
export interface ContinuousTimelineAudioTransport {
  play(): Promise<boolean>;
  pause(): void;
  seek(frame: number): Promise<boolean>;
  stop(reason?: ContinuousAudioStopReason): void;
  dispose(): Promise<void>;
  getState(): ContinuousAudioTransportState;
}

const RATE = 48_000, FRAME = 1_600, LEAD = 0.02;
const errorCode = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
const invalid = (): never => { throw Object.assign(new Error('Invalid continuous audio block or clock.'), { code: 'AUDIO_PREVIEW_INVALID_GRAPH' }); };

/** At most two mixed blocks are retained. A ready next block is scheduled at
 * the exact preceding end time, before the end event reaches JavaScript. */
export function createContinuousTimelineAudioTransport(options: ContinuousAudioTransportOptions): ContinuousTimelineAudioTransport {
  const { context, loadBlock, onReset, onChange, destination = context.destination } = options;
  const { startFrame, durationFrames, blockFrames, sampleRate, channels } = options.plan;
  const requestFrame = options.requestAnimationFrame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : undefined);
  const cancelFrame = options.cancelAnimationFrame ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : undefined);
  if (context.sampleRate !== RATE || sampleRate !== RATE || channels !== 2 || !Number.isSafeInteger(durationFrames) || durationFrames < 1 || durationFrames > 18_000 ||
      !Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= durationFrames || blockFrames !== 60) invalid();
  const validate = (block: ContinuousAudioBlock, expected: number): ContinuousAudioBlock => {
    if (!block || block.startFrame !== expected || block.endFrame !== Math.min(expected + blockFrames, durationFrames) ||
        !block.buffer || block.buffer.numberOfChannels !== 2 || block.buffer.sampleRate !== RATE || block.buffer.length !== (block.endFrame - block.startFrame) * FRAME) invalid();
    return block;
  };
  let current: ContinuousAudioBlock | null = validate(options.initialBlock, startFrame);
  let next: ContinuousAudioBlock | null = null;
  interface Graph { source: AudioBufferSourceNode; block: ContinuousAudioBlock; released: boolean; ended: boolean }
  interface Flight { abort: AbortController; promise: Promise<ContinuousAudioBlock | null> }
  let currentGraph: Graph | null = null, nextGraph: Graph | null = null, flight: Flight | null = null;
  let status: ContinuousAudioTransportStatus = 'ready', reason: ContinuousAudioStopReason | null = null, failure = '';
  let cursor = startFrame * FRAME, generation = 0, wantsPlaying = false;
  let originSample = cursor, originTime = 0, scheduledEnd = cursor;
  let underruns = 0, peakHeldBytes = 0, frameHandle: number | null = null, closing: Promise<void> | null = null;
  let retirementFailure: unknown = null;
  let hasRunningClock = context.state === 'running';
  const heldBytes = (): number => 2 * ((current?.buffer.length ?? 0) + (next?.buffer.length ?? 0)) * 2 * 4;
  const currentSample = (): number => status === 'playing'
    ? Math.min(scheduledEnd, originSample + Math.max(0, Math.floor((context.currentTime - originTime) * RATE + 1e-6))) : cursor;
  const getState = (): ContinuousAudioTransportState => {
    const sample = currentSample(), held = heldBytes(); peakHeldBytes = Math.max(peakHeldBytes, held);
    return { status, sample, frame: Math.floor(sample / FRAME), reason, errorCode: failure, underruns, heldBytes: held, peakHeldBytes };
  };
  const emit = (): void => { onChange?.(getState()); };
  const isCurrent = (token: number): boolean => token === generation && status !== 'stopped' && status !== 'disposed';
  const cancelPaint = (): void => { if (frameHandle !== null) { cancelFrame?.(frameHandle); frameHandle = null; } };
  const release = (graph: Graph | null): void => {
    if (!graph || graph.released) return;
    graph.released = true; graph.source.onended = null;
    try { graph.source.stop(); } catch { /* Already ended. */ }
    try { graph.source.disconnect(); } catch { /* Idempotent retirement. */ }
    try { graph.source.buffer = null; } catch { /* Some implementations retain it until collection. */ }
  };
  const clearGraphs = (): void => { release(currentGraph); release(nextGraph); currentGraph = null; nextGraph = null; cancelPaint(); };
  const revoke = (): number => { generation++; clearGraphs(); flight?.abort.abort(); return generation; };
  const paint = (token: number): void => {
    if (!requestFrame || !isCurrent(token) || status !== 'playing') return;
    frameHandle = requestFrame(() => {
      if (!isCurrent(token) || status !== 'playing') return;
      frameHandle = null; emit(); paint(token);
    });
  };
  const quiesce = async (): Promise<void> => {
    const pending = flight;
    if (!pending) return;
    pending.abort.abort();
    try { await pending.promise; }
    catch (error) { if (errorCode(error) === 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED') { retirementFailure = error; throw error; } }
  };
  const request = async (frame: number, token: number, reset: boolean): Promise<ContinuousAudioBlock | null> => {
    await quiesce();
    if (!isCurrent(token)) return null;
    const abort = new AbortController();
    const pending: Flight = { abort, promise: Promise.resolve(null) };
    pending.promise = (async () => {
      if (reset) await onReset?.(frame, abort.signal);
      if (!isCurrent(token) || abort.signal.aborted) return null;
      const block = await loadBlock(frame, abort.signal);
      if (!isCurrent(token) || abort.signal.aborted) return null;
      return validate(block, frame);
    })();
    flight = pending;
    try { return await pending.promise; }
    catch (error) { if (errorCode(error) === 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED') retirementFailure = error; throw error; }
    finally { if (flight === pending) flight = null; }
  };
  const unlisten = (): void => { context.removeEventListener('statechange', stateChanged); context.removeEventListener('error', outputFailed); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    unlisten();
    let closed: Promise<void>;
    try { closed = context.state === 'closed' ? Promise.resolve() : context.close().then(() => { if (context.state !== 'closed') throw Error('Audio context closure was not confirmed.'); }); }
    catch (error) { closed = Promise.reject(error); }
    closing = Promise.all([closed, quiesce()]).then(() => { if (retirementFailure) throw retirementFailure; });
    return closing;
  };
  const stop = (why: ContinuousAudioStopReason = 'explicit-stop'): void => {
    if (status === 'disposed' || status === 'stopped') return;
    cursor = currentSample(); revoke(); wantsPlaying = false; current = null; next = null; reason = why; status = 'stopped';
    void close().catch(() => { /* dispose exposes the exact retirement failure. */ }); emit();
  };
  function stateChanged(): void {
    if (status === 'disposed' || status === 'stopped') return;
    if (context.state === 'running') hasRunningClock = true;
    else if (context.state === 'closed') stop('context-closed');
    else if (hasRunningClock || status === 'playing' || status === 'paused') stop('context-suspended');
  }
  function outputFailed(): void { stop('audio-output-failed'); }
  context.addEventListener('statechange', stateChanged); context.addEventListener('error', outputFailed);
  const fail = (error: unknown, token: number): void => { if (isCurrent(token)) { failure = errorCode(error); stop('load-failed'); } };
  const makeGraph = (block: ContinuousAudioBlock, from: number, token: number): Graph => {
    const source = context.createBufferSource();
    const graph: Graph = { source, block, released: false, ended: false };
    try {
      source.buffer = block.buffer; source.channelCount = 2; source.channelCountMode = 'explicit'; source.channelInterpretation = 'discrete';
      source.connect(destination);
      source.onended = () => boundary(graph, token);
      source.start(originTime + (from - originSample) / RATE, (from - block.startFrame * FRAME) / RATE, (block.endFrame * FRAME - from) / RATE);
      return graph;
    } catch (error) { release(graph); throw error; }
  };
  const enterBuffering = (sample: number): void => {
    cursor = sample; clearGraphs(); status = 'buffering'; underruns++; emit();
  };
  const prefetch = (token: number): void => {
    if (!isCurrent(token) || status !== 'playing' || !current || next || current.endFrame >= durationFrames) return;
    const frame = current.endFrame;
    void request(frame, token, false).then(block => {
      if (!block || !isCurrent(token) || !wantsPlaying) return;
      if (status === 'buffering' && cursor === frame * FRAME && !current) {
        current = block; schedule(token); return;
      }
      if (status !== 'playing' || !current || current.endFrame !== frame || next) return;
      next = block;
      const when = originTime + (frame * FRAME - originSample) / RATE;
      if (when <= context.currentTime) {
        // The preceding end callback may itself be delayed. Preserve its
        // exact cursor instead of scheduling a source in the past.
        enterBuffering(frame * FRAME);
        if (!isCurrent(token) || !wantsPlaying) return;
        current = next; next = null; schedule(token); return;
      }
      try { nextGraph = makeGraph(block, frame * FRAME, token); scheduledEnd = block.endFrame * FRAME; emit(); }
      catch { if (isCurrent(token)) stop('schedule-failed'); }
    }, error => fail(error, token));
  };
  function boundary(graph: Graph, token: number): void {
    if (!isCurrent(token) || status !== 'playing') return;
    graph.ended = true;
    // End events may be delivered late. Remember an already ended successor
    // until its predecessor transfers ownership, rather than losing its end.
    if (graph !== currentGraph) return;
    const end = graph.block.endFrame * FRAME;
    release(graph); currentGraph = null; current = null;
    if (end === durationFrames * FRAME) {
      cursor = end; clearGraphs(); next = null; wantsPlaying = false; status = 'ended'; reason = null; emit(); return;
    }
    if (next && nextGraph) {
      current = next; currentGraph = nextGraph; next = null; nextGraph = null;
      cursor = end; emit();
      if (isCurrent(token) && currentGraph?.ended) boundary(currentGraph, token);
      else prefetch(token);
      return;
    }
    enterBuffering(end);
    if (next && isCurrent(token) && wantsPlaying) { current = next; next = null; schedule(token); }
  }
  function schedule(token: number): boolean {
    if (!isCurrent(token) || !wantsPlaying || !current) return false;
    if (context.state !== 'running') { stop('context-suspended'); return false; }
    clearGraphs(); originSample = cursor; originTime = context.currentTime + LEAD; scheduledEnd = current.endFrame * FRAME;
    try {
      currentGraph = makeGraph(current, cursor, token);
      if (next) { nextGraph = makeGraph(next, next.startFrame * FRAME, token); scheduledEnd = next.endFrame * FRAME; }
      status = 'playing'; reason = null; emit();
      if (!isCurrent(token)) return false;
      paint(token); prefetch(token); return true;
    } catch { if (isCurrent(token)) stop('schedule-failed'); return false; }
  }
  const contains = (block: ContinuousAudioBlock | null, sample: number): block is ContinuousAudioBlock => Boolean(block && sample >= block.startFrame * FRAME && sample < block.endFrame * FRAME);
  const selectBuffered = (sample: number): boolean => {
    if (contains(current, sample)) return true;
    if (contains(next, sample)) { current = next; next = null; return true; }
    current = null; next = null; return false;
  };
  const play = async (): Promise<boolean> => {
    if (status === 'disposed' || status === 'stopped') return false;
    if (status === 'playing') return true;
    cursor = currentSample(); const token = revoke();
    if (cursor >= durationFrames * FRAME) { cursor = startFrame * FRAME; current = null; next = null; }
    wantsPlaying = true; status = 'starting'; reason = null; failure = ''; emit();
    if (!isCurrent(token) || !wantsPlaying) return false;
    try {
      await context.resume();
      if (!isCurrent(token) || !wantsPlaying) return false;
      if (context.state !== 'running') { stop('resume-failed'); return false; }
      hasRunningClock = true;
      if (!selectBuffered(cursor)) {
        status = 'buffering'; emit();
        if (!isCurrent(token) || !wantsPlaying) return false;
        const block = await request(Math.floor(cursor / FRAME), token, true);
        if (!block || !isCurrent(token) || !wantsPlaying) return false;
        current = block;
      }
      return schedule(token);
    } catch (error) { if (isCurrent(token)) { failure = errorCode(error); stop('resume-failed'); } return false; }
  };
  const pause = (): void => {
    if (!['playing', 'starting', 'buffering'].includes(status)) return;
    cursor = currentSample(); revoke(); wantsPlaying = false; status = 'paused'; reason = null; emit();
  };
  const seek = async (frame: number): Promise<boolean> => {
    if (status === 'disposed' || status === 'stopped') return false;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > durationFrames) { stop('outside-prepared-interval'); return false; }
    const token = revoke(); cursor = frame * FRAME; reason = null; failure = '';
    if (frame === durationFrames) { current = null; next = null; wantsPlaying = false; status = 'ended'; emit(); return true; }
    // A seek can replace a still pending initial resume. Unlock the newest
    // gesture independently; the older acknowledgement owns no scheduling.
    let resumed: Promise<unknown> | null = null;
    if (wantsPlaying && context.state !== 'running') {
      try { resumed = context.resume().then(() => null, error => error); }
      catch { stop('resume-failed'); return false; }
    }
    const resumeSeek = async (): Promise<boolean> => {
      const error = await resumed;
      if (!isCurrent(token) || !wantsPlaying) return false;
      if (error || context.state !== 'running') { stop('resume-failed'); return false; }
      hasRunningClock = true; return schedule(token);
    };
    if (selectBuffered(cursor)) {
      status = 'paused';
      if (wantsPlaying) return resumed ? resumeSeek() : schedule(token);
      emit(); return true;
    }
    status = 'buffering'; emit();
    if (!isCurrent(token)) return false;
    try {
      const block = await request(frame, token, true);
      if (!block || !isCurrent(token)) return false;
      current = block;
      if (wantsPlaying) return resumed ? resumeSeek() : schedule(token);
      status = 'paused'; emit(); return true;
    } catch (error) { fail(error, token); return false; }
  };
  const dispose = (): Promise<void> => {
    if (status !== 'disposed') { cursor = currentSample(); revoke(); wantsPlaying = false; current = null; next = null; status = 'disposed'; emit(); }
    return close();
  };
  getState();
  return { play, pause, seek, stop, dispose, getState };
}
