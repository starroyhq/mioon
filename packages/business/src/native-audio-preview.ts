import {createPublicKey, verify} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {isAudioPreviewPlan} from '@mioon/contracts/timeline-audio-preview';
import type {AudioPreviewPlan, AudioPreviewPlanInput, AudioPreviewSourceInput} from '@mioon/contracts/timeline-audio-preview';
import {nativeAudioConfigSchema, nativeAudioCommandSchema, nativeAudioProofSchema, nativeAudioProofMaterial,
  nativeAudioSourceQuery, sameNativeAudioOwner, NATIVE_AUDIO_PCM_PATH, NATIVE_AUDIO_LEASE_HEADER,
  NATIVE_AUDIO_PROOF_HEADER, NATIVE_AUDIO_SIGNATURE_HEADER} from '@mioon/contracts/native-audio-preview';
import type {NativeAudioConfig, NativeAudioCommand, NativeAudioReply} from '@mioon/contracts/native-audio-preview';

export interface NativeAudioPreviewPlanService {
  readonly handlers: {'timeline.audioPreview.plan': (input: AudioPreviewPlanInput) => Promise<unknown>};
}
/** These callbacks are trusted in-process plumbing, never renderer input. finish
 * closes only the HTTP invocation gate; it cannot settle original source work. */
export interface NativeAudioSourceAdmission {
  readonly signal: AbortSignal;
  readonly onResourceSettlement: (settlement: Promise<void>) => void;
  readonly finish: () => void;
}
export interface NativeAudioPreviewAuthority {
  bind(service: NativeAudioPreviewPlanService): void;
  command(message: NativeAudioCommand): Promise<NativeAudioReply>;
  accept(req: IncomingMessage, res: ServerResponse, url: URL, input: AudioPreviewSourceInput): NativeAudioSourceAdmission;
}
type Reserve = Extract<NativeAudioCommand, {type: 'native-audio:reserve'}>;
type ReplyCode = 'NONE' | 'INVALID' | 'BUSY' | 'STALE' | 'UNAVAILABLE' | 'CLEANUP_UNCONFIRMED';
interface Source {
  readonly controller: AbortController;
  readonly response: ServerResponse;
  readonly settled: Promise<void>;
}
interface Lease {
  readonly request: Reserve;
  stage: 'preparing' | 'retained' | 'retiring' | 'blocked';
  ready: Promise<void>;
  retirement?: Promise<boolean>;
  plan?: AudioPreviewPlan;
  failure?: ReplyCode;
  cleanupUnconfirmed: boolean;
  sequence: number;
  readonly used: Set<string>;
  source?: Source;
}
const denied = (): Error & {code: string; status: number} => Object.assign(new Error('Native sound audition admission is unavailable.'),
  {code: 'AUDIO_PREVIEW_NATIVE_REQUIRED', status: 403});
const deferred = (): {promise: Promise<void>; resolve: () => void} => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
};
function sameIdentity(a: NativeAudioCommand, b: NativeAudioCommand): boolean {
  return a.leaseId === b.leaseId && a.actionId === b.actionId && sameNativeAudioOwner(a.owner, b.owner);
}
function sameReserve(a: Reserve, b: Reserve): boolean {
  return sameIdentity(a, b) && a.planHash === b.planHash && a.input.projectId === b.input.projectId &&
    a.input.timelineId === b.input.timelineId && a.input.expectedRevision === b.input.expectedRevision && a.input.startFrame === b.input.startFrame;
}
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

/** One ephemeral backend epoch, one native owner and one exact source lane.
 * Possession of the ordinary HTTP session does not authorize native PCM. Only
 * main can sign a one-use request; this process receives the public SPKI only. */
export function createNativeAudioPreviewAuthority(rawConfig: NativeAudioConfig): NativeAudioPreviewAuthority {
  const config = nativeAudioConfigSchema.parse(rawConfig);
  const publicKey = createPublicKey({key: Buffer.from(config.publicKey, 'hex'), format: 'der', type: 'spki'});
  if (publicKey.asymmetricKeyType !== 'ed25519') throw Error('Invalid native audio public key');
  let service: NativeAudioPreviewPlanService | undefined, current: Lease | undefined, lastRetired: Reserve | undefined;
  const reply = (request: NativeAudioCommand, status: 'retired' | 'blocked' | 'rejected', code: ReplyCode): NativeAudioReply =>
    ({type: 'native-audio:reply', version: 1, requestId: request.requestId, backendId: config.backendId, leaseId: request.leaseId, status, code});
  const blocked = (request: NativeAudioCommand): NativeAudioReply => reply(request, 'blocked', 'CLEANUP_UNCONFIRMED');
  async function reserve(request: Reserve): Promise<NativeAudioReply> {
    if (request.owner.backendId !== config.backendId || request.owner.projectId !== request.input.projectId)
      return reply(request, 'rejected', 'INVALID');
    if (!service) return reply(request, 'rejected', 'UNAVAILABLE');
    if (current?.stage === 'blocked') return blocked(request);
    if (current && (!sameReserve(current.request, request) || current.stage === 'retiring')) return reply(request, 'rejected', 'BUSY');
    if (!current) {
      if (lastRetired?.leaseId === request.leaseId) return reply(request, 'rejected', 'STALE');
      const lease: Lease = {request, stage: 'preparing', ready: Promise.resolve(), cleanupUnconfirmed: false, sequence: 1, used: new Set()};
      current = lease;
      const bound = service;
      lease.ready = (async () => {
        try {
          const plan = await bound.handlers['timeline.audioPreview.plan'](request.input);
          if (!isAudioPreviewPlan(plan, request.input) || plan.planHash !== request.planHash) {lease.failure = 'INVALID'; return;}
          lease.plan = plan;
          if (lease.stage === 'preparing') lease.stage = 'retained';
        } catch {lease.failure = 'UNAVAILABLE';}
        finally {if (lease.failure && lease.stage === 'preparing' && current === lease) current = undefined;}
      })();
    }
    const lease = current;
    // A synchronously throwing trusted planner can clear current before return.
    if (!lease) return reply(request, 'rejected', 'UNAVAILABLE');
    await lease.ready;
    if (lease.failure) return reply(request, 'rejected', lease.failure);
    if (current !== lease || lease.stage !== 'retained' || !lease.plan) return reply(request, 'rejected', 'STALE');
    return {type: 'native-audio:reply', version: 1, requestId: request.requestId, backendId: config.backendId, leaseId: request.leaseId,
      status: 'reserved', planHash: lease.plan.planHash, admittedBytes: lease.plan.memory.admittedBytes};
  }
  function retire(request: Extract<NativeAudioCommand, {type: 'native-audio:retire'}>): Promise<NativeAudioReply> {
    const lease = current;
    if (!lease) return Promise.resolve(reply(request, lastRetired && sameIdentity(lastRetired, request) ? 'retired' : 'rejected',
      lastRetired && sameIdentity(lastRetired, request) ? 'NONE' : 'STALE'));
    if (!sameIdentity(lease.request, request)) return Promise.resolve(reply(request, 'rejected', 'STALE'));
    if (lease.stage === 'blocked') return Promise.resolve(blocked(request));
    if (!lease.retirement) {
      // The fence and exact cancellation happen synchronously, before any await.
      lease.stage = 'retiring';
      lease.source?.controller.abort();
      if (lease.source && !lease.source.response.destroyed) lease.source.response.destroy();
      lease.retirement = (async () => {
        await lease.ready;
        await lease.source?.settled;
        if (lease.cleanupUnconfirmed) {lease.stage = 'blocked'; return false;}
        if (current === lease) {lastRetired = lease.request; current = undefined;}
        return true;
      })();
    }
    return lease.retirement.then(clean => clean ? reply(request, 'retired', 'NONE') : blocked(request));
  }
  function accept(req: IncomingMessage, res: ServerResponse, url: URL, input: AudioPreviewSourceInput): NativeAudioSourceAdmission {
    const lease = current;
    const encoded = header(req, NATIVE_AUDIO_PROOF_HEADER), signature = header(req, NATIVE_AUDIO_SIGNATURE_HEADER);
    if (!lease || lease.stage !== 'retained' || !lease.plan || lease.source || req.method !== 'GET' ||
        url.pathname !== NATIVE_AUDIO_PCM_PATH || url.hash || url.search !== `?${nativeAudioSourceQuery(input)}` ||
        req.url !== `${NATIVE_AUDIO_PCM_PATH}${url.search}` || !encoded || encoded.length > 4096 ||
        !/^[A-Za-z0-9_-]+$/u.test(encoded) || !signature || !/^[a-f0-9]{128}$/u.test(signature)) throw denied();
    let proof;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw denied();
      proof = nativeAudioProofSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {throw denied();}
    const source = lease.plan.sources[lease.sequence - 1];
    const leaseHeader = req.headers[NATIVE_AUDIO_LEASE_HEADER.toLowerCase()];
    if (proof.backendId !== config.backendId || proof.leaseId !== lease.request.leaseId || proof.sequence !== lease.sequence ||
        proof.sequence > lease.plan.sources.length || leaseHeader !== undefined && leaseHeader !== proof.leaseId ||
        nativeAudioSourceQuery(proof.input) !== nativeAudioSourceQuery(input) || input.projectId !== lease.request.owner.projectId ||
        input.timelineId !== lease.request.input.timelineId || input.expectedRevision !== lease.request.input.expectedRevision ||
        input.startFrame !== lease.request.input.startFrame || input.planHash !== lease.plan.planHash ||
        !source || source.clipId !== input.clipId || source.sourceHash !== input.sourceHash || lease.used.has(source.sourceKey) ||
        !verify(null, Buffer.from(nativeAudioProofMaterial(proof)), publicKey, Buffer.from(signature, 'hex'))) throw denied();

    const controller = new AbortController(), resource = deferred(), transport = deferred(), invocation = deferred();
    let registered = false, finished = false;
    const terminal = (): void => {res.off('finish', terminal); res.off('close', terminal); res.off('error', failure); transport.resolve();};
    const failure = (): void => {controller.abort(); if (!res.destroyed) res.destroy();};
    res.once('finish', terminal); res.once('close', terminal); res.on('error', failure);
    const accepted: Source = {controller, response: res, settled: Promise.all([resource.promise, transport.promise, invocation.promise]).then(() => {
      if (lease.source === accepted) lease.source = undefined;
      if (lease.cleanupUnconfirmed) lease.stage = 'blocked';
    })};
    lease.source = accepted; lease.sequence++; lease.used.add(source.sourceKey);
    return Object.freeze({signal: controller.signal,
      onResourceSettlement(settlement: Promise<void>): void {
        if (registered || finished || !(settlement instanceof Promise)) {lease.cleanupUnconfirmed = true; throw denied();}
        registered = true;
        settlement.then(resource.resolve, () => {lease.cleanupUnconfirmed = true; resource.resolve();});
      },
      finish(): void {
        if (finished) return;
        finished = true;
        // No registration means consumeSource rejected before acquiring its
        // resource permit. A cancelled public observer always has registration.
        if (!registered) resource.resolve();
        invocation.resolve();
      }});
  }
  return {bind(value): void {
    if (service || !value || typeof value.handlers?.['timeline.audioPreview.plan'] !== 'function') throw Error('Invalid native audio service binding');
    service = value;
  }, command(message): Promise<NativeAudioReply> {
    const request = nativeAudioCommandSchema.parse(message);
    return request.type === 'native-audio:reserve' ? reserve(request) : retire(request);
  }, accept};
}
