import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {mock} from 'node:test';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {AGENT_TASK_LOADABLE_TOOL_GROUP_IDS, AGENT_TASK_TOOLS_LOAD_NAME} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskLoadableToolGroupId} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {readAgentTaskStorage} from '../../packages/business/src/agent/task-storage-v2.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway, TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskStorageSnapshot} from '../../packages/contracts/src/agent-task-storage.ts';
import {createTestAuthorizations, authorizeTestScope} from './agent-authorizations.ts';
import {reportAnthropicPrefixes} from './agent-task-prefix-report.ts';
import type {AnthropicPrefixReport} from './agent-task-prefix-report.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
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
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
export type ReportTokenUsage = Partial<Record<typeof usageFields[number], number>>;
export function summarizeReportUsage(values: readonly (ReportTokenUsage | null)[]) {
  const knownTotals: ReportTokenUsage = {}, fields = Object.fromEntries(usageFields.map(field => [field, {reportedSteps: 0, missingSteps: values.length}])) as Record<typeof usageFields[number], {reportedSteps: number; missingSteps: number}>;
  for (const value of values) if (value) for (const field of usageFields) {
    const count = value[field]; if (count === undefined) continue;
    assert.ok(Number.isSafeInteger(count) && count >= 0, 'Usage counters must be nonnegative safe integers');
    const sum = (knownTotals[field] ?? 0) + count;
    assert.ok(Number.isSafeInteger(sum), 'Usage sum exceeded the exact integer range');
    knownTotals[field] = sum; fields[field].reportedSteps++; fields[field].missingSteps--;
  }
  const any = Object.keys(knownTotals).length > 0;
  return {
    knownTotals: any ? knownTotals : null,
    coverage: {modelSteps: values.length, reportedSteps: values.filter(value => value !== null).length, fields},
    cacheReadRate: fields.inputTokens.missingSteps === 0 && fields.cacheReadTokens.missingSteps === 0 && (knownTotals.inputTokens ?? 0) > 0 ? knownTotals.cacheReadTokens! / knownTotals.inputTokens! : null,
  };
}
interface RequestMeasurement {index: number; bytes: number; toolCount: number; cachePrefix?: AnthropicPrefixReport}
interface ModelStepMeasurement {
  index: number;
  status: string;
  storedDataBytes: number;
  requestBytes: number;
  historyBytes: number;
  textBytes: number;
  textEvents: number;
  usage?: ReportTokenUsage;
  streaming?: {flushes: StreamingFlushMeasurement[]; rowRewriteBytes: number; textEventBytes: number; beforeDone: {textBytes: number; textEvents: number}};
}
interface StreamingFlushMeasurement {atMs: number; deltaBytes: number; textBytes: number; rowRewriteBytes: number; textEventBytes: number}
interface TableMeasurement {
  name: string;
  rows: number;
  bytes: number;
  countedRows: boolean;
  countedBytes: boolean;
}
interface ToolStepMeasurement {index: number; toolName: string; status: string; storedDataBytes: number; resultBytes: number}
export interface ContextProtocolReport {
  protocol: AgentProtocol;
  run: {status: string; reason: string | null; stepsUsed: number; budget: number; textEvents: number};
  requests: RequestMeasurement[];
  modelSteps: ModelStepMeasurement[];
  retained: {quotaBytes: number; quotaRows: number; tables: TableMeasurement[]};
  capacity: {
    limits: AgentTaskStorageSnapshot['limits'];
    remaining: AgentTaskStorageSnapshot['remaining'];
    additionalEquivalentRunsByBytes: number | null;
    additionalEquivalentRunsByRows: number | null;
    additionalEquivalentRuns: number | null;
  };
  tokenUsage: ReportTokenUsage | null;
  usageKnownTotals: ReportTokenUsage | null;
  usageCoverage: ReturnType<typeof summarizeReportUsage>['coverage'];
  cacheReadRate: number | null;
  toolSteps?: ToolStepMeasurement[];
  streaming?: {clock: 'simulated'; deltaIntervalMs: number; tailPauseMs?: number; appendCalls: number; rowRewriteBytes: number; textEventBytes: number};
}
export interface ContextReport {
  version: 1;
  scenario: {toolRounds: number; replyBytes: number; deltaBytes: number; stepLimit: number; stress30Steps?: true; toolResultBytes?: number; firstRoundToolCalls?: number; deltaIntervalMs?: number; tailPauseMs?: number; officialPresets?: true; cachePrefixReport?: true; virtualCacheBoundaries?: true; loadToolGroups?: readonly AgentTaskLoadableToolGroupId[]; syntheticUsage?: true};
  modelLimits: typeof TASK_MODEL_LIMITS;
  measurement: {storage: string; capacity: string; streaming: string; tokens: string};
  protocols: ContextProtocolReport[];
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  return value;
}
export function contextReportScenario(options: ContextReportOptions = {}): ContextReport['scenario'] {
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
function modelOutput(protocol: AgentProtocol, text: string, calls: AgentTaskToolCall[], index: number, usage?: ReportTokenUsage | null): TaskModelOutput {
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
function tableGrowth(before: AgentTaskStorageSnapshot, after: AgentTaskStorageSnapshot): TableMeasurement[] {
  return after.tables.map(table => {
    const previous = before.tables.find(item => item.name === table.name);
    return {...table, rows: table.rows - (previous?.rows ?? 0), bytes: table.bytes - (previous?.bytes ?? 0)};
  });
}
const equivalentRuns = (remaining: number, growth: number): number | null => growth > 0 ? Math.floor(remaining / growth) : null;
function advanceStreamingClock(milliseconds: number): void {
  // A single MockTimers.tick(400) invokes a 250 ms callback at Date.now()=400.
  // Millisecond ticks let scheduled flushes run at their actual fake deadline.
  for (let elapsed = 0; elapsed < milliseconds; elapsed++) mock.timers.tick(1);
}

/** Uses a fresh disposable workspace and the real execution/journal/tool paths.
 * The only replacement is the model gateway, which never opens a socket. */
async function measureProtocol(protocol: AgentProtocol, scenario: ContextReport['scenario'], options: ContextReportOptions): Promise<ContextProtocolReport> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-harness-context-report-'));
  const store = openStore(root);
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  let tools: ReturnType<typeof createAgentTaskTools> | undefined;
  let runtime: ReturnType<typeof createAgentTaskRuntime> | undefined;
  try {
    const services = createServices(store, new Map());
    const project = record(await services.call('project.create', {name: 'Synthetic harness measurement'}));
    assert.ok(typeof project.id === 'string');
    const projectId = project.id;
    const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic')?.platforms.find(platform => platform.id === 'global');
    assert.ok(anthropic);
    const configuration = scenario.officialPresets ? protocol === 'anthropic_messages' ? {presetId: 'anthropic', platformId: anthropic.id, baseUrl: anthropic.baseUrl, model: anthropic.model, protocol} : {...DEFAULT_AGENT_CONFIGURATION, protocol} : {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
    const sessionSecret = scenario.officialPresets ? randomUUID() : null;
    const noSecret = (value: string) => assert.ok(sessionSecret === null || !value.includes(sessionSecret), 'Session credentials must not enter measurement artifacts');
    await settings.put({expectedRevision: 0, configuration, secret: sessionSecret === null ? {action: 'remove'} : {action: 'replace', storage: 'session', value: sessionSecret}});
    const authorizations = createTestAuthorizations(() => ({...store}), settings);
    await authorizeTestScope(authorizations, 'project_agent');
    const baseTools = createAgentTaskTools({store, services});
    tools = scenario.stress30Steps ? {
      ...baseTools,
      async execute(prepared: Parameters<typeof baseTools.execute>[0], context: Parameters<typeof baseTools.execute>[1]) {
        const outcome = await baseTools.execute(prepared, context);
        assert.equal(prepared.operation, 'project.inspect');
        assert.ok(outcome.result !== null && typeof outcome.result === 'object' && !Array.isArray(outcome.result));
        const result = {...outcome.result, syntheticContextPayload: ''};
        const paddingBytes = scenario.toolResultBytes! - Buffer.byteLength(JSON.stringify(result));
        assert.ok(paddingBytes >= 0, 'The actual observation is larger than the fixed synthetic result');
        result.syntheticContextPayload = 'x'.repeat(paddingBytes);
        assert.equal(Buffer.byteLength(JSON.stringify(result)), scenario.toolResultBytes);
        // Return through the ordinary runtime/journal path. The full padded
        // result is persisted, so view compression cannot fake storage savings.
        return {...outcome, result};
      },
    } : baseTools;
    const requests: RequestMeasurement[] = [];
    const flushes = new Map<string, StreamingFlushMeasurement[]>();
    const requestStarts = new Map<number, number>();
    const beforeDone = new Map<number, {textBytes: number; textEvents: number}>();
    let previousBody: string | undefined;
    const gateway: TaskGateway = async function* (request) {
      request.beforeSubmit?.();
      const body = record(JSON.parse(request.body));
      noSecret(request.body);
      if (scenario.officialPresets) assert.ok(request.apiKey === sessionSecret, 'Official measurement must use its in-memory session credential');
      const index = requests.length + 1;
      requestStarts.set(index, Date.now());
      requests.push({index, bytes: Buffer.byteLength(request.body), toolCount: Array.isArray(body.tools) ? body.tools.length : 0, ...(scenario.cachePrefixReport && protocol === 'anthropic_messages' ? {cachePrefix: reportAnthropicPrefixes(request.body, previousBody, {virtualBreakpoints: scenario.virtualCacheBoundaries})} : {})});
      previousBody = request.body;
      const text = 'x'.repeat(scenario.replyBytes);
      for (let offset = 0; offset < text.length; offset += scenario.deltaBytes) {
        if (scenario.deltaIntervalMs !== undefined) advanceStreamingClock(scenario.deltaIntervalMs);
        yield {type: 'delta', text: text.slice(offset, offset + scenario.deltaBytes)};
      }
      if (scenario.deltaIntervalMs !== undefined) {
        advanceStreamingClock(scenario.tailPauseMs ?? 0);
        const model = store.db.prepare("SELECT id,data FROM agent_task_steps_v2 WHERE json_extract(data,'$.kind')='model' ORDER BY position DESC LIMIT 1").get()!;
        const saved = record(JSON.parse(String(model.data)));
        beforeDone.set(index, {textBytes: typeof saved.text === 'string' ? Buffer.byteLength(saved.text) : 0, textEvents: Number(store.db.prepare("SELECT count(*) AS n FROM agent_task_events_v2 WHERE type='text' AND json_extract(data,'$.data.stepId')=?").get(String(model.id))!.n)});
      }
      const callCount = index <= scenario.toolRounds ? scenario.stress30Steps && index === 1 ? scenario.firstRoundToolCalls! : 1 : 0;
      const calls: AgentTaskToolCall[] = Array.from({length: callCount}, (_value, callIndex): AgentTaskToolCall => ({id: `synthetic_read_${String(index).padStart(3, '0')}${scenario.stress30Steps ? `_${callIndex + 1}` : ''}`, name: index === 1 && scenario.loadToolGroups ? AGENT_TASK_TOOLS_LOAD_NAME : 'mioon_project_inspect', arguments: index === 1 && scenario.loadToolGroups ? {groups: [...scenario.loadToolGroups]} : {}}));
      yield {type: 'done', output: modelOutput(protocol, text, calls, index, options.syntheticUsage?.[index - 1])};
    };
    runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
    if (scenario.deltaIntervalMs !== undefined) {
      const appendText = runtime.journal.appendText;
      runtime.journal.appendText = (runId, stepId, text) => {
        appendText(runId, stepId, text);
        // Read the actual row immediately after the real append. This counts
        // the complete data column rewritten by appendText, not only its delta.
        const row = store.db.prepare('SELECT data,length(CAST(data AS BLOB)) AS bytes FROM agent_task_steps_v2 WHERE id=?').get(stepId)!;
        const saved = record(JSON.parse(String(row.data)));
        const event = store.db.prepare("SELECT length(CAST(data AS BLOB)) AS bytes FROM agent_task_events_v2 WHERE runId=? AND type='text' ORDER BY sequence DESC LIMIT 1").get(runId)!;
        const values = flushes.get(stepId) ?? [];
        values.push({atMs: Date.now() - requestStarts.get(requests.length)!, deltaBytes: Buffer.byteLength(text), textBytes: typeof saved.text === 'string' ? Buffer.byteLength(saved.text) : 0, rowRewriteBytes: Number(row.bytes), textEventBytes: Number(event.bytes)});
        flushes.set(stepId, values);
      };
    }
    const before = readAgentTaskStorage(store.db);
    const sent = await runtime.send(projectId, {requestId: randomUUID(), expectedSettingsRevision: (await settings.get()).revision, locale: 'en', text: 'Inspect the current project repeatedly, then report completion. Synthetic offline context measurement.'});
    await runtime.drain();
    const snapshot = runtime.journal.snapshot(sent.run.id);
    assert.ok(requests.length > 0, `Measurement did not reach the synthetic gateway: ${snapshot.run.pauseReason ?? snapshot.run.status}`);
    const after = readAgentTaskStorage(store.db);
    const modelSteps = store.db.prepare("SELECT id,status,data,length(CAST(data AS BLOB)) AS bytes FROM agent_task_steps_v2 WHERE runId=? AND json_extract(data,'$.kind')='model' ORDER BY position").all(sent.run.id).map((row, index): ModelStepMeasurement => {
      const saved = record(JSON.parse(String(row.data)));
      noSecret(String(row.data));
      const request = record(saved.request);
      assert.equal(typeof request.body, 'string');
      const textEvents = Number(store.db.prepare("SELECT count(*) AS n FROM agent_task_events_v2 WHERE runId=? AND type='text' AND json_extract(data,'$.data.stepId')=?").get(sent.run.id, String(row.id))!.n);
      const appended = flushes.get(String(row.id)) ?? [];
      const result = saved.result === undefined ? undefined : record(saved.result);
      const usage = result?.usage === undefined ? undefined : record(result.usage) as ReportTokenUsage;
      return {index: index + 1, status: String(row.status), storedDataBytes: Number(row.bytes), requestBytes: Buffer.byteLength(request.body as string), historyBytes: Buffer.byteLength(JSON.stringify(request.history)), textBytes: typeof saved.text === 'string' ? Buffer.byteLength(saved.text) : 0, textEvents, ...(usage ? {usage} : {}), ...(scenario.deltaIntervalMs === undefined ? {} : {streaming: {flushes: appended, rowRewriteBytes: appended.reduce((sum, value) => sum + value.rowRewriteBytes, 0), textEventBytes: appended.reduce((sum, value) => sum + value.textEventBytes, 0), beforeDone: beforeDone.get(index + 1)!}})};
    });
    const quotaBytes = after.usage.bytes - before.usage.bytes;
    const quotaRows = after.usage.rows - before.usage.rows;
    const byBytes = equivalentRuns(after.remaining.bytes, quotaBytes), byRows = equivalentRuns(after.remaining.rows, quotaRows);
    const estimates = [byBytes, byRows].filter((value): value is number => value !== null);
    const toolSteps: ToolStepMeasurement[] | undefined = scenario.stress30Steps ? store.db.prepare("SELECT status,data,length(CAST(data AS BLOB)) AS bytes FROM agent_task_steps_v2 WHERE runId=? AND json_extract(data,'$.kind')='tool' ORDER BY position").all(sent.run.id).map((row, index) => {
      const saved = record(JSON.parse(String(row.data))), call = record(saved.toolCall);
      assert.equal(typeof call.name, 'string');
      return {index: index + 1, toolName: String(call.name), status: String(row.status), storedDataBytes: Number(row.bytes), resultBytes: saved.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(saved.result))};
    }) : undefined;
    const usage = summarizeReportUsage(modelSteps.map(step => step.usage ?? null));
    return {
      protocol,
      run: {status: snapshot.run.status, reason: snapshot.run.pauseReason ?? null, stepsUsed: snapshot.run.stepsUsed, budget: snapshot.run.budget, textEvents: modelSteps.reduce((sum, step) => sum + step.textEvents, 0)},
      requests, modelSteps,
      retained: {quotaBytes, quotaRows, tables: tableGrowth(before, after)},
      capacity: {limits: after.limits, remaining: after.remaining, additionalEquivalentRunsByBytes: byBytes, additionalEquivalentRunsByRows: byRows, additionalEquivalentRuns: estimates.length ? Math.min(...estimates) : null},
      tokenUsage: usage.knownTotals, usageKnownTotals: usage.knownTotals, usageCoverage: usage.coverage, cacheReadRate: usage.cacheReadRate,
      ...(toolSteps ? {toolSteps} : {}),
      ...(scenario.deltaIntervalMs === undefined ? {} : {streaming: {clock: 'simulated' as const, deltaIntervalMs: scenario.deltaIntervalMs, ...(scenario.tailPauseMs === undefined ? {} : {tailPauseMs: scenario.tailPauseMs}), appendCalls: modelSteps.reduce((sum, step) => sum + step.streaming!.flushes.length, 0), rowRewriteBytes: modelSteps.reduce((sum, step) => sum + step.streaming!.rowRewriteBytes, 0), textEventBytes: modelSteps.reduce((sum, step) => sum + step.streaming!.textEventBytes, 0)}}),
    };
  } finally {
    runtime?.close();
    tools?.dispose();
    await settings.close();
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
}

export async function collectAgentTaskContextReport(options: ContextReportOptions = {}): Promise<ContextReport> {
  const scenario = contextReportScenario(options);
  const selected = options.protocols ?? protocols;
  if (!selected.length || selected.some(protocol => !protocols.includes(protocol))) throw new Error('Select at least one supported protocol');
  const reports: ContextProtocolReport[] = [];
  if (scenario.deltaIntervalMs !== undefined) mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1)});
  try {
    for (const protocol of selected) reports.push(await measureProtocol(protocol, scenario, options));
  } finally {
    if (scenario.deltaIntervalMs !== undefined) mock.timers.reset();
  }
  return {
    version: 1, scenario, modelLimits: TASK_MODEL_LIMITS,
    measurement: {
      storage: 'Retained UTF-8 bytes in SQLite data columns, using the production quota inventory. Excludes SQLite page/WAL overhead and cumulative rewrites of the same row.',
      capacity: 'Additional equivalent runs estimated independently from remaining byte and row quotas; the lower bound wins. This is not a guarantee for different workloads.',
      streaming: scenario.deltaIntervalMs === undefined ? 'Synthetic deltas are emitted without sleeps or a controlled clock; flushes follow the current runtime thresholds and host speed.' : 'Date and setTimeout are simulated at a fixed epoch; the clock advances in 1 ms ticks by deltaIntervalMs before each delta and by optional tailPauseMs before done, without real waiting, so deadline callbacks run at their actual fake time. beforeDone records persisted text and text-event counts before completion. Rewrite bytes sum the actual complete model-step data column after each successful appendText; text-event bytes count the inserted event data. Excludes other step updates, SQLite pages, indexes and WAL overhead. Retained quota bytes remain a separate measurement.',
      tokens: 'Reads normalized usage from actual private model-step results, once per completed model step. Missing fields stay unknown; known totals include only reported fields and coverage identifies incomplete totals. Default synthetic output has no usage or tokenizer, so tokenUsage remains null. Explicit syntheticUsage fixtures are marked in scenario; offline prefix bytes are not tokens or observed cache hits.',
    },
    protocols: reports,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {protocol: {type: 'string', default: 'all'}, 'tool-rounds': {type: 'string'}, 'reply-bytes': {type: 'string'}, 'delta-bytes': {type: 'string'}, 'delta-interval-ms': {type: 'string'}, 'tail-pause-ms': {type: 'string'}, 'stress-30-steps': {type: 'boolean', default: false}, 'official-presets': {type: 'boolean', default: false}, 'cache-prefix-report': {type: 'boolean', default: false}, 'virtual-cache-boundaries': {type: 'boolean', default: false}, 'load-groups': {type: 'string'}, output: {type: 'string'}}});
  const selected = values.protocol === 'all' ? protocols : protocols.filter(protocol => protocol === values.protocol);
  const report = await collectAgentTaskContextReport({protocols: selected, ...(values['tool-rounds'] ? {toolRounds: Number(values['tool-rounds'])} : {}), ...(values['reply-bytes'] ? {replyBytes: Number(values['reply-bytes'])} : {}), ...(values['delta-bytes'] ? {deltaBytes: Number(values['delta-bytes'])} : {}), ...(values['delta-interval-ms'] !== undefined ? {deltaIntervalMs: Number(values['delta-interval-ms'])} : {}), ...(values['tail-pause-ms'] !== undefined ? {tailPauseMs: Number(values['tail-pause-ms'])} : {}), ...(values['stress-30-steps'] ? {stress30Steps: true} : {}), ...(values['official-presets'] ? {officialPresets: true} : {}), ...(values['cache-prefix-report'] ? {cachePrefixReport: true} : {}), ...(values['virtual-cache-boundaries'] ? {virtualCacheBoundaries: true} : {}), ...(values['load-groups'] ? {loadToolGroups: values['load-groups'].split(',') as AgentTaskLoadableToolGroupId[]} : {})});
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json);
  else process.stdout.write(json);
}
