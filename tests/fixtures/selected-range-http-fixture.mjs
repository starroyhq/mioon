/** Synthetic loopback listener, not the full desktop server. It uses the real
 * shared services, SQLite, observation adapter and private-delivery adapter.
 * No job worker is constructed, so admission/recovery cannot encode media.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {mkdtemp, readFile, readdir, writeFile, rm, realpath} from 'node:fs/promises';
import {schemas, parse, isTimelineMutationResponse, hasRequestNotAppliedProof, publicValue, AppError} from '@mioon/contracts';
import {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../../packages/business/src/db.mjs';
import {createServices, hash} from '../../packages/business/src/services.mjs';
import {createLocalDelivery, LOCAL_DELIVERY_FILENAME} from '../../packages/business/src/local-delivery.ts';
import {createTimelinePreflightServices} from '../../packages/business/src/timeline-preflight.mjs';
import {createTimelineRecoveryBoundary, readTimelineReceipt} from '../../packages/business/src/timeline-recovery.mjs';
import {onMediaProcess} from '../../packages/business/src/media-processes.mjs';
import {callObservedRpc} from '../../apps/server/src/rpc-observation.mjs';
import {createLocalDeliveryHttp} from '../../apps/server/src/local-delivery-http.ts';

export const TOKEN = 'selected-range-synthetic-loopback-token';
export const RANGE = Object.freeze({startFrame: 12, endFrame: 45});
export const SETTINGS = Object.freeze({profileId: 'mp4_h264_v1', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}});
export const sha = value => createHash('sha256').update(value).digest('hex');
export const authority = value => ({workspaceScope: value.workspaceScope, instanceId: value.instanceId, projectId: value.projectId});
export const action = value => ({...authority(value), intentId: value.intent.intentId, expectedIntentRevision: value.intentRevision});
export async function bounded(promise, label, ms = 15_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);})]); }
  finally {clearTimeout(timer);}
}

function syntheticPng() {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(16); head.writeUInt32BE(16, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc(16 * 49, 90); for (let row = 0; row < 16; row++) rows[row * 49] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
async function files(root, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await files(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock') result.push({name, hash: sha(await readFile(path.join(root, name)))});
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const send = (response, status, body) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(body));
};

export async function selectedRangeFixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-selected-range-wire-')));
  const dispatches = [], submissions = [], observations = [], media = [], faults = [], capabilityChecks = [];
  let store, services, delivery, deliveryHttp, server, cancellation, dropPath, malformedRange, fault = () => {};
  const off = onMediaProcess(event => media.push(event));
  const reopen = () => {
    store = openStore(root);
    services = createServices(store, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, exportOptions: {
      // Admission-only deterministic proof; encoding correctness has separate
      // real-media gates. No renderer, model or provider is started here.
      inspect: async value => {capabilityChecks.push(structuredClone(value)); return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};},
    }});
    delivery = createLocalDelivery({root, storage: {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile},
      fault: point => fault(point), guards: {
        ownsLock: () => ownsStoreLock(store), isRestored: () => Boolean(getWorkspaceRestoreContext(store)),
        readTimeline: projectId => createTimelineRecoveryBoundary(store.db, {projectId}).read({sourceSemantics: false}),
        isRenderInput: value => schemas['timeline.render'].safeParse(value).success,
        isRenderResponse: (input, value) => isTimelineMutationResponse('timeline.render', input, value),
        isNotApplied: (input, error) => hasRequestNotAppliedProof(error, input, {operation: 'timeline.render'}),
        readReceipt: input => {
          const saved = readTimelineReceipt(store.db, input, 'timeline.render'); if (!saved) return null;
          if (saved.requestHash !== hash({operation: 'timeline.render', input})) throw new AppError('IDEMPOTENCY_CONFLICT', 'Synthetic receipt identity mismatch', 409);
          return publicValue(createTimelineRecoveryBoundary(store.db, input).replay('timeline.render', saved.response));
        },
        render: input => {dispatches.push(structuredClone(input)); return services.call('timeline.render', input);},
      }});
    deliveryHttp = createLocalDeliveryHttp({delivery});
  };
  const close = async () => {
    if (server) {server.closeAllConnections(); await bounded(new Promise(resolve => server.close(resolve)), 'Synthetic listener close'); server = null;}
    if (cancellation) {await cancellation.service.drain(); cancellation = null;}
    if (services) {await services.drain(); services = null;}
    if (store?.db.isOpen) store.close();
  };
  t.after(async () => {
    try {await close(); assert.deepEqual(faults, [], 'listener never hides fixture failures');}
    finally {off(); await rm(root, {recursive: true, force: true});}
  });
  reopen();
  const project = await services.call('project.create', {name: 'Selected range synthetic transport 🎬'});
  let timeline = await services.call('timeline.get', {projectId: project.id});
  const sources = [];
  for (const index of [0, 1]) {
    const id = randomUUID(), bytes = syntheticPng(), relativePath = `media/${id}.png`;
    await writeFile(path.join(root, relativePath), bytes, {mode: 0o600, flag: 'wx'});
    const asset = store.put('assets', {id, projectId: project.id, name: `Synthetic ${index}.png`, mimeType: 'image/png', relativePath,
      sha256: sha(bytes), sizeBytes: bytes.length, width: 16, height: 16, duration: 0, hasVideo: true, hasAudio: false,
      provenance: 'user-import', createdAt: new Date().toISOString()});
    sources.push(asset);
    timeline = await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId: id, trackId: timeline.tracks[0].id, startFrame: index * 90, durationFrames: index ? 30 : 90});
  }
  async function listen() {
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, {ok: false, error: {code: 'UNAUTHORIZED'}});
      if (request.headers.origin && request.headers.origin !== f.url) return send(response, 403, {ok: false, error: {code: 'ORIGIN_REJECTED'}});
      // Drop only the completed acknowledgement. The actual business and
      // companion commits are observed before the exact socket is destroyed.
      const end = response.end.bind(response);
      response.end = bytes => {
        if (bytes !== undefined) observations.push({path: url.pathname, body: JSON.parse(String(bytes)), status: response.statusCode});
        if (dropPath === url.pathname) {dropPath = undefined; response.destroy(); return response;}
        if (malformedRange && url.pathname === '/api/rpc') {
          const body = JSON.parse(String(bytes));
          assert.ok(body.data?.snapshot?.exportRange, 'range-ACK corruption targets only an accepted ranged render');
          if (malformedRange === 'removed') delete body.data.snapshot.exportRange;
          else body.data.snapshot.exportRange.startFrame++;
          malformedRange = undefined; return end(JSON.stringify(body));
        }
        return end(bytes);
      };
      try {
        if (await deliveryHttp(request, response, url)) return;
        if (url.pathname !== '/api/rpc' || request.method !== 'POST') return send(response, 404, {ok: false, error: {code: 'NOT_FOUND'}});
        const chunks = []; let bytes = 0;
        for await (const chunk of request) {bytes += chunk.length; if (bytes > 32 * 1024) throw Error('Synthetic request cap'); chunks.push(chunk);}
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); submissions.push(envelope);
        const selected = cancellation && envelope.operation === 'timeline.export.preflight' ? {call: async (operation, input, options) => {
          try {return await cancellation.service.handlers[operation](parse(operation, input), options);}
          finally {cancellation.settled.resolve();}
        }} : services;
        const result = await callObservedRpc(request, response, selected, envelope.operation, envelope.input,
          Object.hasOwn(envelope, 'expectedWorkspaceOrigin') ? {expectedWorkspaceOrigin: envelope.expectedWorkspaceOrigin} : {});
        send(response, 200, {ok: true, data: result});
      } catch (error) {
        if (!error.code) faults.push(error.message);
        send(response, error.status || 500, {ok: false, error: {code: error.code || 'INTERNAL_ERROR', message: error.message, details: error.details || {}, retryable: false}});
      }
    });
    await bounded(new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);}), 'Synthetic listener startup');
  }
  const f = {root, project, timeline, sources, dispatches, submissions, observations, media, capabilityChecks,
    file: path.join(root, LOCAL_DELIVERY_FILENAME), get store() {return store;}, get services() {return services;}, get delivery() {return delivery;},
    get url() {return `http://127.0.0.1:${server.address().port}`;},
    rows: () => Object.fromEntries(store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({name}) => [name, store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()])),
    receipt: requestId => store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(requestId),
    async checkpoint() {return {rows: f.rows(), files: await files(root)};},
    async unchanged(before) {assert.deepEqual(await f.checkpoint(), before);},
    async request(suffix, {method = 'GET', input, signal} = {}) {
      const response = await fetch(f.url + suffix, {method, redirect: 'error', signal: signal ?? AbortSignal.timeout(15_000),
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
      const body = await response.json(); assert.equal(response.ok, body.ok, JSON.stringify(body)); return {status: response.status, body};
    },
    async rpc(operation, input, options = {}) {return (await f.request('/api/rpc', {method: 'POST', input: {operation, input}, ...options})).body;},
    async local(suffix = '', input) {
      const result = await f.request(`/api/local-delivery${suffix || `?projectId=${project.id}`}`, input === undefined ? {} : {method: suffix === '/draft' ? 'PUT' : 'POST', input});
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data;
    },
    prepare(value, extra = {}) {return {...authority(value), expectedIntentRevision: value.intentRevision, expectedIntentId: value.intent?.intentId ?? null,
      intentId: randomUUID(), timelineId: timeline.id, baseRevision: timeline.revision,
      draft: value.draft ? {draftId: value.draft.draftId, revision: value.draftRevision, raw: value.draft.raw} : null,
      input: {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
        ...(value.draft?.raw.deliveryName ? {deliveryName: value.draft.raw.deliveryName} : {}), exportRange: {...RANGE}, ...extra}};},
    lose: suffix => {dropPath = suffix;}, malformRange: kind => {malformedRange = kind;}, fault: fn => {fault = fn;},
    async restart(between) {await close(); if (between) await between(); reopen(); await listen();},
    async assertNoWorker() {
      assert.equal(media.some(event => event.kind !== 'ffprobe'), false, 'no renderer, encoder or provider process starts');
      assert.deepEqual(media.filter(event => event.type === 'started').map(event => event.pid).sort(),
        media.filter(event => event.type === 'exited').map(event => event.pid).sort(), 'every bounded source probe has confirmed close');
      assert.equal(store.list('exports').some(value => value.status !== 'queued' || value.assetId !== null || value.url !== null), false);
      assert.equal(store.list('assets').some(value => value.provenance === 'export'), false, 'no output asset exists');
      assert.deepEqual((await readdir(path.join(root, 'media'))).sort(), sources.map(value => path.basename(value.relativePath)).sort(), 'only the two managed source files exist');
    },
    async armCancellation() {
      assert.ok(cancellation == null);
      const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), settled = Promise.withResolvers();
      const service = createTimelinePreflightServices(store, {probe: async (_file, {signal}) => {
        entered.resolve();
        await new Promise(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once: true});});
        aborted.resolve(); throw Object.assign(Error('Synthetic selected-range probe cancelled'), {code: 'MEDIA_CANCELLED'});
      }});
      cancellation = {service, entered, aborted, settled};
      return {entered: entered.promise, aborted: aborted.promise, settled: settled.promise,
        async clear() {await bounded(settled.promise, 'Cancelled preflight settlement'); await service.drain(); cancellation = undefined;}};
    },
  };
  await listen(); return f;
}
