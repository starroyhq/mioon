import {isPrevisMutationResponse} from '@mioon/contracts';
import type {PrevisNodeRecord} from '@mioon/contracts';

// Adding a previs node from the canvas toolbar. The request keeps one stable
// requestId: its receipt is kept for good, so resending after an uncertain
// answer (network, server error, malformed reply) can only replay the same node.
const RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);
export type PrevisCreateOutcome =
  | {readonly status: 'created'; readonly node: PrevisNodeRecord}
  | {readonly status: 'failed'; readonly code: string}
  | {readonly status: 'unknown'};
export interface PrevisCreateOptions {
  readonly rpc: (operation: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly requestId: () => string;
  readonly wait?: (ms: number) => Promise<void>;
}
interface Failure {code?: unknown; status?: unknown}
const definite = (error: unknown): boolean => {
  const failure = (error ?? {}) as Failure, status = typeof failure.status === 'number' ? failure.status : undefined;
  return failure.code === 'PREVIS_CAPACITY' || status !== undefined && status < 500 && failure.code !== 'NETWORK';
};
export async function createPrevisNode(request: {projectId: string; label: string; position: {x: number; y: number}}, options: PrevisCreateOptions): Promise<PrevisCreateOutcome> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
  const input = {projectId: request.projectId, label: request.label, position: {x: Math.round(request.position.x), y: Math.round(request.position.y)}, requestId: options.requestId()};
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await options.rpc('previs.create', input);
      if (isPrevisMutationResponse('previs.create', input, result)) return {status: 'created', node: result as PrevisNodeRecord};
    } catch (error) {
      if (definite(error)) { const code = (error as Failure).code; return {status: 'failed', code: typeof code === 'string' ? code : 'PREVIS_CREATE_FAILED'}; }
    }
    if (attempt >= RETRY_DELAYS_MS.length) return {status: 'unknown'};
    await wait(RETRY_DELAYS_MS[attempt]!);
  }
}
