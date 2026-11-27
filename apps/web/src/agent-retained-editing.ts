import {
  agentTaskEditingClaimGroupSchema, agentTaskEditingRetainedResponseSchema, agentTaskEditingResolveBatchReceiptSchema, agentTaskEditingTargetRevisionKind,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type {
  AgentTaskEditingClaimGroup, AgentTaskEditingRetainedResponse, AgentTaskEditingResolveBatchInput, AgentTaskEditingResolveBatchReceipt,
} from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { projectApiPath } from '../../../packages/contracts/src/project-file.ts';

const editingPath = (projectId: string, route: 'retained' | 'resolve-batch') =>
  projectApiPath(projectId, 'agent', 'tasks', 'v2', 'editing', route);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class RetainedEditingConflict extends Error {}

export type RetainedEditingDraftState = 'unsaved' | 'clean' | 'unconfirmed';
export type RetainedEditingStatus = 'local_unsaved' | 'local_occupied' | 'another_window' | 'unconfirmed';
type RetainedEditingGroup = AgentTaskEditingRetainedResponse['groups'][number];
type RetainedEditingOwner = RetainedEditingGroup['owners'][number];
export interface RetainedEditingLocalEvidence {
  ownsWindow: (ownerId: string) => boolean;
  readDraft?: (owner: RetainedEditingOwner) => RetainedEditingDraftState | undefined;
}
type RetainedEditingOwnerStatus = RetainedEditingOwner & {status: RetainedEditingStatus};
type RetainedEditingGroupStatus = Omit<RetainedEditingGroup, 'owners'> & {owners: RetainedEditingOwnerStatus[]; status: RetainedEditingStatus};
export type RetainedEditingStatusView = Omit<AgentTaskEditingRetainedResponse, 'groups'> & {groups: RetainedEditingGroupStatus[]};

function editingStatus(owner: RetainedEditingOwner, local: RetainedEditingLocalEvidence): RetainedEditingStatus {
  if (!local.ownsWindow(owner.claim.ownerId)) return owner.liveness === 'in_use' ? 'another_window' : 'unconfirmed';
  const draft = local.readDraft?.(owner);
  if (draft === 'unsaved') return 'local_unsaved';
  return draft === 'clean' && owner.claim.state === 'active' ? 'local_occupied' : 'unconfirmed';
}

function retainedEditingView(host: AgentTaskEditingRetainedResponse, local: RetainedEditingLocalEvidence): RetainedEditingStatusView {
  // Surface a known draft or a live foreign window in a mixed group. Missing
  // draft evidence never elevates an ambiguous group to local_occupied.
  const statusOrder = ['local_unsaved', 'another_window', 'unconfirmed', 'local_occupied'] as const;
  return {...host, groups: host.groups.map(group => {
    const owners = group.owners.map(owner => ({...owner, status: editingStatus(owner, local)}));
    const status = statusOrder.find(candidate => owners.some(owner => owner.status === candidate)) ?? 'unconfirmed';
    return {...group, owners, status};
  })};
}

function verifyGroups(projectId: string, groups: AgentTaskEditingClaimGroup[]): void {
  if (groups.some(({projectId: groupProject, kind, id, locator, owners}) =>
    groupProject !== projectId || locator && (locator.kind !== kind || locator.id !== id) ||
    owners.some(({claim, locator}) => claim.projectId !== projectId || agentTaskEditingTargetRevisionKind(claim.target.kind) !== kind ||
      claim.target.id !== id || locator && (locator.kind !== claim.target.kind || locator.id !== claim.target.id)))) {
    throw new Error('Editing recovery target mismatch');
  }
}

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
      verifyGroups(projectId, result);
      return result;
    },
    async readStatus(projectId: string, local: RetainedEditingLocalEvidence): Promise<RetainedEditingStatusView> {
      const host = agentTaskEditingRetainedResponseSchema.parse(await request(editingPath(projectId, 'retained')));
      verifyGroups(projectId, host.groups);
      return retainedEditingView(host, local);
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
