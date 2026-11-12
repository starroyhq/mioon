import {createHash} from 'node:crypto';
import {agentTaskPolicySchema, agentTaskPolicyUpdateSchema, DEFAULT_AGENT_TASK_POLICY} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskPolicy, AgentTaskPolicyUpdate} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentPolicyStore} from '../app-db/stores.ts';
import {agentTaskFailure} from './task-runtime-v2.ts';

/** The same CAS and receipt protocol as a project's journal, usable when no
 * project is open. The app store commits policy and receipt independently. */
export function createApplicationPolicy(store: AgentPolicyStore) {
  const policy = (): AgentTaskPolicy => agentTaskPolicySchema.parse(store.read() ?? structuredClone(DEFAULT_AGENT_TASK_POLICY));
  const lookupPolicy = (requestId: string): AgentTaskPolicy | null => {
    const found = store.readRequest(requestId);
    return found ? agentTaskPolicySchema.parse(found.policy) : null;
  };
  function updatePolicy(input: AgentTaskPolicyUpdate, requestId?: string): AgentTaskPolicy {
    // Old receipts bind the exact input, including a legacy stepLimit when sent.
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const replay = (): AgentTaskPolicy | null => {
      const saved = requestId ? store.readRequest(requestId) : null;
      if (!saved) return null;
      if (saved.digest !== digest) throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');
      return agentTaskPolicySchema.parse(saved.policy);
    };
    const previous = replay();
    if (previous) return previous;
    const update = agentTaskPolicyUpdateSchema.parse(input), old = policy();
    if (update.revision !== old.revision) throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
    if (update.revision >= Number.MAX_SAFE_INTEGER) throw agentTaskFailure('AGENT_TASK_REVISION_LIMIT');
    const next: AgentTaskPolicy = {revision: update.revision + 1, stepLimit: old.stepLimit, modes: update.modes};
    try { store.write(next, requestId ? {requestId, digest} : undefined, update.revision); }
    catch (error) {
      if ((error as {code?: unknown})?.code !== 'AGENT_POLICY_REQUEST_EXISTS') throw error;
      const saved = replay();
      if (!saved) throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');
      return saved;
    }
    return next;
  }
  return {policy, lookupPolicy, updatePolicy};
}
