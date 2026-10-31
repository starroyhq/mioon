/** Trusted synchronous send boundary. No renderer/provider DTO can install it. */
type FenceFailure = Error & {code: string; status: number};
export const agentSubmissionFenceFailure = (aborted = false): FenceFailure => Object.assign(new Error(aborted
  ? '聊天已停止；这不保证远端计算或计费已经停止。'
  : '所选片段的已保存内容或归属已改变，本轮没有继续发送模型请求。此前已发送的请求仍可能计费。'),
  {code: aborted ? 'AGENT_CHAT_ABORTED' : 'AGENT_CHAT_CONTEXT_CHANGED', status: aborted ? 499 : 409});
const isAbort = (value: unknown): boolean => value instanceof Error && 'code' in value && value.code === 'AGENT_CHAT_ABORTED';
export function invokeAgentSubmissionFence(fence: unknown): void {
  if (fence === undefined) return;
  if (typeof fence !== 'function') throw agentSubmissionFenceFailure();
  try {
    const result: unknown = fence();
    if (result !== undefined) {
      // An async guard cannot certify the next synchronous socket write.
      if (result instanceof Promise) void result.catch(() => {});
      throw agentSubmissionFenceFailure();
    }
  } catch (error: unknown) { throw agentSubmissionFenceFailure(isAbort(error)); }
}
