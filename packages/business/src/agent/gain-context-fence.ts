import {AGENT_TIMELINE_GAIN_CONTEXT} from '@mioon/contracts/agent-timeline-gain';
import {TIMELINE_GAIN_EDIT_TOOL_LIMITS} from './timeline-gain-tool-policy.ts';
/** Trusted synchronous send boundary. No renderer/provider DTO can install it. */
type FenceFailure = Error & {code: string; status: number};
const failure = (aborted = false): FenceFailure => Object.assign(new Error(aborted
  ? '聊天已停止；这不保证远端计算或计费已经停止。'
  : '所选片段的已保存内容或归属已改变，本轮没有继续发送模型请求。此前已发送的请求仍可能计费。'),
  {code: aborted ? 'AGENT_CHAT_ABORTED' : 'AGENT_CHAT_CONTEXT_CHANGED', status: aborted ? 499 : 409});
const isAbort = (value: unknown): boolean => value instanceof Error && 'code' in value && value.code === 'AGENT_CHAT_ABORTED';
export function invokeAgentSubmissionFence(fence: unknown): void {
  if (fence === undefined) return;
  if (typeof fence !== 'function') throw failure();
  try {
    const result: unknown = fence();
    if (result !== undefined) {
      // An async guard cannot certify the next synchronous socket write.
      if (result instanceof Promise) void result.catch(() => {});
      throw failure();
    }
  } catch (error: unknown) { throw failure(isAbort(error)); }
}
export function createAgentGainContextFence(options: Readonly<{live: () => boolean; checkTarget: () => unknown}>): () => void {
  return () => {
    if (!options.live()) throw failure(true);
    invokeAgentSubmissionFence(options.checkTarget);
  };
}

/** Only the new gain scope applies these complete serialized-request bounds. */
export function assertAgentGainRequestBudget(body: string, readTools: Readonly<{scope?: string; phase?: string}> | undefined): void {
  if (readTools?.scope !== AGENT_TIMELINE_GAIN_CONTEXT) return;
  const limit = readTools.phase === 'answer' ? TIMELINE_GAIN_EDIT_TOOL_LIMITS.maxContinuationBytes : TIMELINE_GAIN_EDIT_TOOL_LIMITS.maxContextBytes;
  if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('本轮请求超出音量提案的安全容量。'), {code: 'AGENT_CHAT_LIMIT', status: 413});
}
