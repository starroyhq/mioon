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
import {openStore, ownsStoreLock, getWorkspaceRestoreContext} from '../../packages/business/src/db.ts';
import {createServices, hash} from '../../packages/business/src/services.ts';
import {createLocalDelivery, LOCAL_DELIVERY_FILENAME} from '../../packages/business/src/local-delivery.ts';
import {createTimelinePreflightServices} from '../../packages/business/src/timeline-preflight.ts';
import {createTimelineRecoveryBoundary, readTimelineReceipt} from '../../packages/business/src/timeline-recovery.ts';
import {onMediaProcess} from '../../packages/business/src/media-processes.ts';
import {callObservedRpc} from '../../apps/server/src/rpc-observation.ts';
import {createLocalDeliveryHttp} from '../../apps/server/src/local-delivery-http.ts';
import type {ServerResponse} from 'node:http';

export const TOKEN = 'selected-range-synthetic-loopback-token';
export const RANGE = Object.freeze({startFrame: 12, endFrame: 45});
export const SETTINGS = Object.freeze({profileId: 'mp4_h264_v1', resolution: 'short_360', rateControl: {mode: 'crf', quality: 'standard'}});
interface AuthorityValue {workspaceScope: unknown; instanceId: unknown; projectId: unknown; intent?: {intentId?: unknown}; intentRevision?: unknown; [key: string]: unknown}
export const sha = (value: Buffer|Uint8Array|string): string => createHash('sha256').update(value).digest('hex');
export const authority = (value: AuthorityValue): Record<string, unknown> => ({workspaceScope: value.workspaceScope, instanceId: value.instanceId, projectId: value.projectId});
export const action = (value: AuthorityValue): Record<string, unknown> => ({...authority(value), intentId: value.intent?.intentId, expectedIntentRevision: value.intentRevision});
export async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>|undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);})]); }
  finally {clearTimeout(timer);}
}

function syntheticPng(): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(16); head.writeUInt32BE(16, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.alloc(16 * 49, 90); for (let row = 0; row < 16; row++) rows[row * 49] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
interface FileEntry {directory?: string; name?: string; hash?: string}
async function files(root: string, relative = ''): Promise<FileEntry[]> {
  const result: FileEntry[] = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push({directory: name}, ...await files(root, name));
    else if (!/^workbench\.sqlite(?:-wal|-shm)?$/.test(name) && name !== 'server.lock') result.push({name, hash: sha(await readFile(path.join(root, name)))});
  }
  return result.sort((a: FileEntry, b: FileEntry) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const send = (response: ServerResponse, status: number, body: unknown): void => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'}); response.end(JSON.stringify(body));
};

type Store = ReturnType<typeof openStore>;
type Services = ReturnType<typeof createServices>;
type Delivery = ReturnType<typeof createLocalDelivery>;
type DeliveryHttp = ReturnType<typeof createLocalDeliveryHttp>;
interface ObservationRecord {path: string; body: unknown; status: number|undefined}
interface CancellationState {service: ReturnType<typeof createTimelinePreflightServices>; entered: PromiseWithResolvers<void>; aborted: PromiseWithResolvers<void>; settled: PromiseWithResolvers<void>}
export interface SelectedRangeFixtureOptions {[key: string]: unknown}
export async function selectedRangeFixture(t: unknown): Promise<Record<string, unknown>> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-selected-range-wire-')));
  const dispatches: unknown[] = [], submissions: unknown[] = [], observations: ObservationRecord[] = [], media: unknown[] = [], faults: string[] = [], capabilityChecks: unknown[] = [];
  let store: Store|null = null, services: Services|null = null, delivery: Delivery|null = null, deliveryHttp: DeliveryHttp|null = null;
  let server: Awaited<ReturnType<typeof import('node:http').createServer>>|null = null;
  let cancellation: CancellationState|null = null, dropPath: string|undefined, malformedRange: 'removed'|'incremented'|undefined;
  let fault: (point: string)=>void = () => {};
  const off = onMediaProcess((event: unknown) => media.push(event));
  const reopen = (): void => {
    store = openStore(root);
    services = createServices(store!, new Map(), {env: {MIOON_ENABLE_LIVE_PROVIDER: '0'}, exportOptions: {
      // Admission-only deterministic proof; encoding correctness has separate
      // real-media gates. No renderer, model or provider is started here.
      inspect: async (value: unknown) => {capabilityChecks.push(structuredClone(value)); return {status: 'available', code: 'EXPORT_CAPABILITY_AVAILABLE'};},
    }});
    delivery = createLocalDelivery({root, storage: {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile},
      fault: (point: string) => fault(point), guards: {
        ownsLock: () => ownsStoreLock(store!), isRestored: () => Boolean(getWorkspaceRestoreContext(store!)),
        readTimeline: (projectId: string) => createTimelineRecoveryBoundary(store!.db, {projectId}).read({sourceSemantics: false}),
        isRenderInput: (value: unknown) => schemas['timeline.render'].safeParse(value).success,
        isRenderResponse: (input: unknown, value: unknown) => isTimelineMutationResponse('timeline.render', input, value),
        isNotApplied: (input: unknown, error: unknown) => hasRequestNotAppliedProof(error, input, {operation: 'timeline.render'}),
        readReceipt: (input: never) => {
          const saved = readTimelineReceipt(store!.db, input, 'timeline.render'); if (!saved) return null;
          if (saved.requestHash !== hash({operation: 'timeline.render', input})) throw new AppError('IDEMPOTENCY_CONFLICT', 'Synthetic receipt identity mismatch', 409);
          return publicValue(createTimelineRecoveryBoundary(store!.db, input).replay('timeline.render', saved.response as string));
        },
        render: (input: never) => {dispatches.push(structuredClone(input)); return services!.call('timeline.render', input);},
      } as never});
    deliveryHttp = createLocalDeliveryHttp({delivery});
  };
  const close = async (): Promise<void> => {
    if (server) {server.closeAllConnections(); await bounded(new Promise<void>(resolve => server!.close(() => resolve())), 'Synthetic listener close'); server = null;}
    if (cancellation) {await cancellation.service.drain(); cancellation = null;}
    if (services) {await services.drain(); services = null;}
    if (store?.db.isOpen) store.close();
  };
  (t as {after(callback: ()=>Promise<void>): void}).after(async () => {
    try {await close(); assert.deepEqual(faults, [], 'listener never hides fixture failures');}
    finally {off(); await rm(root, {recursive: true, force: true});}
  });
  reopen();
  interface FixtureProject {id: string}
  interface FixtureTimeline {id: string; revision: number; tracks: {id: string}[]; [key: string]: unknown}
  interface FixtureSource {id: string; relativePath: string}
  const project = await services!.call('project.create', {name: 'Selected range synthetic transport 🎬'}) as unknown as FixtureProject;
  let timeline = await services!.call('timeline.get', {projectId: project.id}) as unknown as FixtureTimeline;
  const sources: FixtureSource[] = [];
  for (const index of [0, 1]) {
    const id = randomUUID(), bytes = syntheticPng(), relativePath = `media/${id}.png`;
    await writeFile(path.join(root, relativePath), bytes, {mode: 0o600, flag: 'wx'});
    const asset = store!.put('assets', {id, projectId: project.id, name: `Synthetic ${index}.png`, mimeType: 'image/png', relativePath,
      sha256: sha(bytes), sizeBytes: bytes.length, width: 16, height: 16, duration: 0, hasVideo: true, hasAudio: false,
      provenance: 'user-import', createdAt: new Date().toISOString()});
    sources.push(asset as unknown as FixtureSource);
    timeline = await services!.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(),
      assetId: id, trackId: timeline.tracks[0]!.id, startFrame: index * 90, durationFrames: index ? 30 : 90}) as unknown as FixtureTimeline;
  }
  async function listen() {
    server = http.createServer(async (request: import('node:http').IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '', `http://${String(request.headers.host)}`);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, {ok: false, error: {code: 'UNAUTHORIZED'}});
      if (request.headers.origin && request.headers.origin !== f.url) return send(response, 403, {ok: false, error: {code: 'ORIGIN_REJECTED'}});
      // Drop only the completed acknowledgement. The actual business and
      // companion commits are observed before the exact socket is destroyed.
      const end = response.end.bind(response);
      (response as unknown as {end: unknown}).end = (bytes?: string|Buffer) => {
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
        if (await deliveryHttp!(request, response, url)) return;
        if (url.pathname !== '/api/rpc' || request.method !== 'POST') return send(response, 404, {ok: false, error: {code: 'NOT_FOUND'}});
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {bytes += chunk.length; if (bytes > 32 * 1024) throw Error('Synthetic request cap'); chunks.push(chunk);}
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; submissions.push(envelope);
        const selected = cancellation && envelope.operation === 'timeline.export.preflight' ? {call: async (operation: string, input: unknown, options: unknown) => {
          const handler = ((cancellation as CancellationState).service.handlers as unknown as Record<string, (value: unknown, options: unknown)=>Promise<unknown>>)[operation];
          try {return await handler!(parse(operation as never, input), options as never);}
          finally {cancellation!.settled.resolve(undefined);}
        }} : services!;
        const result = await callObservedRpc(request, response, selected, String(envelope.operation), envelope.input,
          Object.hasOwn(envelope, 'expectedWorkspaceOrigin') ? {expectedWorkspaceOrigin: envelope.expectedWorkspaceOrigin} : {});
        send(response, 200, {ok: true, data: result});
      } catch (error) {
        const failure = error as {code?: string; message?: string; status?: number; details?: unknown};
        if (!failure.code) faults.push(failure.message ?? String(error));
        send(response, failure.status || 500, {ok: false, error: {code: failure.code || 'INTERNAL_ERROR', message: failure.message, details: failure.details || {}, retryable: false}});
      }
    });
    await bounded(new Promise<void>((resolve, reject) => {server!.once('error', reject); server!.listen(0, '127.0.0.1', () => resolve());}), 'Synthetic listener startup');
  }
  const f = {root, project, timeline, sources, dispatches, submissions, observations, media, capabilityChecks,
    file: path.join(root, LOCAL_DELIVERY_FILENAME), get store(): Store {if(!store)throw Error('Store not open');return store;}, get services(): Services {if(!services)throw Error('Services not open');return services;}, get delivery(): Delivery {if(!delivery)throw Error('Delivery not started');return delivery;},
    get url(): string {const address=server!.address();const port=typeof address==='object'&&address?address.port:0;return `http://127.0.0.1:${port}`;},
    rows: (): Record<string, unknown[]> => Object.fromEntries((store!.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[])
      .map(({name}) => [name, store!.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all()])),
    receipt: (requestId: string) => store!.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(requestId),
    async checkpoint(): Promise<{rows: Record<string, unknown[]>; files: FileEntry[]}> {return {rows: f.rows(), files: await files(root)};},
    async unchanged(before: unknown): Promise<void> {assert.deepEqual(await f.checkpoint(), before);},
    async request(suffix: string, {method = 'GET', input, signal}: {method?: string; input?: unknown; signal?: AbortSignal} = {}) {
      const response = await fetch(f.url + suffix, {method, redirect: 'error', signal: signal ?? AbortSignal.timeout(15_000),
        headers: {authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json'}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
      const body = await response.json(); assert.equal(response.ok, body.ok, JSON.stringify(body)); return {status: response.status, body};
    },
    async rpc(operation: string, input: unknown, options: Record<string, unknown> = {}) {return (await f.request('/api/rpc', {method: 'POST', input: {operation, input}, ...options})).body;},
    async local(suffix = '', input?: unknown) {
      const result = await f.request(`/api/local-delivery${suffix || `?projectId=${project.id}`}`, input === undefined ? {} : {method: suffix === '/draft' ? 'PUT' : 'POST', input});
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data;
    },
    prepare(value: AuthorityValue & {intentRevision?: unknown; intent?: {intentId?: unknown}; draft?: {draftId?: unknown; raw?: {deliveryName?: unknown}}; draftRevision?: unknown}, extra: Record<string, unknown> = {}) {return {...authority(value), expectedIntentRevision: value.intentRevision, expectedIntentId: value.intent?.intentId ?? null,
      intentId: randomUUID(), timelineId: timeline.id, baseRevision: timeline.revision,
      draft: value.draft ? {draftId: value.draft.draftId, revision: value.draftRevision, raw: value.draft.raw} : null,
      input: {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), purpose: 'export',
        ...(value.draft?.raw?.deliveryName ? {deliveryName: value.draft.raw.deliveryName} : {}), exportRange: {...RANGE}, ...extra}};},
    lose: (suffix: string) => {dropPath = suffix;}, malformRange: (kind: 'removed'|'incremented') => {malformedRange = kind;}, fault: (fn: (point: string)=>void) => {fault = fn;},
    async restart(between?: ()=>Promise<unknown>): Promise<void> {await close(); if (between) await between(); reopen(); await listen();},
    async assertNoWorker() {
      const events = media as {kind?: unknown; type?: unknown; pid?: unknown}[];
      assert.equal(events.some(event => event.kind !== 'ffprobe'), false, 'no renderer, encoder or provider process starts');
      assert.deepEqual(events.filter(event => event.type === 'started').map(event => event.pid).sort(),
        events.filter(event => event.type === 'exited').map(event => event.pid).sort(), 'every bounded source probe has confirmed close');
      assert.equal(store!.list('exports').some((value: unknown) => {const row=value as Record<string, unknown>;return row.status !== 'queued' || row.assetId !== null || row.url !== null;}), false);
      assert.equal(store!.list('assets').some((value: unknown) => (value as Record<string, unknown>).provenance === 'export'), false, 'no output asset exists');
      assert.deepEqual((await readdir(path.join(root, 'media'))).sort(), sources.map((value: FixtureSource) => path.basename(value.relativePath)).sort(), 'only the two managed source files exist');
    },
    async armCancellation() {
      assert.ok(cancellation == null);
      const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
      const service = createTimelinePreflightServices(store!, {probe: (async (_file: string, {signal}: {signal: AbortSignal}) => {
        entered.resolve(undefined);
        await new Promise<void>(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), {once: true});});
        aborted.resolve(undefined); throw Object.assign(Error('Synthetic selected-range probe cancelled'), {code: 'MEDIA_CANCELLED'});
      }) as never});
      cancellation = {service, entered, aborted, settled};
      return {entered: entered.promise, aborted: aborted.promise, settled: settled.promise,
        async clear() {await bounded(settled.promise, 'Cancelled preflight settlement'); await service.drain(); cancellation = null;}};
    },
  };
  await listen(); return f;
}
