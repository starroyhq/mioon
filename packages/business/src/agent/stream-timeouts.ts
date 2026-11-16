import type {AgentConfiguration} from './config.ts';
import {agentModelAdaptation, agentRequestThinks} from './model-profiles.ts';

export const AGENT_DEFAULT_STREAM_TIMEOUTS = Object.freeze({
  firstResponseTimeoutMs: 20_000,
  readTimeoutMs: 20_000,
  totalTimeoutMs: 120_000,
});
const thinkingTimeouts = Object.freeze({
  firstResponseTimeoutMs: 90_000,
  readTimeoutMs: 45_000,
  totalTimeoutMs: 240_000,
});
export type AgentStreamTimeoutMode = 'mio_task';

/** Give recognized reasoning tasks time to process a large prompt before the
 * first text, thought or tool fragment. Draft checks and generic endpoints
 * keep their existing budget. Match the exact frozen request, as in replay. */
export function agentStreamTimeouts(configuration: AgentConfiguration, body: string, mode?: AgentStreamTimeoutMode) {
  if (mode !== 'mio_task' || configuration.presetId === 'ollama' ||
      agentModelAdaptation(configuration) !== 'adapted') return AGENT_DEFAULT_STREAM_TIMEOUTS;
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return AGENT_DEFAULT_STREAM_TIMEOUTS; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return AGENT_DEFAULT_STREAM_TIMEOUTS;
  const request = raw as Record<string, unknown>;
  return request.model === configuration.model && request.stream === true && agentRequestThinks(configuration, request)
    ? thinkingTimeouts : AGENT_DEFAULT_STREAM_TIMEOUTS;
}

// SDK fetch deadlines must leave the pinned transport time to report the
// actual timeout phase. The host always enforces its own per-request limit.
export function agentSdkTimeoutMs(mode?: AgentStreamTimeoutMode): number {
  return (mode === 'mio_task' ? thinkingTimeouts : AGENT_DEFAULT_STREAM_TIMEOUTS).totalTimeoutMs + 1_000;
}
