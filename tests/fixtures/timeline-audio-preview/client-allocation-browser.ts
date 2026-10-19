import { AUDIO_PREVIEW_LIMITS, audioPreviewPlanSchema, buildAudioPreviewPlan, type AudioPreviewSnapshot, type AudioPreviewPlan, type AudioPreviewPlanInput } from '../../../packages/contracts/src/timeline-audio-preview.ts';
import { createTimelineAudioPreviewClient, AUDIO_PREVIEW_PCM_ENDPOINT, AUDIO_PREVIEW_PCM_HEADERS, AUDIO_PREVIEW_MAX_CHUNK_BYTES,
  type AudioPreviewAllocation, type PreparedAudioPreview } from '../../../apps/web/src/timeline-audio-preview-client.ts';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface AllocationCaseReport {
  name: string;
  passed: true;
  sourceRequests: number;
  distinctSources: number;
  voices: number;
  peakConcurrentRequests: number;
  actualAudioBufferAllocations: number;
  actualAudioBufferPayloadBytes: number;
  finiteSamplesChecked: number;
  maximumTransportChunkBytes: number;
  conservativeApplicationPeakBytes: number;
  admittedBytes: number;
  contextClosed: true;
  nativeHttp?: { routePattern: '/capacity-pcm/0..4'; responseBodies: number; byobReaders: number; byobReadCalls: number;
    maximumRequestedViewBytes: number; maximumReturnedViewBytes: number; maximumRequestedBackingBytes: number; maximumReturnedBackingBytes: number; deliveredBytes: number; sharedServerPayloadBytes: 7680000 };
}
export interface ClientAllocationBrowserReport {
  name: 'real-browser-client-audiobuffer-allocation';
  passed: true;
  note: string;
  checks: AllocationCaseReport[];
  exactSourceDeduplicationChecked: true;
  nearCapacityAdmissionChecked: true;
  nativeHttpNearCapacityChecked: true;
  overBudgetRejection: { sources: 6; code: 'AUDIO_PREVIEW_MEMORY_LIMIT'; conservativeRequestedBytes: number; sourceRequests: 0; audioBufferAllocations: 0 };
}


const capacityId = (value: number): string => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function capacitySnapshot(sources: number): { input: AudioPreviewPlanInput; snapshot: AudioPreviewSnapshot } {
  const input = { projectId: capacityId(1), timelineId: capacityId(2), expectedRevision: 1, startFrame: 0 };
  return { input, snapshot: {
    timeline: { id: input.timelineId, projectId: input.projectId, revision: 1, fps: 30, durationFrames: 600,
      tracks: Array.from({ length: sources }, (_, index) => ({ id: capacityId(10 + index), kind: 'audio' as const, orderIndex: index, hidden: false, muted: false })),
      clips: Array.from({ length: sources }, (_, index) => ({ id: capacityId(30 + index), trackId: capacityId(10 + index), assetId: capacityId(3),
        startFrame: 0, durationFrames: 600, sourceInFrame: index * 600, gain: 0.2, fadeInFrames: 0, fadeOutFrames: 0 })),
    },
    assets: [{ id: capacityId(3), projectId: input.projectId, sha256: 'c'.repeat(64), sizeBytes: 120 * 48000 * 8 + 44, mimeType: 'audio/wav', duration: 120, hasAudio: true }],
  } };
}
/** The pure planner requires a synchronous SHA-256 adapter. Cache actual Web
 * Crypto digests, rerunning only its pure bounded calculation when a new hash
 * input is discovered. No decoder/file reads/allocations occur in this loop. */
async function browserPlan(input: AudioPreviewPlanInput, snapshot: AudioPreviewSnapshot): Promise<AudioPreviewPlan> {
  const digests = new Map<string, string>(), missing = Symbol('missing browser digest');
  for (let attempt = 0; attempt < 10; attempt++) {
    let needed: string | null = null;
    try { return buildAudioPreviewPlan(input, snapshot, text => {
      const found = digests.get(text); if (found !== undefined) return found;
      needed = text; throw missing;
    }); }
    catch (error) {
      if (error !== missing) throw error;
      assert(needed !== null, 'Planner digest request was absent');
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(needed));
      digests.set(needed, Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join(''));
    }
  }
  throw new Error('Bounded capacity planner exceeded its digest steps');
}

async function nearCapacityCheck(): Promise<{ admitted: AllocationCaseReport; rejected: ClientAllocationBrowserReport['overBudgetRejection'] }> {
  const five = capacitySnapshot(5), plan = await browserPlan(five.input, five.snapshot);
  assert(plan.sources.length === 5 && plan.sources.every(source => source.sampleFrames === 960000), 'Near-capacity plan is not five complete 20 second sources');
  assert(plan.memory.admittedBytes === 94_257_152, 'Near-capacity admission arithmetic changed');
  const context = new AudioContext({ sampleRate: 48000 });
  let result: PreparedAudioPreview | null = null, resources: Promise<void> | null = null;
  let actualBytes = 0, allocationCount = 0, requests = 0, active = 0, peakConcurrent = 0, completed = 0, maximumChunk = 0, peakBytes = 0;
  let responseBodies = 0, byobReaders = 0, byobReadCalls = 0, maximumRequestedViewBytes = 0, maximumReturnedViewBytes = 0, maximumRequestedBackingBytes = 0, maximumReturnedBackingBytes = 0, deliveredBytes = 0;
  try {
    assert(context.sampleRate === 48000, 'Near-capacity context is not actual 48 kHz');
    const client = createTimelineAudioPreviewClient({ readPlan: async () => structuredClone(plan), fetcher: async (resource, options) => {
      assert(typeof resource === 'string', 'Near-capacity client source URL is not fixed');
      const url = new URL(resource, location.origin), source = plan.sources.find(value => value.clipId === url.searchParams.get('clipId'));
      assert(source && url.pathname === AUDIO_PREVIEW_PCM_ENDPOINT && url.origin === location.origin &&
        url.searchParams.get('planHash') === plan.planHash && url.searchParams.get('sourceHash') === source.sourceHash &&
        url.searchParams.get('projectId') === plan.projectId && url.searchParams.get('timelineId') === plan.timelineId &&
        url.searchParams.get('expectedRevision') === '1' && url.searchParams.get('startFrame') === '0' && [...url.searchParams.keys()].length === 7,
      'Near-capacity source input lost exact plan ownership');
      assert(options?.cache === 'no-store' && options.credentials === 'same-origin' && options.redirect === 'error', 'Near-capacity client transport settings changed');
      requests++; active++; peakConcurrent = Math.max(peakConcurrent, active);
      const sourceIndex = plan.sources.indexOf(source), route = `/capacity-pcm/${sourceIndex}`;
      assert(sourceIndex >= 0 && sourceIndex < 5, 'Near-capacity source escaped fixed HTTP routes');
      // Preserve the actual native Fetch byte stream and server-supplied
      // identity headers. There is no synthetic stream or Response wrapper.
      const response = await fetch(route, options);
      assert(response.ok && response.body && response.url === new URL(route, location.origin).href && response.type === 'basic', 'Near-capacity response is not real same-origin HTTP');
      assert(response.headers.get('X-Mioon-Test-Fixture') === 'fixed-capacity-http-v1' &&
        response.headers.get('X-Mioon-Test-Source-Allocation-Bytes') === '7680000', 'Near-capacity server did not use the fixed shared payload');
      responseBodies++;
      // Observe the native reader without replacing its byte stream, copying
      // a payload, or choosing network delivery chunk sizes on the client.
      const nativeBody = response.body, nativeGetReader = nativeBody.getReader.bind(nativeBody);
      Object.defineProperty(nativeBody, 'getReader', { configurable: true, value(readerOptions?: ReadableStreamGetReaderOptions) {
        assert(readerOptions?.mode === 'byob', 'Actual client did not request a bounded native BYOB reader'); byobReaders++;
        const reader = nativeGetReader({ mode: 'byob' }), nativeRead = reader.read.bind(reader);
        Object.defineProperty(reader, 'read', { configurable: true, value(view: Uint8Array<ArrayBuffer>, readOptions?: { min?: number }) {
          const requestedBytes = view.byteLength;
          assert(view instanceof Uint8Array && requestedBytes > 0 && requestedBytes <= AUDIO_PREVIEW_MAX_CHUNK_BYTES && view.buffer.byteLength <= AUDIO_PREVIEW_MAX_CHUNK_BYTES, 'Actual client supplied an unbounded BYOB view');
          byobReadCalls++; maximumRequestedViewBytes = Math.max(maximumRequestedViewBytes, requestedBytes);
          maximumRequestedBackingBytes = Math.max(maximumRequestedBackingBytes, view.buffer.byteLength);
          return nativeRead(view, readOptions).then(result => {
            const returnedBytes = result.value?.byteLength ?? 0;
            assert(returnedBytes <= requestedBytes && returnedBytes <= AUDIO_PREVIEW_MAX_CHUNK_BYTES && (result.value?.buffer.byteLength ?? 0) <= AUDIO_PREVIEW_MAX_CHUNK_BYTES, 'Native BYOB delivery exceeded the caller-owned view');
            maximumReturnedViewBytes = Math.max(maximumReturnedViewBytes, returnedBytes);
            maximumReturnedBackingBytes = Math.max(maximumReturnedBackingBytes, result.value?.buffer.byteLength ?? 0); deliveredBytes += returnedBytes;
            return result;
          });
        } });
        return reader;
      } });
      return response;
    } });
    result = await client.prepare(five.input, { signal: new AbortController().signal,
      context: { sampleRate: context.sampleRate, createBuffer(channels, frames, rate) {
        assert(channels === 2 && frames === 960000 && rate === 48000, 'Near-capacity AudioBuffer shape changed');
        const bytes = channels * frames * 4; assert(actualBytes + bytes <= plan.memory.retainedPcmBytes, 'Near-capacity native allocation exceeded admission');
        const buffer = context.createBuffer(channels, frames, rate); actualBytes += bytes; allocationCount++; return buffer;
      } }, onResourceSettlement: value => { resources = value; },
      onAllocation: value => { maximumChunk = Math.max(maximumChunk, value.transportChunkBytes); peakBytes = Math.max(peakBytes, value.conservativeBytes); },
      onProgress: count => { if (count > completed) { active -= count - completed; completed = count; } },
    });
    await resources;
    assert(requests === 5 && allocationCount === 5 && active === 0 && peakConcurrent === 1 && actualBytes === 38_400_000, 'Near-capacity preparation was not exact, serial and complete');
    assert(peakBytes === plan.memory.admittedBytes && peakBytes < AUDIO_PREVIEW_LIMITS.memoryBytes && maximumChunk <= AUDIO_PREVIEW_MAX_CHUNK_BYTES, 'Near-capacity measured application counts exceeded admission');
    assert(responseBodies === 5 && byobReaders === 5 && byobReadCalls >= 5 && deliveredBytes === 38_400_000 &&
      maximumRequestedViewBytes <= AUDIO_PREVIEW_MAX_CHUNK_BYTES && maximumReturnedViewBytes === maximumChunk && maximumChunk > 0,
    'Near-capacity preparation was not fully consumed through bounded native HTTP BYOB readers');
    for (const buffer of result.buffers.values()) {
      assert(buffer.length === 960000 && buffer.getChannelData(0)[0] === .125 && buffer.getChannelData(1)[buffer.length - 1] === -.25, 'Near-capacity source samples/count changed');
    }
    result.buffers.clear(); result = null; await context.close(); assert(context.state === 'closed', 'Near-capacity context failed exact closure');
  } finally { result?.buffers.clear(); if (context.state !== 'closed') await context.close(); await resources; }

  const six = capacitySnapshot(6), rejectedContext = new AudioContext({ sampleRate: 48000 });
  let rejectedBuffers = 0, rejectedRequests = 0, observedCode = '';
  try {
    const rejectedClient = createTimelineAudioPreviewClient({ readPlan: () => browserPlan(six.input, six.snapshot), fetcher: async () => {
      rejectedRequests++; throw new Error('Over-budget plan must not fetch PCM');
    } });
    try { await rejectedClient.prepare(six.input, { signal: new AbortController().signal, context: { sampleRate: rejectedContext.sampleRate,
      createBuffer(channels, frames, rate) { rejectedBuffers++; return rejectedContext.createBuffer(channels, frames, rate); } } }); }
    catch (error) { if (object(error) && typeof error.code === 'string') observedCode = error.code; else throw error; }
    assert(observedCode === 'AUDIO_PREVIEW_MEMORY_LIMIT' && rejectedBuffers === 0 && rejectedRequests === 0, 'Six-source capacity rejection did not precede every PCM allocation/request');
  } finally { await rejectedContext.close(); assert(rejectedContext.state === 'closed', 'Rejected-capacity context failed exact closure'); }
  return { admitted: { name: 'real-http-near-capacity-five-distinct-20-second-source-intervals', passed: true, sourceRequests: requests, distinctSources: 5, voices: 5,
    peakConcurrentRequests: peakConcurrent, actualAudioBufferAllocations: allocationCount, actualAudioBufferPayloadBytes: actualBytes,
    finiteSamplesChecked: 5 * 960000 * 2, maximumTransportChunkBytes: maximumChunk, conservativeApplicationPeakBytes: peakBytes, admittedBytes: plan.memory.admittedBytes, contextClosed: true,
    nativeHttp: { routePattern: '/capacity-pcm/0..4', responseBodies, byobReaders, byobReadCalls, maximumRequestedViewBytes, maximumReturnedViewBytes, maximumRequestedBackingBytes, maximumReturnedBackingBytes, deliveredBytes, sharedServerPayloadBytes: 7_680_000 } },
    rejected: { sources: 6, code: 'AUDIO_PREVIEW_MEMORY_LIMIT', conservativeRequestedBytes: 2 * (6 * 7_680_000) + 2 * 7_680_000 + 2 * 1024 * 1024, sourceRequests: 0, audioBufferAllocations: 0 } };
}

/** Test-only source adapter around the actual production client. It streams
 * served fixed synthetic f32 files unchanged and supplies the production
 * identity headers; this does not claim the production HTTP endpoint was used. */
export async function runClientAllocationCheck(manifest: unknown): Promise<ClientAllocationBrowserReport> {
  assert(object(manifest) && Array.isArray(manifest.cases) && manifest.cases.length > 0 && manifest.cases.length <= 10, 'Invalid bounded numeric fixture manifest');
  const checks: AllocationCaseReport[] = []; let dedupChecked = false;
  for (const item of manifest.cases) {
    assert(object(item) && typeof item.name === 'string' && item.name.length < 200, 'Invalid numeric case');
    const plan: AudioPreviewPlan = audioPreviewPlanSchema.parse(item.plan);
    const context = new AudioContext({ sampleRate: 48000 });
    assert(context.sampleRate === 48000, 'Actual browser client context did not provide 48 kHz');
    const allocations: Array<{ channels: number; frames: number; rate: number; bytes: number }> = [];
    const observations: AudioPreviewAllocation[] = [];
    let result: PreparedAudioPreview | null = null, resources: Promise<void> | null = null;
    let requests = 0, active = 0, peakConcurrent = 0, completed = 0, planRead = false;
    const allocationContext = {
      sampleRate: context.sampleRate,
      createBuffer(channels: number, frames: number, rate: number): AudioBuffer {
        assert(planRead && channels === 2 && rate === 48000, 'Allocation preceded admitted plan or changed profile');
        const bytes = channels * frames * 4;
        assert(allocations.reduce((total, entry) => total + entry.bytes, 0) + bytes <= plan.memory.retainedPcmBytes, 'Actual source allocations exceed retained admission');
        const buffer = context.createBuffer(channels, frames, rate);
        assert(buffer.numberOfChannels === channels && buffer.length === frames && buffer.sampleRate === rate, 'Real AudioBuffer metadata differs from request');
        allocations.push({ channels, frames, rate, bytes }); return buffer;
      },
    };
    const input = { projectId: plan.projectId, timelineId: plan.timelineId, expectedRevision: plan.timelineRevision, startFrame: plan.range.startFrame };
    const client = createTimelineAudioPreviewClient({
      readPlan: async requested => {
        assert(JSON.stringify(requested) === JSON.stringify(input), 'Actual client plan input changed');
        planRead = true; return structuredClone(plan);
      },
      fetcher: async (resource, options) => {
        assert(typeof resource === 'string', 'Client did not use its fixed string resource');
        const url = new URL(resource, location.origin), keys = [...url.searchParams.keys()];
        assert(url.origin === location.origin && url.pathname === AUDIO_PREVIEW_PCM_ENDPOINT && keys.length === 7 && new Set(keys).size === 7, 'Client changed fixed source resource or query shape');
        assert(url.searchParams.get('projectId') === input.projectId && url.searchParams.get('timelineId') === input.timelineId &&
          url.searchParams.get('expectedRevision') === String(input.expectedRevision) && url.searchParams.get('startFrame') === String(input.startFrame) &&
          url.searchParams.get('planHash') === plan.planHash, 'Client source request lost its admitted plan identity');
        const source = plan.sources.find(source => source.clipId === url.searchParams.get('clipId') && source.sourceHash === url.searchParams.get('sourceHash'));
        assert(source && /^[a-f0-9]{64}$/u.test(source.sourceKey), 'Client source request is not a fixed fixture descriptor');
        assert(options?.method === 'GET' && options.credentials === 'same-origin' && options.cache === 'no-store' && options.redirect === 'error', 'Client source transport policy changed');
        requests++; active++; peakConcurrent = Math.max(peakConcurrent, active);
        const response = await fetch(`${source.sourceKey}.f32`, { signal: options.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        assert(response.ok && response.body, 'Synthetic source file is unavailable');
        // The fixture's file server does not expose the application PCM route.
        // Header injection is explicit; the actual bytes remain a network stream.
        return new Response(response.body, { status: 200, headers: {
          'Content-Type': 'application/octet-stream', 'Content-Length': String(source.pcmBytes), 'Cache-Control': 'no-store',
          [AUDIO_PREVIEW_PCM_HEADERS.profile]: plan.profileId, [AUDIO_PREVIEW_PCM_HEADERS.planHash]: plan.planHash,
          [AUDIO_PREVIEW_PCM_HEADERS.sourceHash]: source.sourceHash, [AUDIO_PREVIEW_PCM_HEADERS.clipId]: source.clipId,
          [AUDIO_PREVIEW_PCM_HEADERS.sampleFrames]: String(source.sampleFrames),
        } });
      },
    });
    let finiteSamplesChecked = 0;
    try {
      result = await client.prepare(input, { context: allocationContext, signal: new AbortController().signal,
        onAllocation: value => observations.push(value), onResourceSettlement: value => { resources = value; },
        onProgress: prepared => { if (prepared > completed) { active -= prepared - completed; completed = prepared; } },
      });
      await resources;
      assert(result.plan.planHash === plan.planHash && result.buffers.size === plan.sources.length, 'Prepared result does not match the complete admitted plan');
      assert(requests === plan.sources.length && allocations.length === plan.sources.length && active === 0 && peakConcurrent <= 1, 'Preparation did not remain serial/exactly deduplicated');
      for (const source of plan.sources) {
        const buffer = result.buffers.get(source.sourceKey);
        assert(buffer && buffer.length === source.sampleFrames && buffer.numberOfChannels === 2 && buffer.sampleRate === 48000, 'Prepared browser buffer sample identity failed');
        for (let channel = 0; channel < 2; channel++) for (const sample of buffer.getChannelData(channel)) { assert(Number.isFinite(sample), 'Nonfinite sample survived actual client validation'); finiteSamplesChecked++; }
      }
      const actualBytes = allocations.reduce((total, value) => total + value.bytes, 0);
      const maximumChunk = Math.max(0, ...observations.map(value => value.transportChunkBytes));
      const peakBytes = Math.max(result.allocation.conservativeBytes, ...observations.map(value => value.conservativeBytes));
      assert(actualBytes === plan.memory.retainedPcmBytes && result.allocation.retainedAudioBufferBytes === actualBytes, 'Actual payload allocations disagree with admission');
      assert(maximumChunk <= AUDIO_PREVIEW_MAX_CHUNK_BYTES && peakBytes === plan.memory.admittedBytes && peakBytes <= AUDIO_PREVIEW_LIMITS.memoryBytes, 'Observed application-owned allocation estimate exceeds admission');
      if (plan.voices.length > plan.sources.length) { assert(requests < plan.voices.length && allocations.length < plan.voices.length, 'Repeated voices did not share the exact prepared source'); dedupChecked = true; }
      result.buffers.clear(); result = null; await context.close(); assert(context.state === 'closed', 'Actual client AudioContext close is unconfirmed');
      checks.push({ name: item.name, passed: true, sourceRequests: requests, distinctSources: plan.sources.length, voices: plan.voices.length,
        peakConcurrentRequests: peakConcurrent, actualAudioBufferAllocations: allocations.length, actualAudioBufferPayloadBytes: actualBytes,
        finiteSamplesChecked, maximumTransportChunkBytes: maximumChunk, conservativeApplicationPeakBytes: peakBytes, admittedBytes: plan.memory.admittedBytes, contextClosed: true });
    } finally {
      result?.buffers.clear();
      if (context.state !== 'closed') await context.close();
      await resources;
    }
  }
  assert(dedupChecked, 'Fixture manifest did not exercise identical prepared source deduplication');
  const capacity = await nearCapacityCheck(); checks.push(capacity.admitted);
  return { name: 'real-browser-client-audiobuffer-allocation', passed: true, checks, exactSourceDeduplicationChecked: true, nearCapacityAdmissionChecked: true, nativeHttpNearCapacityChecked: true, overBudgetRejection: capacity.rejected,
    note: 'Actual production client, network-streamed fixed synthetic f32 files, and real browser AudioBuffer allocations. Test-only adapter supplies identity headers; this is not a production HTTP-route test. Near-capacity five-source check uses real native HTTP Fetch and observed bounded BYOB readers, with server-supplied identity headers and one shared 7.68 MB synthetic constant payload across five fixed routes. The real strict six-source planner rejects before PCM allocation/fetch. Report counts application-owned PCM payload and conservative copy/transport reservation, not Chromium/native/OS RSS. No playback or listening claim.' };
}
