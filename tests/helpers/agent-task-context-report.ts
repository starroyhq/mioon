import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {readAgentTaskStorage} from '../../packages/business/src/agent/task-storage-v2.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway, TaskModelOutput} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskStorageSnapshot} from '../../packages/contracts/src/agent-task-storage.ts';
import {createTestAuthorizations, authorizeTestScope} from './agent-authorizations.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
export interface ContextReportOptions {
  protocols?: readonly AgentProtocol[];
  toolRounds?: number;
  replyBytes?: number;
  deltaBytes?: number;
}
interface RequestMeasurement {index: number; bytes: number; toolCount: number}
interface ModelStepMeasurement {
  index: number;
  status: string;
  storedDataBytes: number;
  requestBytes: number;
  historyBytes: number;
  textBytes: number;
  textEvents: number;
}
interface TableMeasurement {
  name: string;
  rows: number;
  bytes: number;
  countedRows: boolean;
  countedBytes: boolean;
}
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
  tokenUsage: null;
}
export interface ContextReport {
  version: 1;
  scenario: {toolRounds: number; replyBytes: number; deltaBytes: number; stepLimit: number};
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
function modelOutput(protocol: AgentProtocol, text: string, calls: AgentTaskToolCall[], index: number): TaskModelOutput {
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
  return {text, toolCalls: calls, providerOutput};
}
function tableGrowth(before: AgentTaskStorageSnapshot, after: AgentTaskStorageSnapshot): TableMeasurement[] {
  return after.tables.map(table => {
    const previous = before.tables.find(item => item.name === table.name);
    return {...table, rows: table.rows - (previous?.rows ?? 0), bytes: table.bytes - (previous?.bytes ?? 0)};
  });
}
const equivalentRuns = (remaining: number, growth: number): number | null => growth > 0 ? Math.floor(remaining / growth) : null;

/** Uses a fresh disposable workspace and the real execution/journal/tool paths.
 * The only replacement is the model gateway, which never opens a socket. */
async function measureProtocol(protocol: AgentProtocol, scenario: ContextReport['scenario']): Promise<ContextProtocolReport> {
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
    await settings.put({expectedRevision: 0, configuration: {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`}, secret: {action: 'remove'}});
    const authorizations = createTestAuthorizations(() => ({...store}), settings);
    await authorizeTestScope(authorizations, 'project_agent');
    tools = createAgentTaskTools({store, services});
    const requests: RequestMeasurement[] = [];
    const gateway: TaskGateway = async function* (request) {
      request.beforeSubmit?.();
      const body = record(JSON.parse(request.body));
      const index = requests.length + 1;
      requests.push({index, bytes: Buffer.byteLength(request.body), toolCount: Array.isArray(body.tools) ? body.tools.length : 0});
      const text = 'x'.repeat(scenario.replyBytes);
      for (let offset = 0; offset < text.length; offset += scenario.deltaBytes) yield {type: 'delta', text: text.slice(offset, offset + scenario.deltaBytes)};
      const calls: AgentTaskToolCall[] = index <= scenario.toolRounds ? [{id: `synthetic_read_${String(index).padStart(3, '0')}`, name: 'mioon_project_inspect', arguments: {}}] : [];
      yield {type: 'done', output: modelOutput(protocol, text, calls, index)};
    };
    runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
    const before = readAgentTaskStorage(store.db);
    const sent = await runtime.send(projectId, {requestId: randomUUID(), expectedSettingsRevision: (await settings.get()).revision, locale: 'en', text: 'Inspect the current project repeatedly, then report completion. Synthetic offline context measurement.'});
    await runtime.drain();
    const snapshot = runtime.journal.snapshot(sent.run.id);
    assert.ok(requests.length > 0, `Measurement did not reach the synthetic gateway: ${snapshot.run.pauseReason ?? snapshot.run.status}`);
    const after = readAgentTaskStorage(store.db);
    const modelSteps = store.db.prepare("SELECT id,status,data,length(CAST(data AS BLOB)) AS bytes FROM agent_task_steps_v2 WHERE runId=? AND json_extract(data,'$.kind')='model' ORDER BY position").all(sent.run.id).map((row, index): ModelStepMeasurement => {
      const saved = record(JSON.parse(String(row.data)));
      const request = record(saved.request);
      assert.equal(typeof request.body, 'string');
      const textEvents = Number(store.db.prepare("SELECT count(*) AS n FROM agent_task_events_v2 WHERE runId=? AND type='text' AND json_extract(data,'$.data.stepId')=?").get(sent.run.id, String(row.id))!.n);
      return {index: index + 1, status: String(row.status), storedDataBytes: Number(row.bytes), requestBytes: Buffer.byteLength(request.body as string), historyBytes: Buffer.byteLength(JSON.stringify(request.history)), textBytes: typeof saved.text === 'string' ? Buffer.byteLength(saved.text) : 0, textEvents};
    });
    const quotaBytes = after.usage.bytes - before.usage.bytes;
    const quotaRows = after.usage.rows - before.usage.rows;
    const byBytes = equivalentRuns(after.remaining.bytes, quotaBytes), byRows = equivalentRuns(after.remaining.rows, quotaRows);
    const estimates = [byBytes, byRows].filter((value): value is number => value !== null);
    return {
      protocol,
      run: {status: snapshot.run.status, reason: snapshot.run.pauseReason ?? null, stepsUsed: snapshot.run.stepsUsed, budget: snapshot.run.budget, textEvents: modelSteps.reduce((sum, step) => sum + step.textEvents, 0)},
      requests, modelSteps,
      retained: {quotaBytes, quotaRows, tables: tableGrowth(before, after)},
      capacity: {limits: after.limits, remaining: after.remaining, additionalEquivalentRunsByBytes: byBytes, additionalEquivalentRunsByRows: byRows, additionalEquivalentRuns: estimates.length ? Math.min(...estimates) : null},
      tokenUsage: null,
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
  const scenario = {toolRounds: positiveInteger(options.toolRounds ?? 14, 'toolRounds', 14), replyBytes: positiveInteger(options.replyBytes ?? 30 * 1024, 'replyBytes', TASK_MODEL_LIMITS.outputBytes), deltaBytes: positiveInteger(options.deltaBytes ?? 3 * 1024, 'deltaBytes', TASK_MODEL_LIMITS.outputBytes), stepLimit: 30};
  const selected = options.protocols ?? protocols;
  if (!selected.length || selected.some(protocol => !protocols.includes(protocol))) throw new Error('Select at least one supported protocol');
  const reports: ContextProtocolReport[] = [];
  for (const protocol of selected) reports.push(await measureProtocol(protocol, scenario));
  return {
    version: 1, scenario, modelLimits: TASK_MODEL_LIMITS,
    measurement: {
      storage: 'Retained UTF-8 bytes in SQLite data columns, using the production quota inventory. Excludes SQLite page/WAL overhead and cumulative rewrites of the same row.',
      capacity: 'Additional equivalent runs estimated independently from remaining byte and row quotas; the lower bound wins. This is not a guarantee for different workloads.',
      streaming: 'Synthetic deltas are emitted without sleeps. Default 3 KiB chunks exceed the current 2 KiB flush threshold. Later time-based flushes may depend on host speed.',
      tokens: 'No token usage is fabricated: the synthetic gateway has no tokenizer or provider usage, and current model steps do not retain usage.',
    },
    protocols: reports,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {protocol: {type: 'string', default: 'all'}, 'tool-rounds': {type: 'string'}, 'reply-bytes': {type: 'string'}, 'delta-bytes': {type: 'string'}, output: {type: 'string'}}});
  const selected = values.protocol === 'all' ? protocols : protocols.filter(protocol => protocol === values.protocol);
  const report = await collectAgentTaskContextReport({protocols: selected, ...(values['tool-rounds'] ? {toolRounds: Number(values['tool-rounds'])} : {}), ...(values['reply-bytes'] ? {replyBytes: Number(values['reply-bytes'])} : {}), ...(values['delta-bytes'] ? {deltaBytes: Number(values['delta-bytes'])} : {})});
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json);
  else process.stdout.write(json);
}
