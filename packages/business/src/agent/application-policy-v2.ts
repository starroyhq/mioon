import {createHash} from 'node:crypto';
import {agentTaskPolicySchema, DEFAULT_AGENT_TASK_POLICY} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskPolicy} from '../../../contracts/src/agent-tasks-v2.ts';
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
  function updatePolicy(input: AgentTaskPolicy, requestId?: string): AgentTaskPolicy {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const replay = (): AgentTaskPolicy | null => {
      const saved = requestId ? store.readRequest(requestId) : null;
      if (!saved) return null;
      if (saved.digest !== digest) throw agentTaskFailure('AGENT_TASK_REQUEST_CONFLICT');
      return agentTaskPolicySchema.parse(saved.policy);
    };
    const previous = replay();
    if (previous) return previous;
    const next = agentTaskPolicySchema.parse(input), old = policy();
    if (next.revision !== old.revision) throw agentTaskFailure('AGENT_TASK_REVISION_CONFLICT');
    if (next.revision >= Number.MAX_SAFE_INTEGER) throw agentTaskFailure('AGENT_TASK_REVISION_LIMIT');
    next.revision++;
    try { store.write(next, requestId ? {requestId, digest} : undefined, input.revision); }
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
