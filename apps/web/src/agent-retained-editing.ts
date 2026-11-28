import {
  agentTaskEditingClaimGroupSchema, agentTaskEditingResolveBatchReceiptSchema,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {
  AgentTaskEditingClaimGroup, AgentTaskEditingResolveBatchInput, AgentTaskEditingResolveBatchReceipt,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { projectApiPath } from '../../../packages/contracts/src/project-file.ts';

const editingPath = (projectId: string, route: 'retained' | 'resolve-batch') =>
  projectApiPath(projectId, 'agent', 'tasks', 'v2', 'editing', route);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class RetainedEditingConflict extends Error {}

export function matchesEditingBatchReceipt(input: AgentTaskEditingResolveBatchInput, receipt: AgentTaskEditingResolveBatchReceipt | null): boolean {
  if (!receipt || receipt.projectId !== input.projectId || receipt.requestId !== input.requestId) return false;
  const released = new Set(receipt.releasedClaimIds);
  return receipt.releasedClaimIds.length === input.claims.length && released.size === input.claims.length &&
    input.claims.every(claim => released.has(claim.claimId));
}

export function createRetainedEditingClient(fetchImpl = globalThis.fetch) {
  async function request(url: string, input?: AgentTaskEditingResolveBatchInput) {
    const response = await fetchImpl(url, {
      method: input ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
      ...(input ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)} : {}),
    });
    const envelope: unknown = await response.json();
    if (response.ok && record(envelope) && envelope.ok === true && record(envelope.data)) return envelope.data;
    if (response.status === 409 && record(envelope) && envelope.ok === false && record(envelope.error) &&
      ['AGENT_TASK_EDIT_BATCH_CONFLICT', 'AGENT_TASK_REQUEST_CONFLICT'].includes(String(envelope.error.code))) {
      throw new RetainedEditingConflict();
    }
    throw new Error('Editing recovery response unconfirmed');
  }

  return {
    async read(projectId: string): Promise<AgentTaskEditingClaimGroup[]> {
      const {groups} = await request(editingPath(projectId, 'retained'));
      const result = agentTaskEditingClaimGroupSchema.array().parse(groups);
      if (result.some(group => group.projectId !== projectId || group.owners.some(({claim}) =>
        claim.projectId !== projectId || claim.target.kind !== group.kind || claim.target.id !== group.id))) {
        throw new Error('Editing recovery target mismatch');
      }
      return result;
    },
    async lookup(projectId: string, requestId: string): Promise<AgentTaskEditingResolveBatchReceipt | null> {
      const data = await request(`${editingPath(projectId, 'resolve-batch')}?requestId=${encodeURIComponent(requestId)}`);
      return agentTaskEditingResolveBatchReceiptSchema.nullable().parse(data.receipt);
    },
    async resolve(input: AgentTaskEditingResolveBatchInput): Promise<AgentTaskEditingResolveBatchReceipt> {
      return agentTaskEditingResolveBatchReceiptSchema.parse(await request(editingPath(input.projectId, 'resolve-batch'), input));
    },
  };
}
