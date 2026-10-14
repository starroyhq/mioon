import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createNativeAudioPreviewAuthority} from '../packages/business/src/native-audio-preview.ts';
import {createTimelineAudioPreviewServices} from '../packages/business/src/timeline-audio-preview.ts';
import {createTimelineAudioPreviewHttp} from '../apps/server/src/timeline-audio-preview-http.ts';
import {NATIVE_AUDIO_PCM_PATH, NATIVE_AUDIO_PROOF_HEADER, NATIVE_AUDIO_SIGNATURE_HEADER,
  nativeAudioProofMaterial, nativeAudioSourceQuery} from '@mioon/contracts/native-audio-preview';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const sha = value => createHash('sha256').update(value).digest('hex');
class Request extends EventEmitter {
  constructor(url, headers = {}) {super(); this.method = 'GET'; this.url = url.pathname + url.search; this.headers = headers;}
}
// A destroy request is deliberately not close proof. These tests release each
// child/work/transport gate independently, rather than relying on clock delays.
class Response extends EventEmitter {
  constructor() {super(); this.destroyed = false; this.writableEnded = false; this.writableFinished = false;
    this.headersSent = false; this.headers = {}; this.destroyCalls = 0; this.written = deferred();}
  setHeader(name, value) {this.headers[name.toLowerCase()] = value;}
  writeHead(status, headers) {this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers);}
  end(body) {this.body = body; this.writableEnded = true; this.written.resolve();}
  destroy() {this.destroyed = true; this.destroyCalls++; return this;}
  close() {this.destroyed = true; this.emit('close');}
  finish() {this.writableFinished = true; this.emit('finish');}
}
function credentials() {
  const keys = generateKeyPairSync('ed25519');
  return {...keys, config: {version: 1, backendId: randomUUID(), publicKey: keys.publicKey.export({format: 'der', type: 'spki'}).toString('hex')}};
}
async function fixture(t, overrides = {}, {twoSources = false} = {}) {
  const keys = credentials(), db = new DatabaseSync(':memory:');
  const projectId = randomUUID(), timelineId = randomUUID(), trackId = randomUUID(), assetId = randomUUID(), clipId = randomUUID();
  const input = {projectId, timelineId, expectedRevision: 1, startFrame: 0};
  const snapshot = {timeline: {id: timelineId, projectId, revision: 1, fps: 30, durationFrames: twoSources ? 4 : 2,
    tracks: [{id: trackId, kind: 'audio', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: clipId, trackId, assetId, startFrame: 0, durationFrames: 2, sourceInFrame: 0, gain: 1},
      ...(twoSources ? [{id: randomUUID(), trackId, assetId, startFrame: 2, durationFrames: 2, sourceInFrame: 2, gain: 1}] : [])]},
  assets: [{id: assetId, projectId, sha256: sha('owned native source'), sizeBytes: 1024,
    mimeType: 'audio/wav', duration: 1, hasAudio: true, relativePath: 'synthetic.wav'}]};
  const identity = {dev: 1, ino: 2, size: 1024, mtimeMs: 3, ctimeMs: 4}, effects = [], terminated = [];
  const runtime = {assertOrdinaryWorkspace() {}, ownsLock: () => true, readSavedTimeline: () => snapshot,
    validateSource: () => {effects.push('validate'); return {file: '/owned/synthetic.wav', info: identity};},
    hash: async (_root, asset, options) => {effects.push('hash'); options.beforeEffect(); options.onBytes(asset.sizeBytes);
      return {file: '/owned/synthetic.wav', info: identity, sha256: asset.sha256, sizeBytes: asset.sizeBytes};},
    decode: async (_file, request, options) => {effects.push('decode'); options.beforeEffect(); return {
      pcm: Buffer.alloc(request.frameCount * 1600 * 8), sampleRate: 48000, channels: 2, sampleFrames: request.frameCount * 1600,
      source: {sizeBytes: 1024, durationSeconds: 1}};},
    terminate: async signal => {terminated.push(signal); return [];}, waitForClose: async () => [], boundedShutdown: work => work,
    ...overrides};
  const audio = createTimelineAudioPreviewServices({db, root: '/owned'}, {runtime});
  const authority = createNativeAudioPreviewAuthority(keys.config); authority.bind(audio);
  const plan = await audio.handlers['timeline.audioPreview.plan'](input);
  const owner = {backendId: keys.config.backendId, windowId: randomUUID(), contextId: randomUUID(), projectId};
  const lease = {owner, actionId: randomUUID(), leaseId: randomUUID(), input, planHash: plan.planHash};
  const command = (type, value = lease) => ({type: `native-audio:${type}`, version: 1, requestId: randomUUID(),
    ...(type === 'reserve' ? value : {owner: value.owner, actionId: value.actionId, leaseId: value.leaseId})});
  const sourceInput = index => ({...input, clipId: plan.sources[index].clipId, sourceHash: plan.sources[index].sourceHash, planHash: plan.planHash});
  const responses = [];
  const request = (index = 0, {sequence = index + 1, proof: extra = {}, input: selected = sourceInput(index), key = keys.privateKey, headers = {}, url: customUrl} = {}) => {
    const proof = {version: 1, backendId: keys.config.backendId, leaseId: lease.leaseId, sequence, input: selected, ...extra};
    const url = customUrl ?? new URL(`http://127.0.0.1${NATIVE_AUDIO_PCM_PATH}?${nativeAudioSourceQuery(selected)}`);
    const req = new Request(url, {[NATIVE_AUDIO_PROOF_HEADER.toLowerCase()]: Buffer.from(JSON.stringify(proof)).toString('base64url'),
      [NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase()]: sign(null, Buffer.from(nativeAudioProofMaterial(proof)), key).toString('hex'), ...headers});
    const res = new Response(); responses.push(res); return {req, res, url, input: selected};
  };
  const handler = createTimelineAudioPreviewHttp({service: audio, nativeAdmission: authority, assertAvailable() {}});
  t.after(async () => {for (const res of responses) res.close(); await audio.drain().catch(() => {}); db.close();});
  return {keys, audio, authority, plan, input, snapshot, lease, owner, command, effects, runtime, terminated, sourceInput, request,
    reserve: value => authority.command(command('reserve', value)), retire: value => authority.command(command('retire', value)),
    start(index = 0, options) {const call = request(index, options); return {...call, work: handler(call.req, call.res, call.url)};}};
}

test('native authority accepts only fixed public Ed25519 SPKI configuration', () => {
  const keys = credentials(); assert.doesNotThrow(() => createNativeAudioPreviewAuthority(keys.config));
  for (const publicKey of [keys.privateKey.export({format: 'der', type: 'pkcs8'}).toString('hex'), 'ab'.repeat(44), keys.config.publicKey.toUpperCase()])
    assert.throws(() => createNativeAudioPreviewAuthority({...keys.config, publicKey}));
  assert.throws(() => createNativeAudioPreviewAuthority({...keys.config, privateKey: 'secret'}));
});

test('native mode denies unsigned, forged, stale-epoch and noncanonical PCM before any source effects', async t => {
  const f = await fixture(t); assert.equal((await f.reserve()).status, 'reserved');
  const variants = [
    {headers: {[NATIVE_AUDIO_PROOF_HEADER.toLowerCase()]: undefined}},
    {headers: {[NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase()]: undefined}},
    {key: credentials().privateKey},
    {proof: {backendId: randomUUID()}},
    {proof: {leaseId: randomUUID()}},
    {input: {...f.sourceInput(0), projectId: randomUUID()}},
    {input: {...f.sourceInput(0), planHash: 'a'.repeat(64)}},
    {input: {...f.sourceInput(0), clipId: randomUUID()}},
    {sequence: 2},
    {url: new URL(`http://127.0.0.1${NATIVE_AUDIO_PCM_PATH}?${nativeAudioSourceQuery(f.sourceInput(0))}&extra=1`)},
    {url: new URL(`http://127.0.0.1${NATIVE_AUDIO_PCM_PATH}?${nativeAudioSourceQuery(f.sourceInput(0)).split('&').reverse().join('&')}`)},
  ];
  for (const options of variants) {
    const call = f.start(0, options); await call.work;
    assert.notEqual(call.res.statusCode, 200); assert.deepEqual(f.effects, []);
  }
  const call = f.start(); await call.res.written.promise; assert.equal(call.res.statusCode, 200);
  call.res.finish(); await call.work; assert.ok(f.effects.includes('decode')); assert.equal((await f.retire()).status, 'retired');
});

test('reserve identity and current plan are bound; one lease and each source stay serial and one-use', async t => {
  const f = await fixture(t, {}, {twoSources: true});
  assert.equal((await f.reserve({...f.lease, owner: {...f.owner, projectId: randomUUID()}})).status, 'rejected');
  assert.equal((await f.reserve({...f.lease, planHash: 'a'.repeat(64)})).status, 'rejected');
  const reserved = await f.reserve(); assert.equal(reserved.status, 'reserved'); assert.equal(reserved.admittedBytes, f.plan.memory.admittedBytes);
  assert.equal((await f.reserve()).status, 'reserved');
  assert.equal((await f.reserve({...f.lease, leaseId: randomUUID(), actionId: randomUUID()})).code, 'BUSY');
  assert.equal((await f.retire({...f.lease, owner: {...f.owner, windowId: randomUUID()}})).code, 'STALE');
  const first = f.start(); await first.res.written.promise;
  const early = f.start(1); await early.work; assert.notEqual(early.res.statusCode, 200);
  first.res.finish(); await first.work; await tick();
  const replay = f.start(); await replay.work; assert.notEqual(replay.res.statusCode, 200);
  const duplicate = f.start(0, {sequence: 2}); await duplicate.work; assert.notEqual(duplicate.res.statusCode, 200);
  const second = f.start(1); await second.res.written.promise; assert.equal(second.res.statusCode, 200);
  second.res.finish(); await second.work; await tick(); assert.equal((await f.retire()).status, 'retired');
  const next = {...f.lease, leaseId: randomUUID(), actionId: randomUUID()}; assert.equal((await f.reserve(next)).status, 'reserved');
  assert.equal((await f.retire()).code, 'STALE'); assert.equal((await f.reserve(next)).status, 'reserved');
  assert.equal((await f.retire(next)).status, 'retired');
});

test('retire fences immediately and waits for both noncooperative source work and actual exact response close', async t => {
  const hashEntered = deferred(), releaseHash = deferred(), terminateEntered = deferred(), releaseChild = deferred();
  let originalHash, exactSignal;
  const f = await fixture(t, {hash: async (...args) => {exactSignal = args[2].signal; hashEntered.resolve(); await releaseHash.promise; return originalHash(...args);},
    terminate: async signal => {assert.equal(signal, exactSignal); terminateEntered.resolve(); await releaseChild.promise; return [{status: 'exited'}];}});
  originalHash = async (_root, asset, options) => {options.beforeEffect(); options.onBytes(asset.sizeBytes);
    return {file: '/owned/synthetic.wav', info: {dev: 1, ino: 2, size: 1024, mtimeMs: 3, ctimeMs: 4}, sha256: asset.sha256, sizeBytes: asset.sizeBytes};};
  await f.reserve(); const call = f.start(); await hashEntered.promise;
  let retired = false; const retirement = f.retire().then(reply => {retired = true; return reply;});
  assert.equal(exactSignal.aborted, true); assert.ok(call.res.destroyCalls >= 1);
  await call.work; await tick(); assert.equal(retired, false, 'Public HTTP cancellation is not work/child cleanup proof');
  const newOwner = {...f.lease, leaseId: randomUUID(), actionId: randomUUID()}; assert.equal((await f.reserve(newOwner)).code, 'BUSY');
  call.res.close(); await tick(); assert.equal(retired, false, 'Response closure alone cannot release source work');
  releaseHash.resolve(); await terminateEntered.promise; await tick(); assert.equal(retired, false, 'Child cleanup must also finish');
  releaseChild.resolve(); assert.equal((await retirement).status, 'retired');
  assert.equal((await f.reserve(newOwner)).status, 'reserved'); assert.equal((await f.retire(newOwner)).status, 'retired');
});

test('retire during PCM consumption waits for finish/close, never destroy return or observer cancellation', async t => {
  const f = await fixture(t); await f.reserve(); const call = f.start(); await call.res.written.promise;
  let done = false; const retirement = f.retire().then(value => {done = true; return value;});
  await call.work; await tick(); assert.equal(done, false); assert.ok(call.res.destroyCalls >= 1);
  assert.equal((await f.reserve({...f.lease, leaseId: randomUUID()})).code, 'BUSY');
  call.res.close(); assert.equal((await retirement).status, 'retired');
  assert.equal(f.terminated.length, 1); assert.equal(f.terminated[0].aborted, true);
});

test('ordinary decode failure after clean child termination can retire; cleanup uncertainty stays blocked', async t => {
  await t.test('ordinary failure', async t => {
    const f = await fixture(t, {decode: async () => {throw Error('ordinary decode failure');}});
    await f.reserve(); const call = f.start(); await call.work; call.res.finish(); await tick();
    assert.equal((await f.retire()).status, 'retired');
    const next = {...f.lease, leaseId: randomUUID(), actionId: randomUUID()}; assert.equal((await f.reserve(next)).status, 'reserved');
  });
  await t.test('sticky termination uncertainty', async t => {
    const closeEntered = deferred(), releaseClose = deferred();
    const f = await fixture(t, {decode: async () => {throw Object.assign(Error('unknown child'), {terminationUnconfirmed: true});},
      terminate: async () => [{status: 'unconfirmed'}], waitForClose: async () => {closeEntered.resolve(); await releaseClose.promise; return [{status: 'exited'}];}});
    await f.reserve(); const call = f.start(); await closeEntered.promise;
    let done = false; const retirement = f.retire().then(value => {done = true; return value;});
    await call.work; call.res.close(); await tick(); assert.equal(done, false);
    releaseClose.resolve(); const reply = await retirement; assert.equal(reply.status, 'blocked'); assert.equal(reply.code, 'CLEANUP_UNCONFIRMED');
    assert.equal((await f.reserve({...f.lease, leaseId: randomUUID(), actionId: randomUUID()})).status, 'blocked');
  });
});

test('trusted business settlement hook precedes source effects and does not resolve on public cancellation', async t => {
  const hashEntered = deferred(), releaseHash = deferred(), abort = new AbortController(); let settlement, settled = false;
  const f = await fixture(t, {hash: async () => {hashEntered.resolve(); await releaseHash.promise; throw Error('clean cancelled read');}});
  const work = f.audio.consumeSource(f.sourceInput(0), {signal: abort.signal, onResourceSettlement(value) {
    assert.deepEqual(f.effects, []); settlement = value; value.then(() => {settled = true;});
  }, consume: async () => assert.fail('no consumer')});
  await hashEntered.promise; assert.ok(settlement instanceof Promise); abort.abort(); await assert.rejects(work);
  await tick(); assert.equal(settled, false); releaseHash.resolve(); await settlement; assert.equal(settled, true);
});

test('retiring an in-flight reservation cannot publish or resurrect its late plan result', async () => {
  const keys = credentials(), planning = deferred(), authority = createNativeAudioPreviewAuthority(keys.config);
  authority.bind({handlers: {'timeline.audioPreview.plan': () => planning.promise}});
  const owner = {backendId: keys.config.backendId, windowId: randomUUID(), contextId: randomUUID(), projectId: randomUUID()};
  const lease = {owner, actionId: randomUUID(), leaseId: randomUUID(), input: {projectId: owner.projectId, timelineId: randomUUID(), expectedRevision: 1, startFrame: 0}, planHash: 'a'.repeat(64)};
  const reserve = authority.command({type: 'native-audio:reserve', version: 1, requestId: randomUUID(), ...lease});
  const retire = authority.command({type: 'native-audio:retire', version: 1, requestId: randomUUID(), owner, actionId: lease.actionId, leaseId: lease.leaseId});
  planning.reject(Error('saved plan unavailable'));
  assert.notEqual((await reserve).status, 'reserved'); assert.equal((await retire).status, 'retired');
});

test('concurrent exact reservations share one plan read while a competing tuple never replaces preparing ownership', async t => {
  const f = await fixture(t), planned = deferred(); let reads = 0;
  const authority = createNativeAudioPreviewAuthority(f.keys.config);
  authority.bind({handlers: {'timeline.audioPreview.plan': async () => {reads++; return planned.promise;}}});
  const first = authority.command(f.command('reserve')), duplicate = authority.command(f.command('reserve'));
  assert.equal((await authority.command(f.command('reserve', {...f.lease, actionId: randomUUID()}))).code, 'BUSY');
  assert.equal(reads, 1); planned.resolve(f.plan);
  assert.equal((await first).status, 'reserved'); assert.equal((await duplicate).status, 'reserved');
  assert.equal((await authority.command(f.command('retire'))).status, 'retired');
  assert.equal((await authority.command(f.command('retire'))).status, 'retired');
  assert.equal((await authority.command(f.command('reserve'))).code, 'STALE', 'An already retired lease cannot be resurrected');
});

test('a signed reserved plan still rechecks the saved revision before any source effect', async t => {
  const f = await fixture(t); await f.reserve(); f.snapshot.timeline.revision++;
  const call = f.start(); await call.work;
  assert.notEqual(call.res.statusCode, 200); assert.deepEqual(f.effects, []);
  let retired = false; const retirement = f.retire().then(value => {retired = true; return value;});
  await tick(); assert.equal(retired, false, 'Even a pre-resource error retains its exact HTTP response until terminal proof');
  call.res.close(); assert.equal((await retirement).status, 'retired');
});

test('retirement cannot abort an unrelated signal, destroy an unrelated response, or drain the audio service', async t => {
  const f = await fixture(t), unrelatedSignal = new AbortController(), unrelatedResponse = new Response();
  await f.reserve(); const call = f.start(); await call.res.written.promise;
  const retirement = f.retire(); assert.equal(unrelatedSignal.signal.aborted, false); assert.equal(unrelatedResponse.destroyCalls, 0);
  call.res.close(); assert.equal((await retirement).status, 'retired');
  // If native retirement used the global service drain, this would be stopped.
  assert.equal((await f.audio.handlers['timeline.audioPreview.plan'](f.input)).planHash, f.plan.planHash);
});
