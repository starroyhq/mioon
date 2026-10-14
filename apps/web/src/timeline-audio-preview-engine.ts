import {
  audioPreviewPlanSchema, audioPreviewEnvelopeGainAtLocalSample,
  type AudioPreviewPlan, type AudioPreviewVoice,
} from '@mioon/contracts/timeline-audio-preview';

/** Audio is scheduled on this clock only. RAF below is a disposable view of it. */
export const AUDIO_PREVIEW_SAMPLE_RATE = 48_000;
export const AUDIO_PREVIEW_SAMPLES_PER_FRAME = 1_600;
export const AUDIO_PREVIEW_SCHEDULE_LEAD_SECONDS = 0.02;
const RATE = AUDIO_PREVIEW_SAMPLE_RATE;
const FRAME = AUDIO_PREVIEW_SAMPLES_PER_FRAME;

export type AudioPreviewTransportStatus = 'ready' | 'starting' | 'playing' | 'paused' | 'stopped' | 'ended' | 'disposed';
export type AudioPreviewStopReason = 'explicit-stop' | 'outside-prepared-interval' | 'context-suspended' | 'context-closed' | 'audio-output-failed' | 'resume-failed' | 'schedule-failed' | 'revoked';
export interface AudioPreviewTransportState {
  status: AudioPreviewTransportStatus;
  frame: number;
  /** Absolute timeline sample, deliberately not rounded to an editing frame. */
  sample: number;
  reason: AudioPreviewStopReason | null;
}
export interface PreparedTimelineAudioPreview {
  plan: AudioPreviewPlan;
  /** Fully validated, finite PCM. Ownership transfers to the transport. No later writes. */
  buffers: ReadonlyMap<string, AudioBuffer>;
}
export interface AudioPreviewGraphOptions extends PreparedTimelineAudioPreview {
  context: BaseAudioContext;
  cursorSample: number;
  /** One caller-chosen context-clock origin for every voice and the end sentinel. */
  originTime: number;
  destination?: AudioNode;
  onEnded?: () => void;
}
export interface AudioPreviewScheduledGraph {
  readonly originTime: number;
  readonly endTime: number;
  readonly nodeCount: number;
  stop(): void;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'AUDIO_PREVIEW_INVALID_GRAPH' });
}
function validateBuffers(plan: AudioPreviewPlan, buffers: ReadonlyMap<string, AudioBuffer>, context: BaseAudioContext): void {
  if (context.sampleRate !== RATE) invalid('Sound audition requires an actual 48000 Hz audio context.');
  if (buffers.size !== plan.sources.length) invalid('Prepared audio must contain exactly the admitted sources.');
  for (const source of plan.sources) {
    const buffer = buffers.get(source.sourceKey);
    if (!buffer || buffer.sampleRate !== RATE || buffer.numberOfChannels !== 2 || buffer.length !== source.sampleFrames)
      invalid('Prepared audio does not match its exact stereo sample count.');
  }
  // Never call getChannelData after acquisition: Chromium may copy a buffer
  // already owned by a source. Finiteness was checked during serial preparation.
}

function applyEnvelope(param: AudioParam, voice: AudioPreviewVoice, from: number, to: number, when: number): void {
  const clipStart = voice.startFrame * FRAME;
  const points = [from, voice.startFrame * FRAME + voice.fadeInFrames * FRAME,
    (voice.startFrame + voice.durationFrames - voice.fadeOutFrames) * FRAME, to];
  const boundaries = [...new Set(points.filter(sample => sample >= from && sample <= to))].sort((a, b) => a - b);
  const initial = audioPreviewEnvelopeGainAtLocalSample(voice, from - clipStart);
  // A source onset may round to the sample just before its floating-time
  // automation event. That first sample must use the original envelope too,
  // rather than GainNode's default intrinsic value of one.
  param.value = initial;
  param.setValueAtTime(initial, when);
  for (const sample of boundaries.slice(1)) {
    // The right endpoint is a continuous envelope limit, not a half-open
    // membership test. An interval cut through a fade must not ramp to silence.
    param.linearRampToValueAtTime(audioPreviewEnvelopeGainAtLocalSample(voice, sample - clipStart), when + (sample - from) / RATE);
  }
}

/** The production graph, also used unchanged with an OfflineAudioContext.
 * Stereo source buffers already contain FFmpeg's channel conversion. Summing is
 * additive float; there is no normalization, limiter, compressor or HTML clock. */
export function scheduleTimelineAudioPreviewGraph(options: AudioPreviewGraphOptions): AudioPreviewScheduledGraph {
  const { context, buffers, cursorSample, originTime, onEnded } = options;
  const plan = audioPreviewPlanSchema.parse(options.plan);
  validateBuffers(plan, buffers, context);
  if (!Number.isSafeInteger(cursorSample) || cursorSample < plan.range.startSample || cursorSample >= plan.range.endSample)
    invalid('Playback cursor is outside the prepared interval.');
  if (!Number.isFinite(originTime) || originTime < context.currentTime) invalid('Playback origin is in the past.');
  const destination = options.destination ?? context.destination;
  const nodes: Array<{ source: AudioBufferSourceNode; gain: GainNode | null; released: boolean }> = [];
  const endTime = originTime + (plan.range.endSample - cursorSample) / RATE;
  let stopped = false;
  const release = (entry: typeof nodes[number]): void => {
    if (entry.released) return;
    entry.released = true;
    entry.source.onended = null;
    try { entry.source.stop(); } catch { /* A naturally ended source is already stopped. */ }
    try { entry.source.disconnect(); } catch { /* Idempotent teardown. */ }
    try { entry.gain?.disconnect(); } catch { /* Idempotent teardown. */ }
    // Release retained source PCM only after stopping and disconnecting.
    try { entry.source.buffer = null; } catch { /* A retired implementation may retain it until node collection. */ }
  };
  const stop = (): void => { if (stopped) return; stopped = true; for (const entry of nodes) release(entry); };
  try {
    for (const voice of plan.voices) {
      const from = Math.max(cursorSample, voice.intersectionStartFrame * FRAME);
      const to = Math.min(plan.range.endSample, voice.intersectionEndFrame * FRAME);
      if (from >= to || voice.gain === 0) continue;
      const source = context.createBufferSource();
      const entry = { source, gain: null as GainNode | null, released: false }; nodes.push(entry);
      const gain = context.createGain(); entry.gain = gain;
      source.buffer = buffers.get(voice.sourceKey)!;
      source.channelCount = 2; source.channelCountMode = 'explicit'; source.channelInterpretation = 'discrete';
      gain.channelCount = 2; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'discrete';
      source.connect(gain); gain.connect(destination);
      const when = originTime + (from - cursorSample) / RATE;
      applyEnvelope(gain.gain, voice, from, to, when);
      source.onended = () => release(entry);
      source.start(when, (from - voice.intersectionStartFrame * FRAME) / RATE, (to - from) / RATE);
    }
    // A clock-owned silent end sentinel also handles empty windows and trailing
    // gaps, without a wall timer or RAF changing transport state. Its 16 bytes
    // including acquisition copy fit the admitted 2 MiB transport reserve.
    const sentinel = context.createBufferSource();
    const entry = { source: sentinel, gain: null, released: false }; nodes.push(entry);
    sentinel.buffer = context.createBuffer(2, 1, RATE);
    sentinel.loop = true; sentinel.connect(destination);
    sentinel.onended = () => { if (stopped) return; stop(); onEnded?.(); };
    sentinel.start(originTime); sentinel.stop(endTime);
    return { originTime, endTime, nodeCount: nodes.length, stop };
  } catch (error) { stop(); throw error; }
}

export interface AudioPreviewTransportOptions extends PreparedTimelineAudioPreview {
  /** Created only on explicit prepare/play. The transport owns closing it. */
  context: AudioContext;
  onChange?: (state: AudioPreviewTransportState) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  /** Test/capture routing; ordinary callers use the context destination. */
  destination?: AudioNode;
}
export interface TimelineAudioPreviewTransport {
  play(): Promise<boolean>;
  pause(): void;
  /** Absolute editing frame. The end endpoint is a stopped end cursor. */
  seek(frame: number): boolean;
  /** Terminal; a new explicit prepare is required after any stop. */
  stop(reason?: AudioPreviewStopReason): void;
  dispose(): Promise<void>;
  getState(): AudioPreviewTransportState;
}

export function createTimelineAudioPreviewTransport(options: AudioPreviewTransportOptions): TimelineAudioPreviewTransport {
  const context = options.context;
  const { onChange, destination } = options;
  const plan = audioPreviewPlanSchema.parse(options.plan);
  validateBuffers(plan, options.buffers, context);
  // Only map entries are copied. Channel arrays are never cloned or reacquired.
  const buffers = new Map(options.buffers);
  const requestFrame = options.requestAnimationFrame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : undefined);
  const cancelFrame = options.cancelAnimationFrame ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : undefined);
  let status: AudioPreviewTransportStatus = 'ready';
  let hasRunningClock = context.state === 'running';
  let reason: AudioPreviewStopReason | null = null;
  let cursor = plan.range.startSample;
  let generation = 0;
  let graph: AudioPreviewScheduledGraph | null = null;
  let originSample = cursor;
  let frameHandle: number | null = null;
  let closing: Promise<void> | null = null;

  const currentSample = (): number => status === 'playing' && graph
    ? Math.min(plan.range.endSample, originSample + Math.max(0, Math.floor((context.currentTime - graph.originTime) * RATE + 1e-6)))
    : cursor;
  const getState = (): AudioPreviewTransportState => {
    const sample = currentSample();
    return { status, sample, frame: Math.floor(sample / FRAME), reason };
  };
  const emit = (): void => { onChange?.(getState()); };
  const cancelPaint = (): void => { if (frameHandle !== null) { cancelFrame?.(frameHandle); frameHandle = null; } };
  const clearGraph = (): void => { const old = graph; graph = null; old?.stop(); cancelPaint(); };
  // Revoke synchronous ownership before starting any asynchronous operation.
  const revoke = (): number => { generation++; clearGraph(); return generation; };
  const paint = (token: number): void => {
    if (!requestFrame || token !== generation || status !== 'playing') return;
    frameHandle = requestFrame(() => {
      if (token !== generation || status !== 'playing') return;
      frameHandle = null;
      emit(); // Display only. Never persist a tick or finish playback here.
      paint(token);
    });
  };
  const unlisten = (): void => { context.removeEventListener('statechange', stateChanged); context.removeEventListener('error', outputFailed); };
  const close = (): Promise<void> => {
    if (closing) return closing;
    unlisten();
    try {
      closing = context.state === 'closed' ? Promise.resolve() : context.close().then(() => {
        if (context.state !== 'closed') throw Object.assign(new Error('Audio context closure was not confirmed.'), { code: 'AUDIO_PREVIEW_CONTEXT_NOT_CLOSED' });
      });
    } catch (error) { closing = Promise.reject(error); }
    return closing;
  };
  const stop = (why: AudioPreviewStopReason = 'explicit-stop'): void => {
    if (status === 'disposed' || status === 'stopped') return;
    cursor = currentSample(); revoke(); reason = why; status = 'stopped';
    buffers.clear(); void close().catch(() => { /* dispose() retains this rejection for the owner's retirement fence. */ }); emit();
  };
  function stateChanged(): void {
    if (status === 'disposed' || status === 'stopped') return;
    if (context.state === 'running') hasRunningClock = true;
    else if (context.state === 'closed') stop('context-closed');
    else if (hasRunningClock || status === 'playing' || status === 'paused') stop('context-suspended');
  }
  function outputFailed(): void { stop('audio-output-failed'); }
  context.addEventListener('statechange', stateChanged);
  context.addEventListener('error', outputFailed);

  const schedule = (token: number): boolean => {
    if (token !== generation || status === 'disposed' || status === 'stopped') return false;
    if (context.state !== 'running') { stop('context-suspended'); return false; }
    originSample = cursor;
    try {
      const next = scheduleTimelineAudioPreviewGraph({ context, plan, buffers, cursorSample: cursor,
        originTime: context.currentTime + AUDIO_PREVIEW_SCHEDULE_LEAD_SECONDS, destination,
        onEnded: () => {
          if (token !== generation || graph !== next || status !== 'playing') return;
          cursor = plan.range.endSample; revoke(); status = 'ended'; reason = null; emit();
        },
      });
      if (token !== generation) { next.stop(); return false; }
      graph = next; status = 'playing'; reason = null; emit();
      if (token !== generation) return false;
      paint(token); return true;
    } catch { if (token === generation) stop('schedule-failed'); return false; }
  };
  const play = async (): Promise<boolean> => {
    if (status === 'disposed' || status === 'stopped') return false;
    if (status === 'playing') return true;
    const token = revoke();
    if (cursor >= plan.range.endSample) cursor = plan.range.startSample;
    status = 'starting'; reason = null; emit();
    if (token !== generation) return false;
    try {
      await context.resume();
      if (token !== generation) return false;
      if (context.state !== 'running') { stop('resume-failed'); return false; }
      hasRunningClock = true;
      return schedule(token);
    } catch { if (token === generation) stop('resume-failed'); return false; }
  };
  const pause = (): void => {
    if (status !== 'playing' && status !== 'starting') return;
    cursor = currentSample(); revoke(); status = 'paused'; reason = null; emit();
  };
  const seek = (frame: number): boolean => {
    if (status === 'disposed' || status === 'stopped') return false;
    if (!Number.isSafeInteger(frame) || frame < plan.range.startFrame || frame > plan.range.endFrame) {
      stop('outside-prepared-interval'); return false;
    }
    const wasPlaying = status === 'playing';
    const token = revoke(); cursor = frame * FRAME; reason = null;
    if (cursor === plan.range.endSample) { status = 'ended'; emit(); return true; }
    status = 'paused';
    if (wasPlaying) return schedule(token);
    emit(); return true;
  };
  const dispose = (): Promise<void> => {
    if (status !== 'disposed') { cursor = currentSample(); revoke(); status = 'disposed'; buffers.clear(); emit(); }
    return close();
  };
  return { play, pause, seek, stop, dispose, getState };
}
