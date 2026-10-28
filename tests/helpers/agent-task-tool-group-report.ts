import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {AGENT_TASK_TOOL_GROUP_IDS, agentTaskToolGroupForName, assertAgentTaskToolGroupCoverage} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {buildTaskModelRequest, taskResponseLanguageContext} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskToolDefinition} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentConfiguration} from '../../packages/business/src/agent/config.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskToolGroupId} from '../../packages/business/src/agent/task-tool-groups-v2.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
interface ToolWireMeasurement {
  toolCount: number;
  rawToolJsonBytes: number;
  wireToolsJsonBytes: number;
  requestBytes: number;
  requestBytesAboveEmptyTools: number;
}
interface ToolGroupMeasurement extends ToolWireMeasurement {
  group: AgentTaskToolGroupId;
  names: string[];
  withCore: ToolWireMeasurement;
}
export interface AgentTaskToolGroupReport {
  version: 1;
  measurement: string;
  catalogToolCount: number;
  protocols: {
    protocol: AgentProtocol;
    emptyRequestBytes: number;
    allTools: ToolWireMeasurement;
    groups: ToolGroupMeasurement[];
  }[];
}

/** Measure the production protocol wrappers and schema projection, including
 * model-only explanation fields. No provider transport or model is created. */
export async function collectAgentTaskToolGroupReport(): Promise<AgentTaskToolGroupReport> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-tool-group-report-'));
  const store = openStore(root), services = createServices(store, new Map());
  const tools = createAgentTaskTools({store, services});
  try {
    const catalog = tools.list();
    assertAgentTaskToolGroupCoverage(catalog);
    const reports: AgentTaskToolGroupReport['protocols'] = [];
    for (const protocol of protocols) {
      const configuration: AgentConfiguration = {presetId: 'ollama', platformId: 'local', protocol,
        model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
      const history = [taskResponseLanguageContext('en'), {role: 'user', content: 'Synthetic offline tool group measurement.'}];
      const build = (definitions: readonly TaskToolDefinition[]): string => buildTaskModelRequest(configuration, history, definitions, 4318, {toolLoading: true});
      const emptyRequestBytes = Buffer.byteLength(build([]));
      const measure = (definitions: readonly TaskToolDefinition[]): ToolWireMeasurement => {
        const body = build(definitions), parsed: unknown = JSON.parse(body);
        assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
        const wireTools: unknown = (parsed as Record<string, unknown>).tools ?? [];
        assert.ok(Array.isArray(wireTools));
        assert.equal(wireTools.length, definitions.length);
        const rawTools = definitions.map(({name, description, parameters}) => ({name, description, parameters}));
        return {toolCount: definitions.length, rawToolJsonBytes: Buffer.byteLength(JSON.stringify(rawTools)),
          wireToolsJsonBytes: Buffer.byteLength(JSON.stringify(wireTools)),
          requestBytes: Buffer.byteLength(body), requestBytesAboveEmptyTools: Buffer.byteLength(body) - emptyRequestBytes};
      };
      reports.push({protocol, emptyRequestBytes, allTools: measure(catalog), groups: AGENT_TASK_TOOL_GROUP_IDS.map(group => {
        const definitions = catalog.filter(tool => agentTaskToolGroupForName(tool.name) === group);
        const withCore = catalog.filter(tool => {
          const assigned = agentTaskToolGroupForName(tool.name);
          return assigned === 'core' || assigned === group;
        });
        return {group, names: definitions.map(tool => tool.name), ...measure(definitions), withCore: measure(withCore)};
      })});
    }
    return {version: 1, measurement: 'UTF-8 bytes using one fixed English input. rawToolJsonBytes serializes only the catalog name/description/parameters fields; wireToolsJsonBytes serializes the actual buildTaskModelRequest tools field, including protocol wrappers and model-only schema projection. Each group preserves production catalog order. Per-group arrays each include their own brackets; request deltas also include protocol tool controls, so these figures are not additive.', catalogToolCount: catalog.length, protocols: reports};
  } finally {
    tools.dispose();
    await services.drain();
    store.close();
    rmSync(root, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {output: {type: 'string'}}});
  const json = JSON.stringify(await collectAgentTaskToolGroupReport(), null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json);
  else process.stdout.write(json);
}
