import {AGENT_TIMELINE_GAIN_CONTEXT} from '@mioon/contracts/agent-timeline-gain';
import {TIMELINE_GAIN_EDIT_TOOL_LIMITS} from './timeline-gain-tool-policy.ts';
import {agentSubmissionFenceFailure as failure, invokeAgentSubmissionFence} from './submission-fence.ts';
export {invokeAgentSubmissionFence} from './submission-fence.ts';
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
