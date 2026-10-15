import type {IncomingMessage, ServerResponse} from 'node:http';
import {CONTINUOUS_AUDIO_ENDPOINT, CONTINUOUS_AUDIO_HEADERS as HEADERS, continuousAudioBlockInputSchema,
  continuousAudioQuery} from '../../../packages/contracts/src/timeline-audio-continuous.ts';
import type {ContinuousAudioBlockInput} from '../../../packages/contracts/src/timeline-audio-continuous.ts';
import type {ContinuousAudioConsumeContext} from '../../../packages/business/src/timeline-audio-continuous.ts';
import type {NativeAudioSourceAdmission} from '../../../packages/business/src/native-audio-preview.ts';

interface Service {
  consumeBlock(input: unknown, context: {signal?: AbortSignal; onResourceSettlement?: (settlement: Promise<void>) => void;
    consume: (decoded: {pcm: Buffer}, context: ContinuousAudioConsumeContext) => Promise<void>}): Promise<unknown>;
  retireSession(input: unknown): Promise<void>;
}
interface NativeAdmission {
  acceptContinuous(req: IncomingMessage, res: ServerResponse, url: URL, input: ContinuousAudioBlockInput): NativeAudioSourceAdmission;
}
const fail = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error('Continuous audio request is unavailable.'), {code, status});
function inputFromUrl(url: URL): ContinuousAudioBlockInput {
  const keys = ['projectId', 'timelineId', 'expectedRevision', 'startFrame', 'planHash', 'sessionId', 'generation', 'sequence', 'blockStartFrame'];
  const actual = [...url.searchParams.keys()];
  if (actual.length !== keys.length || new Set(actual).size !== keys.length || actual.some(key => !keys.includes(key))) throw fail('AUDIO_PREVIEW_INVALID_INPUT', 400);
  const raw: Record<string, unknown> = Object.fromEntries(url.searchParams);
  for (const key of ['expectedRevision', 'startFrame', 'generation', 'sequence', 'blockStartFrame']) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(String(raw[key]))) throw fail('AUDIO_PREVIEW_INVALID_INPUT', 400);
    raw[key] = Number(raw[key]);
  }
  const parsed = continuousAudioBlockInputSchema.safeParse(raw);
  if (!parsed.success || url.search !== `?${continuousAudioQuery(parsed.data)}`) throw fail('AUDIO_PREVIEW_INVALID_INPUT', 400);
  return parsed.data;
}
/** This route is installed after ordinary Host/Origin/session authentication
 * and before V1's prefix router. The response owns the sole mixed Buffer until
 * observed finish/close; destroy() alone never releases its resource permit. */
export function createTimelineAudioContinuousHttp({service, nativeAdmission, signal, assertAvailable}: {
  service: Service; nativeAdmission?: NativeAdmission; signal?: AbortSignal; assertAvailable: () => void;
}) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== CONTINUOUS_AUDIO_ENDPOINT) return false;
    const controller = new AbortController(), abort = (): void => controller.abort();
    const closed = (): void => {if (!res.writableFinished) abort();};
    req.once('aborted', abort); res.once('close', closed);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let admission: NativeAudioSourceAdmission | undefined;
    try {
      assertAvailable();
      if (!['GET', 'DELETE'].includes(req.method ?? '')) {res.setHeader('Allow', 'GET, DELETE'); throw fail('METHOD_NOT_ALLOWED', 405);}
      if (Buffer.byteLength(req.url ?? '') > 2048 || req.headers['transfer-encoding'] ||
          req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' ||
          url.hash || req.url !== `${url.pathname}${url.search}`) throw fail('AUDIO_PREVIEW_INVALID_INPUT', 400);
      const input = inputFromUrl(url);
      admission = nativeAdmission?.acceptContinuous(req, res, url, input);
      if (req.method === 'DELETE') {
        const settlement = service.retireSession(input);
        admission?.onResourceSettlement(settlement);
        await settlement;
        if (combined.aborted || res.destroyed) throw fail('OPERATION_CANCELLED');
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(JSON.stringify({ok: true, status: 'retired'}));
      } else {
        const attemptSignal = admission ? AbortSignal.any([combined, admission.signal]) : combined;
        await service.consumeBlock(input, {signal: attemptSignal,
          ...(admission ? {onResourceSettlement: admission.onResourceSettlement} : {}),
          consume: async ({pcm}, context) => {
            context.beforeEffect();
            if (!Buffer.isBuffer(pcm) || pcm.length !== context.sampleFrames * 8) throw fail('AUDIO_PREVIEW_INVALID_PCM');
            await new Promise<void>((resolve, reject) => {
              let settled = false, transportError: unknown;
              const finish = (error?: unknown): void => {
                if (settled) return; settled = true;
                res.off('finish', complete); res.off('close', lost); res.off('error', broken); context.signal.removeEventListener('abort', cancel);
                if (error) reject(error); else resolve();
              };
              const complete = (): void => finish(transportError);
              const lost = (): void => finish(transportError ?? fail('AUDIO_PREVIEW_ABORTED'));
              const cancel = (): void => {transportError = fail('AUDIO_PREVIEW_ABORTED'); res.destroy();};
              const broken = (): void => {transportError = fail('AUDIO_PREVIEW_ABORTED'); res.destroy();};
              res.once('finish', complete); res.once('close', lost); res.once('error', broken); context.signal.addEventListener('abort', cancel, {once: true});
              if (context.signal.aborted || res.destroyed) {cancel(); return;}
              try {
                context.beforeEffect();
                res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': String(pcm.length), 'Cache-Control': 'no-store',
                  [HEADERS.profile]: context.plan.profileId, [HEADERS.planHash]: context.plan.planHash,
                  [HEADERS.session]: input.sessionId, [HEADERS.generation]: String(input.generation), [HEADERS.sequence]: String(input.sequence),
                  [HEADERS.startFrame]: String(context.startFrame), [HEADERS.endFrame]: String(context.endFrame), [HEADERS.sampleFrames]: String(context.sampleFrames)});
                res.end(pcm);
              } catch {cancel();}
            });
            context.beforeEffect();
          }});
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed && !res.writableEnded) {
        const value = error as {code?: unknown; status?: unknown};
        const code = typeof value?.code === 'string' && /^(?:AUDIO_PREVIEW_[A-Z_]+|OPERATION_CANCELLED|RESTORE_OPERATION_UNAVAILABLE|METHOD_NOT_ALLOWED)$/u.test(value.code) ? value.code : 'AUDIO_PREVIEW_UNAVAILABLE';
        const status = typeof value?.status === 'number' && [400, 403, 404, 405, 409, 413, 429, 503].includes(value.status) ? value.status : 409;
        res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(JSON.stringify({ok: false, error: {code, message: 'Continuous audio request is unavailable.', details: {}, retryable: false}}));
      }
    } finally {admission?.finish(); req.off('aborted', abort); res.off('close', closed);}
    return true;
  };
}
