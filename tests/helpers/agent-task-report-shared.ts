// Pure workload construction and simulated clock shared by historical and
// current Mio reports. Importing it never loads a store, writer or old schema.
import {mock} from 'node:test';
import {AGENT_TASK_LOADABLE_TOOL_GROUP_IDS} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskLoadableToolGroupId} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';

export interface ContextReportOptions {
  protocols?: readonly AgentProtocol[];
  toolRounds?: number;
  replyBytes?: number;
  deltaBytes?: number;
  stress30Steps?: boolean;
  deltaIntervalMs?: number;
  tailPauseMs?: number;
  officialPresets?: boolean;
  cachePrefixReport?: boolean;
  virtualCacheBoundaries?: boolean;
  loadToolGroups?: readonly AgentTaskLoadableToolGroupId[];
  /** Explicit fixture counters, never inferred tokenization or provider usage. */
  syntheticUsage?: readonly (ReportTokenUsage | null)[];
}
export type ReportTokenUsage = Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens', number>>;
export type ReportScenario = {toolRounds: number; replyBytes: number; deltaBytes: number; stepLimit: number; stress30Steps?: true; toolResultBytes?: number; firstRoundToolCalls?: number; deltaIntervalMs?: number; tailPauseMs?: number; officialPresets?: true; cachePrefixReport?: true; virtualCacheBoundaries?: true; loadToolGroups?: readonly AgentTaskLoadableToolGroupId[]; syntheticUsage?: true};

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}
export function contextReportScenario(options: ContextReportOptions = {}): ReportScenario {
  if (options.deltaIntervalMs !== undefined && (!Number.isSafeInteger(options.deltaIntervalMs) || options.deltaIntervalMs < 0 || options.deltaIntervalMs > 60_000)) throw new Error('deltaIntervalMs must be an integer from 0 to 60000');
  if (options.tailPauseMs !== undefined && (options.deltaIntervalMs === undefined || !Number.isSafeInteger(options.tailPauseMs) || options.tailPauseMs < 0 || options.tailPauseMs > 60_000)) throw new Error('tailPauseMs requires deltaIntervalMs and must be an integer from 0 to 60000');
  if (options.loadToolGroups !== undefined && (!options.loadToolGroups.length || options.loadToolGroups.some(group => !AGENT_TASK_LOADABLE_TOOL_GROUP_IDS.includes(group)))) throw new Error('Select supported loadable tool groups');
  const streaming = {...(options.deltaIntervalMs === undefined ? {} : {deltaIntervalMs: options.deltaIntervalMs, ...(options.tailPauseMs === undefined ? {} : {tailPauseMs: options.tailPauseMs})}), ...(options.officialPresets ? {officialPresets: true as const} : {}), ...(options.cachePrefixReport ? {cachePrefixReport: true as const} : {}), ...(options.virtualCacheBoundaries ? {virtualCacheBoundaries: true as const} : {}), ...(options.loadToolGroups ? {loadToolGroups: [...options.loadToolGroups]} : {}), ...(options.syntheticUsage ? {syntheticUsage: true as const} : {})};
  if (options.stress30Steps) {
    if (options.loadToolGroups) throw new Error('stress30Steps has a fixed workload without group loading');
    if (options.toolRounds !== undefined || options.replyBytes !== undefined || options.deltaBytes !== undefined) throw new Error('stress30Steps has a fixed workload; do not combine it with toolRounds, replyBytes or deltaBytes');
    return {toolRounds: 14, replyBytes: 30 * 1024, deltaBytes: 3 * 1024, stepLimit: 30, stress30Steps: true, toolResultBytes: 20 * 1024, firstRoundToolCalls: 2, ...streaming};
  }
  return {toolRounds: positiveInteger(options.toolRounds ?? 14, 'toolRounds', 14), replyBytes: positiveInteger(options.replyBytes ?? 30 * 1024, 'replyBytes', TASK_MODEL_LIMITS.outputBytes), deltaBytes: positiveInteger(options.deltaBytes ?? 3 * 1024, 'deltaBytes', TASK_MODEL_LIMITS.outputBytes), stepLimit: 30, ...streaming};
}
export function modelOutput(protocol: AgentProtocol, text: string, calls: AgentTaskToolCall[], index: number, usage?: ReportTokenUsage | null): TaskModelOutput {
  let providerOutput: AgentTaskJson;
  if (protocol === 'chat_completions') {
    providerOutput = {role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})};
  } else if (protocol === 'responses') {
    providerOutput = [
      {type: 'message', id: `synthetic_message_${String(index).padStart(3, '0')}`, status: 'completed', role: 'assistant', content: [{type: 'output_text', text, annotations: []}]},
      ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'})),
    ];
  } else {
    providerOutput = {role: 'assistant', content: [{type: 'text', text}, ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]};
  }
  return {text, toolCalls: calls, providerOutput, ...(usage ? {usage} : {})};
}
export function advanceStreamingClock(milliseconds: number): void {
  // A single MockTimers.tick(400) invokes a 250 ms callback at Date.now()=400.
  // Millisecond ticks let scheduled flushes run at their actual fake deadline.
  for (let elapsed = 0; elapsed < milliseconds; elapsed++) mock.timers.tick(1);
}
