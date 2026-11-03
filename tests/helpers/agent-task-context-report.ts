import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {mock} from 'node:test';
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME, agentTaskToolNamesForGroup} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskLoadableToolGroupId} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {readMioStorage} from '../../packages/business/src/agent/mio-storage.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {MioStorageSnapshot} from '../../packages/contracts/src/mio-storage.ts';
import {createTestAuthorizations, authorizeTestScope} from './agent-authorizations.ts';
import {reportAnthropicPrefixes} from './agent-task-prefix-report.ts';
import type {AnthropicPrefixReport} from './agent-task-prefix-report.ts';

import {advanceStreamingClock, contextReportScenario, modelOutput} from './agent-task-report-shared.ts';
import type {ContextReportOptions, ReportScenario, ReportTokenUsage} from './agent-task-report-shared.ts';
export {advanceStreamingClock, contextReportScenario, modelOutput} from './agent-task-report-shared.ts';
export type {ContextReportOptions, ReportTokenUsage} from './agent-task-report-shared.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
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
  checkpointEvents: number;
  usage?: ReportTokenUsage;
  streaming?: {flushes: StreamingFlushMeasurement[]; checkpointRewriteBytes: number; invalidationEventBytes: number; beforeDone: {textBytes: number; checkpointEvents: number}};
}
interface StreamingFlushMeasurement {atMs: number; deltaBytes: number; textBytes: number; checkpointRewriteBytes: number; invalidationEventBytes: number}
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
  run: {status: string; reason: string | null; stepsUsed: number; budget: number; checkpointEvents: number};
  requests: RequestMeasurement[];
  modelSteps: ModelStepMeasurement[];
  retained: {quotaBytes: number; quotaRows: number; tables: TableMeasurement[]};
  capacity: {
    limits: MioStorageSnapshot['limits'];
    remaining: MioStorageSnapshot['remaining'];
    additionalEquivalentRunsByBytes: number | null;
    additionalEquivalentRunsByRows: number | null;
    additionalEquivalentRuns: number | null;
  };
  tokenUsage: ReportTokenUsage | null;
  usageKnownTotals: ReportTokenUsage | null;
  usageCoverage: ReturnType<typeof summarizeReportUsage>['coverage'];
  cacheReadRate: number | null;
  toolSteps?: ToolStepMeasurement[];
  streaming?: {clock: 'simulated'; deltaIntervalMs: number; tailPauseMs?: number; appendCalls: number; checkpointRewriteBytes: number; invalidationEventBytes: number};
}
export interface ContextReport {
  version: 1;
  scenario: ReportScenario;
  modelLimits: typeof TASK_MODEL_LIMITS;
  measurement: {storage: string; capacity: string; streaming: string; tokens: string};
  protocols: ContextProtocolReport[];
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function tableGrowth(before: MioStorageSnapshot, after: MioStorageSnapshot): TableMeasurement[] {
  return after.tables.map(table => {
    const previous = before.tables.find(item => item.name === table.name);
    return {...table, rows: table.rows - (previous?.rows ?? 0), bytes: table.bytes - (previous?.bytes ?? 0)};
  });
}
const equivalentRuns = (remaining: number, growth: number): number | null => growth > 0 ? Math.floor(remaining / growth) : null;


/** Uses a fresh disposable kernel and the real execution/journal/tool paths.
 * The only replacement is the model gateway, which never opens a socket. */
async function measureProtocol(protocol: AgentProtocol, scenario: ContextReport['scenario'], options: ContextReportOptions): Promise<ContextProtocolReport> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-harness-context-report-'));
  const store = openStore(root),records=createMioRecords(store);
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  let services:ReturnType<typeof createServices>|undefined;
  let tools: ReturnType<typeof createAgentTaskTools> | undefined;
  let runtime: ReturnType<typeof createAgentTaskRuntime> | undefined;
  try {
    services = createServices(store, new Map());
    const project = record(await services.call('project.create', {name: 'Synthetic harness measurement'}));
    assert.ok(typeof project.id === 'string');
    const projectId = project.id;
    const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic')?.platforms.find(platform => platform.id === 'global');
    assert.ok(anthropic);
    const configuration = scenario.officialPresets ? protocol === 'anthropic_messages' ? {presetId: 'anthropic', platformId: anthropic.id, baseUrl: anthropic.baseUrl, model: anthropic.model, protocol} : {...DEFAULT_AGENT_CONFIGURATION, protocol} : {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
    const sessionSecret = scenario.officialPresets ? randomUUID() : null;
    const noSecret = (value: string) => assert.ok(sessionSecret === null || !value.includes(sessionSecret), 'Session credentials must not enter measurement artifacts');
    await settings.put({expectedRevision: 0, configuration, secret: sessionSecret === null ? {action: 'remove'} : {action: 'replace', storage: 'session', value: sessionSecret}});
    const authorizations = createTestAuthorizations(() => store, settings);
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
    const beforeDone = new Map<number, {textBytes: number; checkpointEvents: number}>();
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
        const model=store.db.prepare("SELECT id,partialText FROM mio_steps WHERE kind='model' ORDER BY position DESC LIMIT 1").get()!;
        const text=model.partialText===null?'':JSON.parse(String(model.partialText));
        beforeDone.set(index,{textBytes:Buffer.byteLength(text),checkpointEvents:(flushes.get(String(model.id))??[]).length});
      }
      const callCount = index <= scenario.toolRounds ? scenario.stress30Steps && index === 1 ? scenario.firstRoundToolCalls! : 1 : 0;
      const calls: AgentTaskToolCall[] = Array.from({length: callCount}, (_value, callIndex): AgentTaskToolCall => ({id: `synthetic_read_${String(index).padStart(3, '0')}${scenario.stress30Steps ? `_${callIndex + 1}` : ''}`, name: index === 1 && scenario.loadToolGroups ? AGENT_TASK_TOOLS_LOAD_NAME : 'mioon_project_inspect', arguments: index === 1 && scenario.loadToolGroups ? {names: scenario.loadToolGroups.flatMap(group=>agentTaskToolNamesForGroup(group))} : {}}));
      yield {type: 'done', output: modelOutput(protocol, text, calls, index, options.syntheticUsage?.[index - 1])};
    };
    runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
    if (scenario.deltaIntervalMs !== undefined) {
      const appendText = runtime.journal.appendText;
      runtime.journal.appendText = (runId, stepId, textDelta) => {
        const sequence=Number(store.db.prepare('SELECT coalesce(max(sequence),0) AS n FROM mio_events WHERE runId=?').get(runId)!.n);
        appendText(runId, stepId, textDelta);
        // Read actual mutable checkpoint columns; no complete wire request or
        // stream-text event exists in the native journal.
        const row=store.db.prepare('SELECT partialText,length(CAST(partialText AS BLOB))+length(CAST(data AS BLOB))+length(CAST(updatedAt AS BLOB))+length(CAST(status AS BLOB)) AS bytes FROM mio_steps WHERE id=?').get(stepId)!;
        const text=row.partialText===null?'':JSON.parse(String(row.partialText));
        const event=store.db.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(runId AS BLOB))+length(CAST(sequence AS BLOB))+length(CAST(createdAt AS BLOB))),0) AS bytes FROM mio_events WHERE runId=? AND sequence>?").get(runId,sequence)!;
        assert.equal(Number(event.rows),1,'Every real checkpoint commits exactly one new native invalidation');
        const values = flushes.get(stepId) ?? [];
        values.push({atMs:Date.now()-requestStarts.get(requests.length)!,deltaBytes:Buffer.byteLength(textDelta),textBytes:Buffer.byteLength(text),checkpointRewriteBytes:Number(row.bytes),invalidationEventBytes:Number(event.bytes)});
        flushes.set(stepId, values);
      };
    }
    const before = readMioStorage(store.db);
    const sent = await runtime.send(projectId, {requestId: randomUUID(), expectedSettingsRevision: (await settings.get()).revision, locale: 'en', text: 'Inspect the current project repeatedly, then report completion. Synthetic offline context measurement.'});
    await runtime.drain();
    const snapshot = runtime.journal.snapshot(sent.run.id);
    assert.ok(requests.length > 0, `Measurement did not reach the synthetic gateway: ${snapshot.run.pauseReason ?? snapshot.run.status}`);
    const after = readMioStorage(store.db);
    const storedStepBytes=(stepId:string):number=>{
      const row=store.db.prepare(`SELECT length(CAST(s.data AS BLOB))+coalesce(length(CAST(e.payloadJson AS BLOB)),b.bytes,0) AS bytes FROM mio_steps s LEFT JOIN mio_entries e ON e.id=s.resultEntryId LEFT JOIN mio_blobs b ON b.sha256=e.payloadBlobHash WHERE s.id=?`).get(stepId)!;
      return Number(row.bytes);
    };
    const modelSteps=records.steps(sent.run.id).filter(step=>step.kind==='model').map((row,index):ModelStepMeasurement=>{
      const saved=runtime!.journal.step(row.id),request=record(saved.request);
      noSecret(JSON.stringify(saved));assert.equal(typeof request.body,'string');
      const appended=flushes.get(row.id)??[],result=saved.result===undefined?undefined:record(saved.result),usage=result?.usage===undefined?undefined:record(result.usage) as ReportTokenUsage;
      return {index:index+1,status:row.status,storedDataBytes:storedStepBytes(row.id),requestBytes:Buffer.byteLength(request.body as string),historyBytes:Buffer.byteLength(JSON.stringify(request.history)),textBytes:typeof saved.text==='string'?Buffer.byteLength(saved.text):0,checkpointEvents:appended.length,...(usage?{usage}:{}),...(scenario.deltaIntervalMs===undefined?{}:{streaming:{flushes:appended,checkpointRewriteBytes:appended.reduce((sum,value)=>sum+value.checkpointRewriteBytes,0),invalidationEventBytes:appended.reduce((sum,value)=>sum+value.invalidationEventBytes,0),beforeDone:beforeDone.get(index+1)!}})};
    });
    const quotaBytes = after.usage.bytes - before.usage.bytes;
    const quotaRows = after.usage.rows - before.usage.rows;
    const byBytes = equivalentRuns(after.remaining.bytes, quotaBytes), byRows = equivalentRuns(after.remaining.rows, quotaRows);
    const estimates = [byBytes, byRows].filter((value): value is number => value !== null);
    const toolSteps:ToolStepMeasurement[]|undefined=scenario.stress30Steps?records.steps(sent.run.id).filter(step=>step.kind==='tool').map((row,index)=>{
      const saved=runtime!.journal.step(row.id),call=record(saved.toolCall);assert.equal(typeof call.name,'string');
      return {index:index+1,toolName:String(call.name),status:row.status,storedDataBytes:storedStepBytes(row.id),resultBytes:saved.result===undefined?0:Buffer.byteLength(JSON.stringify(saved.result))};
    }):undefined;
    const usage = summarizeReportUsage(modelSteps.map(step => step.usage ?? null));
    return {
      protocol,
      run: {status: snapshot.run.status, reason: snapshot.run.pauseReason ?? null, stepsUsed: snapshot.run.stepsUsed, budget: snapshot.run.budget, checkpointEvents: modelSteps.reduce((sum, step) => sum + step.checkpointEvents, 0)},
      requests, modelSteps,
      retained: {quotaBytes, quotaRows, tables: tableGrowth(before, after)},
      capacity: {limits: after.limits, remaining: after.remaining, additionalEquivalentRunsByBytes: byBytes, additionalEquivalentRunsByRows: byRows, additionalEquivalentRuns: estimates.length ? Math.min(...estimates) : null},
      tokenUsage: usage.knownTotals, usageKnownTotals: usage.knownTotals, usageCoverage: usage.coverage, cacheReadRate: usage.cacheReadRate,
      ...(toolSteps ? {toolSteps} : {}),
      ...(scenario.deltaIntervalMs === undefined ? {} : {streaming: {clock: 'simulated' as const, deltaIntervalMs: scenario.deltaIntervalMs, ...(scenario.tailPauseMs === undefined ? {} : {tailPauseMs: scenario.tailPauseMs}), appendCalls: modelSteps.reduce((sum, step) => sum + step.streaming!.flushes.length, 0), checkpointRewriteBytes: modelSteps.reduce((sum, step) => sum + step.streaming!.checkpointRewriteBytes, 0), invalidationEventBytes: modelSteps.reduce((sum, step) => sum + step.streaming!.invalidationEventBytes, 0)}}),
    };
  } finally {
    runtime?.close();
    await runtime?.drain();
    tools?.dispose();
    await services?.drain();
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
      storage: 'Retained native Mio UTF-8 scalar/blob bytes, using the production per-project quota inventory. Excludes SQLite page/WAL overhead and cumulative rewrites of the same row.',
      capacity: 'Additional equivalent runs estimated independently from remaining byte and row quotas; the lower bound wins. This is not a guarantee for different workloads.',
      streaming: scenario.deltaIntervalMs === undefined ? 'Synthetic deltas are emitted without sleeps or a controlled clock; flushes follow the current runtime thresholds and host speed.' : 'Date and setTimeout are simulated at a fixed epoch; the clock advances in 1 ms ticks by deltaIntervalMs before each delta and by optional tailPauseMs before done, without real waiting, so deadline callbacks run at their actual fake time. beforeDone records persisted partialText and checkpoint counts before completion. Checkpoint bytes sum actual partialText/data/status/updatedAt columns after each successful appendText; invalidation bytes count actual mio_events scalars, without duplicate stream text. Excludes other step updates, SQLite pages, indexes and WAL overhead. Retained quota bytes remain a separate measurement.',
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
