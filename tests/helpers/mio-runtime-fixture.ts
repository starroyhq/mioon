import {createMioAssembly} from '../../packages/business/src/agent/mio-assembly.ts';
import {createMioJournal} from '../../packages/business/src/agent/mio-journal.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {createMioRuntime} from '../../packages/business/src/agent/mio-runtime.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import type {AgentTaskJournal} from '../../packages/business/src/agent/task-journal-v2.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {authorizeTestScope} from './agent-authorizations.ts';
import {createMioTestAppPorts} from './mio-runtime-app-ports.ts';

export const mioTestPolicy = {
  policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY),
  lookupPolicy: () => null,
  updatePolicy: (): never => {throw new Error('The runtime fixture must not change application policy');},
};

/** A real project kernel and real tool implementation with an offline gateway.
 * Reopening the same directory retains history and authorization receipts. */
export async function createMioTestFixture(root: string, gateway: TaskGateway, wrapJournal: (journal: AgentTaskJournal) => AgentTaskJournal = value => value, protocol: AgentProtocol = 'chat_completions') {
  const store = openStore(root);
  if (!store.get('projects', store.projectId)) store.put('projects', {id: store.projectId, name: 'Mio synthetic runtime project', description: '', revision: 1, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z'});
  const ports = createMioTestAppPorts(store), {services} = ports;
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  await settings.put({expectedRevision: 0, configuration: {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`}, secret: {action: 'remove'}});
  const authorizations = ports.createAuthorizations(settings);
  await authorizeTestScope(authorizations, 'project_agent');
  const records = createMioRecords(store), assembly = createMioAssembly(records);
  const journal = wrapJournal(createMioJournal(store, {...mioTestPolicy, assembly}));
  const tools = createAgentTaskTools({store, services, journal});
  const makeRuntime = () => createMioRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318, policy: mioTestPolicy, journal});
  let runtime = makeRuntime();
  return {
    store, records, assembly, settings, services, tools, authorizations, gateway,
    get runtime() {return runtime;},
    restart() {runtime.close(); runtime = makeRuntime();},
    async close() {runtime.close(); await runtime.drain(); tools.dispose(); await services.drain(); await settings.close(); ports.close(); store.close();},
  };
}
