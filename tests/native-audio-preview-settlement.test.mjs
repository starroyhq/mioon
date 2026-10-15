import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {createNativeAudioPreviewAuthority} from '../packages/business/src/native-audio-preview.ts';
import {buildAudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import {CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_LIMITS, CONTINUOUS_AUDIO_PROFILE,
  continuousAudioQuery} from '@mioon/contracts/timeline-audio-continuous';
import {NATIVE_AUDIO_PCM_PATH, NATIVE_AUDIO_PROOF_HEADER, NATIVE_AUDIO_SIGNATURE_HEADER,
  nativeAudioProofMaterial, nativeAudioSourceQuery} from '@mioon/contracts/native-audio-preview';

const tick = () => new Promise(resolve => setImmediate(resolve));
const hash = value => createHash('sha256').update(value).digest('hex');
const protocols = [{name: 'V1 GET', version: 1, method: 'GET'}, {name: 'V2 GET', version: 2, method: 'GET'},
  {name: 'V2 DELETE', version: 2, method: 'DELETE'}];
const orders = [
  ['resource', 'transport', 'invocation'], ['resource', 'invocation', 'transport'],
  ['transport', 'resource', 'invocation'], ['transport', 'invocation', 'resource'],
  ['invocation', 'resource', 'transport'], ['invocation', 'transport', 'resource'],
];

// A destroy call requests cancellation; only the separately emitted terminal
// event proves this exact response has finished.
class Response extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;
  destroy() {this.destroyed = true; this.destroyCalls++; return this;}
  terminal(event) {this.emit(event);}
}

async function fixture({version, method}) {
  const keys = generateKeyPairSync('ed25519'), backendId = randomUUID();
  const authority = createNativeAudioPreviewAuthority({version: 1, backendId,
    publicKey: keys.publicKey.export({format: 'der', type: 'spki'}).toString('hex')});
  const projectId = randomUUID(), timelineId = randomUUID(), trackId = randomUUID(), assetId = randomUUID(), clipId = randomUUID();
  const input = {projectId, timelineId, expectedRevision: 1, startFrame: 0};
  const legacyPlan = buildAudioPreviewPlan(input, {timeline: {id: timelineId, projectId, revision: 1, fps: 30,
    durationFrames: 2, tracks: [{id: trackId, kind: 'audio', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: clipId, trackId, assetId, startFrame: 0, durationFrames: 2, sourceInFrame: 0, gain: 1}]},
  assets: [{id: assetId, projectId, sha256: hash('native settlement source'), sizeBytes: 1024,
    mimeType: 'audio/wav', duration: 1, hasAudio: true}]}, hash);
  const continuousPlan = {schemaVersion: 2, status: 'planned', profileId: CONTINUOUS_AUDIO_PROFILE,
    projectId, timelineId, timelineRevision: 1, startFrame: 0, durationFrames: 18000, blockFrames: 60,
    sampleRate: 48000, channels: 2, admittedBytes: CONTINUOUS_AUDIO_LIMITS.memoryBytes,
    snapshotHash: hash('native settlement snapshot'), planHash: hash('native settlement continuous plan')};
  const sessionId = randomUUID(), retiredSessions = [];
  authority.bind({handlers: {'timeline.audioPreview.plan': async () => legacyPlan,
    'timeline.audioPreview.continuousPlan': async () => continuousPlan},
  retireSessionById: async id => {retiredSessions.push(id);}});
  const owner = {backendId, windowId: randomUUID(), contextId: randomUUID(), projectId};
  const identity = {owner, actionId: randomUUID(), leaseId: randomUUID()};
  const planHash = version === 1 ? legacyPlan.planHash : continuousPlan.planHash;
  assert.equal((await authority.command({type: 'native-audio:reserve', version, requestId: randomUUID(),
    ...identity, input, planHash, ...(version === 2 ? {sessionId} : {})})).status, 'reserved');
  const sourceInput = version === 1 ? {...input, clipId, sourceHash: legacyPlan.sources[0].sourceHash, planHash} :
    {...input, planHash, sessionId, generation: 1, sequence: 1, blockStartFrame: 0};
  const proof = version === 1 ? {version, backendId, leaseId: identity.leaseId, sequence: 1, input: sourceInput} :
    {version, backendId, leaseId: identity.leaseId, method, input: sourceInput};
  const path = version === 1 ? NATIVE_AUDIO_PCM_PATH : CONTINUOUS_AUDIO_ENDPOINT;
  const query = version === 1 ? nativeAudioSourceQuery(sourceInput) : continuousAudioQuery(sourceInput);
  const url = new URL(`http://127.0.0.1${path}?${query}`);
  const request = {method, url: url.pathname + url.search, headers: {
    [NATIVE_AUDIO_PROOF_HEADER.toLowerCase()]: Buffer.from(JSON.stringify(proof)).toString('base64url'),
    [NATIVE_AUDIO_SIGNATURE_HEADER.toLowerCase()]: sign(null, Buffer.from(nativeAudioProofMaterial(proof)), keys.privateKey).toString('hex')}};
  const response = new Response();
  const admission = version === 1 ? authority.accept(request, response, url, sourceInput) :
    authority.acceptContinuous(request, response, url, sourceInput);
  const retire = () => authority.command({type: 'native-audio:retire', version: 1, requestId: randomUUID(), ...identity});
  return {admission, response, retire, retiredSessions, sessionId};
}

function pendingRetirement(f) {
  let completed = false;
  const promise = f.retire().then(reply => {completed = true; return reply;});
  return {promise, get completed() {return completed;}};
}
function assertDetached(response) {
  for (const event of ['finish', 'close', 'error']) assert.equal(response.listenerCount(event), 0, `${event} listener is removed`);
}
const deniedRegistration = error => error.code === 'AUDIO_PREVIEW_NATIVE_REQUIRED' && error.status === 403;

for (const protocol of protocols) {
  for (const terminal of ['finish', 'close']) {
    for (const order of orders) {
      test(`${protocol.name}: ${order.join(' → ')} with response ${terminal} requires all three settlement proofs`, async () => {
        const f = await fixture(protocol), resource = Promise.withResolvers();
        assert.equal(Object.isFrozen(f.admission), true);
        f.admission.onResourceSettlement(resource.promise);
        const retirement = pendingRetirement(f);
        assert.equal(f.admission.signal.aborted, true);
        assert.equal(f.response.destroyCalls, 1);
        await tick(); assert.equal(retirement.completed, false, 'Abort and destroy cannot release ownership');
        const settle = {resource: () => resource.resolve(), transport: () => f.response.terminal(terminal),
          invocation: () => {f.admission.finish(); f.admission.finish();}};
        for (const [index, gate] of order.entries()) {
          settle[gate](); await tick();
          assert.equal(retirement.completed, index === order.length - 1, `${gate} must not skip an outstanding proof`);
        }
        assert.equal((await retirement.promise).status, 'retired');
        assert.deepEqual(f.retiredSessions, protocol.version === 2 ? [f.sessionId] : []);
        assertDetached(f.response);
        f.response.terminal(terminal === 'close' ? 'finish' : 'close');
        assert.equal((await f.retire()).status, 'retired', 'A second terminal event and duplicate finish remain harmless');
      });
    }
  }

  test(`${protocol.name}: response error only cancels and still needs exact transport proof`, async () => {
    const f = await fixture(protocol), resource = Promise.withResolvers();
    f.admission.onResourceSettlement(resource.promise);
    f.response.emit('error', Error('transport failed'));
    assert.equal(f.admission.signal.aborted, true); assert.equal(f.response.destroyCalls, 1);
    resource.resolve(); f.admission.finish();
    const retirement = pendingRetirement(f);
    await tick(); assert.equal(retirement.completed, false);
    assert.equal(f.response.listenerCount('close'), 1, 'Cancellation keeps the response terminal listener');
    f.response.terminal('close');
    assert.equal((await retirement.promise).status, 'retired'); assertDetached(f.response);
  });

  test(`${protocol.name}: duplicate registration retains the original resource proof and blocks retirement`, async () => {
    const f = await fixture(protocol), original = Promise.withResolvers();
    f.admission.onResourceSettlement(original.promise);
    assert.throws(() => f.admission.onResourceSettlement(Promise.resolve()), deniedRegistration);
    f.admission.finish(); f.response.terminal('finish');
    const retirement = pendingRetirement(f);
    await tick(); assert.equal(retirement.completed, false, 'The replacement promise cannot release the original work');
    original.resolve();
    const reply = await retirement.promise;
    assert.equal(reply.status, 'blocked'); assert.equal(reply.code, 'CLEANUP_UNCONFIRMED'); assertDetached(f.response);
  });

  for (const {name, value} of [{name: 'undefined', value: undefined}, {name: 'null', value: null},
    {name: 'plain object', value: {}}, {name: 'thenable', value: {then(resolve) {resolve();}}}]) {
    test(`${protocol.name}: invalid ${name} registration fails closed`, async () => {
      const f = await fixture(protocol), actual = Promise.withResolvers();
      assert.throws(() => f.admission.onResourceSettlement(value), deniedRegistration);
      f.admission.onResourceSettlement(actual.promise);
      f.admission.finish(); f.response.terminal('close');
      const retirement = pendingRetirement(f);
      await tick(); assert.equal(retirement.completed, false, 'A bad registration cannot substitute for later exact resource proof');
      actual.resolve();
      const reply = await retirement.promise;
      assert.equal(reply.status, 'blocked'); assert.equal(reply.code, 'CLEANUP_UNCONFIRMED'); assertDetached(f.response);
    });
  }

  test(`${protocol.name}: resource rejection remains blocked after all other settlement proofs`, async () => {
    const f = await fixture(protocol), resource = Promise.withResolvers();
    f.admission.onResourceSettlement(resource.promise);
    resource.reject(Error('original cleanup unconfirmed'));
    f.response.terminal('finish');
    const retirement = pendingRetirement(f);
    await tick(); assert.equal(retirement.completed, false, 'Resource failure cannot skip invocation settlement');
    f.admission.finish();
    const reply = await retirement.promise;
    assert.equal(reply.status, 'blocked'); assert.equal(reply.code, 'CLEANUP_UNCONFIRMED'); assertDetached(f.response);
  });

  test(`${protocol.name}: finish before resource acquisition remains compatible and needs the response proof`, async () => {
    const f = await fixture(protocol);
    f.admission.finish(); f.admission.finish();
    const retirement = pendingRetirement(f);
    await tick(); assert.equal(retirement.completed, false);
    f.response.terminal('close');
    assert.equal((await retirement.promise).status, 'retired'); assertDetached(f.response);
  });

  test(`${protocol.name}: registration after finish fails closed before response settlement`, async () => {
    const f = await fixture(protocol);
    f.admission.finish();
    assert.throws(() => f.admission.onResourceSettlement(Promise.resolve()), deniedRegistration);
    const retirement = pendingRetirement(f);
    await tick(); assert.equal(retirement.completed, false);
    f.response.terminal('close');
    const reply = await retirement.promise;
    assert.equal(reply.status, 'blocked'); assert.equal(reply.code, 'CLEANUP_UNCONFIRMED'); assertDetached(f.response);
  });
}
