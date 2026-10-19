import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAudioPreviewPlan } from '../packages/contracts/src/timeline-audio-preview.ts';
import { createTimelineAudioPreviewController, timelineAudioPreviewViewState, timelineAudioPreviewSourceIdentity, timelineAudioPreviewPosition, seekTimelineAudioPreview, timelineAudioPreviewErrorMessage } from '../apps/web/src/use-timeline-audio-preview.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ pendingPrepare = null, pendingResume = null, pendingClose = null, pendingResources = null, failClose = false, includeSource = false, overrides = {} } = {}) {
  let context = { scope: 'workspace-a:project-epoch-1', executionScope: 'editing:preview-1', projectId: id(1), timelineId: id(2), revision: 1,
    durationFrames: 900, sourceIdentity: 'saved-clip-and-source-a', connected: true, visible: true, restored: false, hasUnsavedDrafts: false, ...overrides };
  const calls = { prepares: [], contexts: [], transports: [], positions: [], beforePlay: 0, read: 0, changes: [], preparedBuffers: [] };
  const planFor = input => buildAudioPreviewPlan(input, { timeline: { id: id(2), projectId: id(1), revision: 1, fps: 30, durationFrames: 900,
    tracks: [{ id: id(3), kind: 'audio', orderIndex: 0, muted: !includeSource, hidden: false }],
    clips: [{ id: id(5), trackId: id(3), assetId: id(4), startFrame: 0, durationFrames: 900, sourceInFrame: 0, gain: 1 }] },
    assets: [{ id: id(4), projectId: id(1), sha256: 'a'.repeat(64), sizeBytes: 1024, mimeType: 'audio/wav', duration: 30, hasAudio: true }] }, hash);
  const controller = createTimelineAudioPreviewController({
    getContext: () => context, readPlan: async () => { calls.read++; throw Error('Unexpected direct plan request'); },
    createContext: () => { const audio = { sampleRate: 48000, state: 'running', closes: 0, close() { this.closes++; if (failClose) return Promise.reject(Error('Close refused')); if (pendingClose) return pendingClose.promise.then(() => { this.state = 'closed'; }); this.state = 'closed'; return Promise.resolve(); } }; calls.contexts.push(audio); return audio; },
    prepare: async (input, options) => { calls.prepares.push({ input, options }); if (pendingResources) options.onResourceSettlement?.(pendingResources.promise); if (pendingPrepare) await pendingPrepare.promise;
      options.onProgress?.(0, 0); const plan = planFor(input);
      const buffers = new Map(plan.sources.map(source => {
        const channels = [new Float32Array(source.sampleFrames), new Float32Array(source.sampleFrames)];
        return [source.sourceKey, { sampleRate: 48000, length: source.sampleFrames, numberOfChannels: 2, getChannelData: channel => channels[channel] }];
      })); calls.preparedBuffers.push(buffers); return { plan, buffers, allocation: {} }; },
    createTransport: options => {
      let disposed = false, token = 0;
      let state = { status: 'ready', frame: options.plan.range.startFrame, sample: options.plan.range.startSample, reason: null };
      const emit = patch => { state = { ...state, ...patch }; options.onChange(state); };
      const transport = { ticks: 0, seeks: [], stops: 0, playCalls: 0,
        async play() { const attempt = ++token; this.playCalls++; emit({ status: 'starting' }); if (pendingResume) await pendingResume.promise;
          if (disposed || token !== attempt) return false; emit({ status: 'playing' }); return true; },
        pause() { token++; emit({ status: 'paused' }); },
        seek(frame) { token++; this.seeks.push(frame); emit({ frame, sample: frame * 1600, status: frame === options.plan.range.endFrame ? 'ended' : state.status === 'playing' ? 'playing' : 'paused' }); return true; },
        stop() { token++; this.stops++; emit({ status: 'stopped' }); },
        async dispose() { token++; disposed = true; this.stops++; await options.context.close(); },
        getState() { return { ...state }; },
        tick(frame) { this.ticks++; emit({ frame, sample: frame * 1600 }); },
        get disposed() { return disposed; },
      }; calls.transports.push(transport); return transport;
    }, onExplicitPosition: frame => calls.positions.push(frame), onBeforePlay: () => calls.beforePlay++, onChange: state => calls.changes.push(state),
  });
  controller.attach(context);
  return { controller, calls, get context() { return context; }, setContext(patch) { context = { ...context, ...patch }; controller.setContext(context); },
    changeWithoutEffect(patch) { context = { ...context, ...patch }; }, planFor };
}

test('mount and context refresh perform no preparation, RPC, context allocation or autoplay', () => {
  const f = fixture(); f.controller.setContext({ ...f.context }); f.setContext({ hasUnsavedDrafts: true });
  assert.equal(f.calls.prepares.length, 0); assert.equal(f.calls.contexts.length, 0); assert.equal(f.calls.read, 0);
  assert.equal(f.controller.getState().phase, 'idle');
});

test('explicit prepare is complete before play; clock ticks never persist and pause/repeated seek remain local', async () => {
  const f = fixture(); assert.equal(await f.controller.prepare(150), true);
  assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.transports[0].playCalls, 0);
  assert.equal(f.controller.getState().plan.range.endFrame, 750);
  assert.equal(await f.controller.play(), true); assert.equal(f.calls.beforePlay, 1);
  const transport = f.calls.transports[0]; transport.tick(172); transport.tick(188);
  assert.deepEqual(f.calls.positions, []); assert.equal(f.controller.getState().positionFrame, 188);
  f.controller.pause(); assert.equal(f.controller.getState().phase, 'paused');
  for (const frame of [200, 151, 749, 150]) assert.equal(f.controller.seek(frame), true);
  assert.deepEqual(f.calls.positions, [200, 151, 749, 150]); assert.deepEqual(transport.seeks, f.calls.positions);
  assert.equal(await f.controller.play(), true); transport.tick(220); f.controller.stop();
  assert.deepEqual(f.calls.positions, [200, 151, 749, 150, 220]); assert.equal(f.controller.getState().plan, null);
  assert.equal(f.calls.contexts[0].closes, 1); assert.equal(await f.controller.play(), false);
});

test('interval endpoint is explicitly ended, outside seek releases and never expands or silently re-prepares', async () => {
  const f = fixture(); await f.controller.prepare(0);
  assert.equal(f.controller.seek(600), true); assert.equal(f.controller.getState().phase, 'ended');
  assert.equal(f.controller.seek(601), false); assert.equal(f.controller.getState().plan, null);
  assert.equal(f.calls.prepares.length, 1); assert.equal(f.calls.transports[0].disposed, true);
  assert.deepEqual(f.calls.positions, [600, 601]);
});

test('unsaved draft warning never changes draft values, saved input, candidate ownership or admission', async () => {
  const draft = { rawGain: '1.', rawFade: '', unknownOwner: { project: 'old' }, candidate: { gain: 2 }, conflict: true }, before = structuredClone(draft);
  const f = fixture({ overrides: { hasUnsavedDrafts: true } }); await f.controller.prepare(5); await f.controller.play();
  f.setContext({ hasUnsavedDrafts: false }); assert.equal(f.controller.getState().phase, 'playing');
  f.setContext({ hasUnsavedDrafts: true }); f.controller.pause(); f.controller.seek(9); f.controller.revoke();
  assert.deepEqual(draft, before); assert.deepEqual(f.calls.prepares[0].input, { projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 5 });
  assert.equal(f.calls.prepares.length, 1);
});

for (const [name, patch] of Object.entries({ revision: { revision: 2 }, source: { sourceIdentity: 'source-replaced' }, project: { projectId: id(99) },
  workspace: { scope: 'workspace-b' }, navigation: { executionScope: 'editing:preview-2' }, hidden: { visible: false }, logout: { connected: false }, restored: { restored: true } })) {
  test(`${name} revokes playback and late preparation without a persistence write or automatic resume`, async () => {
    const f = fixture(); await f.controller.prepare(0); await f.controller.play(); f.setContext(patch);
    assert.equal(f.calls.transports[0].disposed, true); assert.equal(f.calls.contexts[0].closes, 1); assert.equal(f.controller.getState().plan, null);
    assert.deepEqual(f.calls.positions, []); assert.equal(await f.controller.play(), false);
    const pending = deferred(), late = fixture({ pendingPrepare: pending });
    const work = late.controller.prepare(0); assert.equal(late.calls.contexts.length, 1); late.setContext(patch);
    assert.equal(late.calls.prepares[0].options.signal.aborted, true); pending.resolve(); assert.equal(await work, false);
    assert.equal(late.calls.transports.length, 0); assert.equal(late.calls.contexts[0].closes, 1); assert.equal(late.controller.getState().plan, null);
  });
}

test('cancel and unmount invalidate an ignored late acknowledgment, including A to B to A ownership', async () => {
  for (const action of ['cancel', 'unmount', 'aba']) {
    const pending = deferred(), f = fixture({ pendingPrepare: pending }); const work = f.controller.prepare(0);
    if (action === 'cancel') f.controller.cancel();
    if (action === 'unmount') f.controller.dispose();
    if (action === 'aba') { f.setContext({ scope: 'B' }); f.setContext({ scope: 'workspace-a:project-epoch-1' }); }
    pending.resolve(); assert.equal(await work, false); assert.equal(f.calls.transports.length, 0); assert.equal(f.calls.contexts[0].closes, 1);
    assert.equal(f.calls.prepares[0].options.signal.aborted, true); assert.equal(await f.controller.play(), false);
  }
});

test('native-player revocation and page disposal reject late play acknowledgments', async () => {
  const resume = deferred(), f = fixture({ pendingResume: resume }); await f.controller.prepare(0);
  const work = f.controller.play(); assert.equal(f.controller.getState().phase, 'starting'); f.controller.revoke();
  resume.resolve(); assert.equal(await work, false); assert.equal(f.controller.getState().plan, null); assert.deepEqual(f.calls.positions, []);
  assert.equal(f.calls.transports[0].disposed, true);
});

test('retained handlers and a render before layout cleanup cannot show or play stale saved data', async () => {
  const f = fixture(); await f.controller.prepare(0); const saved = f.controller.getState();
  f.changeWithoutEffect({ sourceIdentity: 'replaced-before-effect' });
  const masked = timelineAudioPreviewViewState(saved, f.context); assert.equal(masked.plan, null); assert.equal(masked.positionFrame, null);
  assert.equal(await f.controller.play(), false); assert.equal(f.calls.transports[0].playCalls, 0); assert.equal(f.calls.transports[0].disposed, true);
});

let rendered;
before(async () => {
  const f = fixture(), values = { idle: f.controller.getState() };
  await f.controller.prepare(300); values.ready = f.controller.getState(); await f.controller.play(); values.playing = f.controller.getState();
  f.controller.pause(); values.paused = f.controller.getState(); f.controller.seek(900); values.ended = f.controller.getState();
  values.draft = { ...values.ready, hasUnsavedDrafts: true };
  values.closing = { ...values.idle, retirement: 'closing' }; values.closeFailed = { ...values.idle, retirement: 'failed' }; values.restored = { ...values.idle, restored: true };
  values.preparing = { ...values.idle, phase: 'preparing', requestedStartFrame: 0, totalSources: 3, preparedSources: 1 };
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixtures = `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server.browser';
    import TimelineAudioPreview from './src/TimelineAudioPreview.tsx';
    const values=${JSON.stringify(values)}; const controller={prepare(){throw Error('render must not prepare')},play(){throw Error('render must not play')},pause(){},seek(){},stop(){},cancel(){}};
    export const html=Object.fromEntries(Object.entries(values).map(([name,state])=>[name,renderToStaticMarkup(<TimelineAudioPreview audioPreview={{state,controller}} startFrame={0}/>)]));`;
  const script = `import {build} from 'esbuild';globalThis.fetch=()=>{throw Error('render may not fetch')};
    const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixtures)},loader:'tsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,jsx:'transform',define:{'process.env.NODE_ENV':'"production"'}});
    const result=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));process.stdout.write(JSON.stringify(result.html));process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('real shared controls render compact exact half-open window, saved revision, sound-only and separate-video labels', () => {
  assert.match(rendered.ready, /data-slot="button"/); assert.match(rendered.ready, /仅声音 · 已保存 修订版 1/);
  assert.match(rendered.ready, /区间 \[00:10:00, 00:30:00\) · 帧 300–900 · 最多 20 秒/);
  assert.match(rendered.ready, /已渲染视频单独播放，不与此声音试听同步/);
  assert.match(rendered.ready, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(rendered.ready, /aria-live="off"/); assert.match(rendered.ready, /flex-wrap:wrap/); assert.match(rendered.ready, /min-width:0/);
  assert.doesNotMatch(rendered.ready, /<video|<audio|role="dialog"/);
});

test('presentation covers explicit prepare/cancel/play/pause/end, warnings and restored failure without whole-timeline completion', () => {
  assert.match(rendered.idle, /准备当前区间/); assert.match(rendered.preparing, /取消准备/); assert.match(rendered.preparing, /声音 1\/3/);
  assert.match(rendered.paused, /继续播放/); assert.match(rendered.paused, /声音已暂停/);
  assert.match(rendered.ended, /本区间已结束；这不代表整条时间线已播放完/);
  assert.match(rendered.ended, /重播本区间/); assert.match(rendered.draft, /尚未保存的编辑不包含在试听中；草稿会保留/);
  assert.match(rendered.restored, /恢复分支暂不支持/);
  assert.match(rendered.restored.match(/<button[^>]*data-testid="timeline-audio-preview-prepare"[^>]*>/)?.[0] ?? '', /disabled/);
});

test('new TS/TSX owns no persistence, durable work, decoder shortcut or autoplay and listens to page hiding', () => {
  for (const name of ['timeline-audio-preview-client.ts', 'use-timeline-audio-preview.ts', 'TimelineAudioPreview.tsx']) {
    const source = readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck|localStorage\.|sessionStorage\.|setInterval\(|\.decodeAudioData\(|\.arrayBuffer\(/);
  }
  const hook = readFileSync(new URL('../apps/web/src/use-timeline-audio-preview.ts', import.meta.url), 'utf8');
  assert.match(hook, /addEventListener\('visibilitychange'/); assert.match(hook, /addEventListener\('pagehide'/);
  const ui = readFileSync(new URL('../apps/web/src/TimelineAudioPreview.tsx', import.meta.url), 'utf8');
  assert.match(ui, /import React from 'react'/); assert.doesNotMatch(ui, /autoPlay|autoFocus/);
});


test('saved source identity excludes drafts/private paths/irrelevant library rows but tracks all sound owners', () => {
  const timeline = { id: id(2), projectId: id(1), revision: 1, fps: 30, durationFrames: 90,
    tracks: [{ id: id(3), kind: 'video', orderIndex: 0, muted: false, hidden: false }],
    clips: [{ id: id(5), trackId: id(3), assetId: id(4), startFrame: 0, durationFrames: 90, sourceInFrame: 0, gain: 1, fadeInFrames: 0, fadeOutFrames: 0 }] };
  const asset = { id: id(4), projectId: id(1), sha256: 'a'.repeat(64), sizeBytes: 10, duration: 3, mimeType: 'video/mp4', hasAudio: true, path: '/private/never-project', url: '/media/old' };
  const identity = timelineAudioPreviewSourceIdentity(timeline, [asset]);
  assert.ok(identity); assert.doesNotMatch(identity, /private|media|path|url/);
  assert.equal(timelineAudioPreviewSourceIdentity(structuredClone(timeline), [{ ...asset, path: 'different', url: 'different' }, { id: id(99), sha256: 'b'.repeat(64) }]), identity);
  assert.equal(timelineAudioPreviewSourceIdentity({ ...timeline, draft: { gain: 2 } }, [asset]), identity);
  for (const patch of [{ sha256: 'b'.repeat(64) }, { hasAudio: false }, { duration: 4 }, { sizeBytes: 12 }, { mimeType: 'audio/wav' }])
    assert.notEqual(timelineAudioPreviewSourceIdentity(timeline, [{ ...asset, ...patch }]), identity);
  assert.notEqual(timelineAudioPreviewSourceIdentity({ ...timeline, revision: 2 }, [asset]), identity);
  assert.notEqual(timelineAudioPreviewSourceIdentity({ ...timeline, tracks: [{ ...timeline.tracks[0], muted: true }] }, [asset]), identity);
  assert.notEqual(timelineAudioPreviewSourceIdentity({ ...timeline, clips: [{ ...timeline.clips[0], fadeInFrames: 1 }] }, [asset]), identity);
  assert.equal(timelineAudioPreviewSourceIdentity({ ...timeline, clips: Array(101).fill(timeline.clips[0]) }, [asset]), '');
});

test('App helpers keep playback ephemeral and route each explicit seek to exactly one owner', async () => {
  const f = fixture(), fallback = [], view = () => ({ state: f.controller.getState(), controller: f.controller });
  assert.equal(timelineAudioPreviewPosition(view(), 99), 99);
  seekTimelineAudioPreview(view(), 12, frame => fallback.push(frame)); assert.deepEqual(fallback, [12]); assert.deepEqual(f.calls.positions, []);
  await f.controller.prepare(0); await f.controller.play(); f.calls.transports[0].tick(44);
  assert.equal(timelineAudioPreviewPosition(view(), 99), 44);
  seekTimelineAudioPreview(view(), 25, frame => fallback.push(frame)); assert.deepEqual(fallback, [12]); assert.deepEqual(f.calls.positions, [25]);
  f.controller.revoke(); assert.equal(timelineAudioPreviewPosition(view(), 99), 99);
});


test('retained UI action bindings cannot prepare or seek a later project owner', async () => {
  const f = fixture(); await f.controller.prepare(0); const old = f.controller.getState();
  f.setContext({ scope: 'project-epoch-2' });
  assert.equal(await f.controller.prepare(5, old), false); assert.equal(await f.controller.play(old), false);
  assert.equal(f.controller.seek(10, old), false); f.controller.stop(old); f.controller.cancel(old); f.controller.pause(old);
  assert.equal(f.calls.prepares.length, 1); assert.deepEqual(f.calls.positions, []);
});


test('deferred context close fences new preparation until exact retirement acknowledgment', async () => {
  const close = deferred(), f = fixture({ pendingClose: close }); await f.controller.prepare(0);
  f.controller.revoke(); assert.equal(await f.controller.prepare(30), false);
  assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.contexts[0].closes, 1);
  f.controller.dispose(); f.controller.attach(f.context);
  assert.equal(await f.controller.prepare(30), false); assert.equal(f.calls.contexts.length, 1);
  close.resolve(); await tick();
  assert.equal(await f.controller.prepare(30), true); assert.equal(f.calls.contexts.length, 2);
});

test('failed context close remains visibly blocked across retries and reattachment', async () => {
  const f = fixture({ failClose: true }); await f.controller.prepare(0); f.controller.revoke(); await tick();
  assert.equal(await f.controller.prepare(30), false); assert.equal(f.controller.getState().retirement, 'failed');
  f.controller.dispose(); f.controller.attach(f.context);
  assert.equal(await f.controller.prepare(30), false); assert.equal(f.calls.contexts.length, 1); assert.equal(f.calls.contexts[0].closes, 1);
});

test('old prepare flight must settle before new context admission and cannot double-close resources', async () => {
  const close = deferred(), prepare = deferred(), f = fixture({ pendingClose: close, pendingPrepare: prepare });
  const first = f.controller.prepare(0); f.controller.cancel();
  const denied = f.controller.prepare(30); await tick(); assert.equal(f.calls.contexts.length, 1); assert.equal(await denied, false);
  close.resolve(); await tick(); assert.equal(await f.controller.prepare(30), false); assert.equal(f.calls.contexts.length, 1);
  prepare.resolve(); assert.equal(await first, false); await tick();
  assert.equal(await f.controller.prepare(30), true);
  assert.equal(f.calls.contexts[0].closes, 1); assert.equal(f.calls.contexts[1].closes, 0); assert.equal(f.controller.getState().plan.range.startFrame, 30);
});


test('client resource settlement is distinct from promptly completed cancellation/timeout', async () => {
  const resources = deferred(), f = fixture({ pendingResources: resources }); await f.controller.prepare(0);
  f.controller.revoke(); await tick(); assert.equal(f.calls.contexts[0].state, 'closed');
  assert.equal(await f.controller.prepare(30), false); assert.equal(f.calls.contexts.length, 1);
  resources.resolve(); await tick(); assert.equal(await f.controller.prepare(30), true); assert.equal(f.calls.contexts.length, 2);
});


test('retirement progress/failure remain visible and disable reprepare; float parity limitation is explicit', () => {
  assert.match(rendered.closing, /正在释放上一次声音资源/); assert.match(rendered.closeFailed, /上一次声音资源未能确认释放/);
  for (const html of [rendered.closing, rendered.closeFailed]) assert.match(html.match(/<button[^>]*data-testid="timeline-audio-preview-prepare"[^>]*>/)?.[0] ?? '', /disabled/);
  assert.match(rendered.ready, /旧版 16 位导出可能在混音中削波/); assert.match(rendered.ready, /float-v2 导出会拒绝超过满幅/);
});


test('known unknown-audio, unsupported, stale and decoder errors state a safe specific reason', () => {
  assert.match(timelineAudioPreviewErrorMessage({ code: 'AUDIO_PREVIEW_AUDIO_UNKNOWN' }), /音频信息尚不明确/);
  assert.match(timelineAudioPreviewErrorMessage({ code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT' }), /暂不支持的音频格式/);
  assert.match(timelineAudioPreviewErrorMessage({ code: 'AUDIO_PREVIEW_STALE' }), /来源已变化/);
  assert.match(timelineAudioPreviewErrorMessage({ code: 'AUDIO_PREVIEW_TRUNCATED_PCM' }), /解码不完整或无效/);
  assert.match(timelineAudioPreviewErrorMessage({ code: 'AUDIO_PREVIEW_BUDGET' }), /原始片段.*解码预算.*已渲染视频预览/);
});

test('closed context during deferred preparation cannot publish a ready interval or construct a transport', async () => {
  const pending = deferred(), f = fixture({ pendingPrepare: pending, includeSource: true }); const work = f.controller.prepare(0);
  await f.calls.contexts[0].close(); pending.resolve();
  assert.equal(await work, false); assert.equal(f.controller.getState().phase, 'error'); assert.equal(f.controller.getState().plan, null);
  assert.equal(f.calls.transports.length, 0); assert.equal(f.calls.contexts[0].closes, 1); assert.equal(f.calls.preparedBuffers[0].size, 0); assert.deepEqual(f.calls.positions, []);
});

test('initially suspended context remains eligible for explicit play after complete preparation', async () => {
  const pending = deferred(), f = fixture({ pendingPrepare: pending }); const work = f.controller.prepare(0);
  f.calls.contexts[0].state = 'suspended'; pending.resolve();
  assert.equal(await work, true); assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.calls.transports.length, 1);
  assert.equal(f.calls.transports[0].playCalls, 0);
});

test('explicit editor seek beyond saved duration stops sound and persists once up to the existing 18000-frame bound', async () => {
  for (const frame of [1200, 18000]) {
    const f = fixture(); await f.controller.prepare(0); await f.controller.play();
    assert.equal(f.controller.seek(frame), false); assert.equal(f.controller.getState().plan, null);
    assert.equal(f.calls.transports[0].disposed, true); assert.deepEqual(f.calls.positions, [frame]); assert.equal(f.calls.prepares.length, 1);
  }
});

test('out-of-editor bounds and stale owners still cannot change the saved playhead', async () => {
  const f = fixture(); await f.controller.prepare(0); await f.controller.play(); const old = f.controller.getState();
  for (const frame of [-1, 18001, 1200.5, NaN]) assert.equal(f.controller.seek(frame), false);
  assert.equal(f.controller.getState().phase, 'playing'); assert.deepEqual(f.calls.positions, []);
  f.setContext({ scope: 'new-project-epoch' }); assert.equal(f.controller.seek(1200, old), false); assert.deepEqual(f.calls.positions, []);
});
