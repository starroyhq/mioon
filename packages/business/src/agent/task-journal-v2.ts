export {AGENT_TASK_EVENT_PAGE_BYTES} from './task-event-limits-v2.ts';
import {createMioProjectJournal} from './mio-journal-factory.ts';
import {testProjectAppLibrary} from '../project-service-application.ts';
import {assertProjectStore} from '../store-runtime.ts';
import type { Store } from '../store-contract.ts';
import type {AgentPolicyStore} from '../app-db/stores.ts';
import type {TaskContextHistoryInput,TaskContextHistoryRun} from './task-context-v2.ts';
import type {FrozenMioRules} from './mio-rules.ts';
import type {AgentTaskConversationPolicy,AgentTaskConversationPolicySetInput,AgentTaskPolicyModes} from '../../../contracts/src/agent-tasks-v2.ts';
import type {AgentTaskRun,AgentTaskStep,AgentTaskChange,AgentTaskEvent,AgentTaskSnapshot,AgentTaskStatus,AgentTaskStepStatus,AgentTaskJson,AgentTaskReceipt,AgentTaskPolicy,AgentTaskTarget,AgentTaskClaim,AgentTaskEditingInput,AgentTaskDiagnostic,AgentTaskConversation,AgentTaskConversationPage,AgentTaskHistoryPage,AgentTaskNote,AgentTaskSkippedTarget} from '../../../contracts/src/agent-tasks-v2.ts';

export type AgentTaskChangeInput=Omit<AgentTaskChange,'id'|'runId'|'stepId'|'createdAt'|'status'|'modifiedAfter'|'undoDisposition'>;
export interface AgentTaskStepInput extends Pick<AgentTaskStep,'kind'> {request?:AgentTaskJson;data?:AgentTaskJson;toolCall?:AgentTaskStep['toolCall'];targets?:AgentTaskTarget[];tier?:AgentTaskStep['tier']}
export interface AgentTaskControlRecord {requestId:string;runId:string;expectedRevision:number;action:string;stepId?:string;changeId?:string;resolution?:string;text?:string;undoChangeIds?:string[]}
export interface AgentTaskJournalOptions {policyStore?:AgentPolicyStore}
/** Current journal port; the real project and app policy adapters own storage. */
export function createAgentTaskJournal(store:Store,{policyStore=testProjectAppLibrary(store)?.agentPolicy}:AgentTaskJournalOptions={}):AgentTaskJournal{
 assertProjectStore(store);return createMioProjectJournal(store,policyStore);
}
export interface AgentTaskJournal {
"expireClaims": (maxAgeMs?: number) => number;
"markClaimsUncertain": (projectId?: string, ownerId?: string) => void;
"edit": (input: AgentTaskEditingInput) => { requestId: string; projectId: string; ownerId: string; generation: number; sequence: number; claims: AgentTaskClaim[]; };
"conversationPolicy": (projectId: string, conversationId: string) => AgentTaskConversationPolicy;
"setConversationPolicy": (projectId: string, conversationId: string, request: AgentTaskConversationPolicySetInput) => AgentTaskConversationPolicy;
"effectiveModes": (projectId: string, conversationId?: string) => AgentTaskPolicyModes;
"sentConversationModesMatch": (requestId: string, modes?: AgentTaskPolicyModes) => boolean;
"conversationPolicies": () => boolean;
"lookupRequest": (projectId: string, requestId: string) => AgentTaskSnapshot | null;
"lookupEdit": (requestId: string) => unknown;
"create": (input: { requestId: string; projectId: string; conversationId?: string; text: string; configuration: AgentTaskJson; settingsRevision?: number; context?: AgentTaskJson[]; attachments?: string[]; policy?: AgentTaskPolicy; diagnostic?: AgentTaskDiagnostic; conversationModes?: AgentTaskPolicyModes; rulesSnapshot?: FrozenMioRules; }) => AgentTaskSnapshot;
"conversation": (projectId: string, conversationId: string, { cursor, limit }?: { cursor?: string; limit?: number; }) => AgentTaskConversationPage;
"conversationSummary": (projectId: string, conversationId: string) => AgentTaskConversation;
"contextRuns": (projectId: string, conversationId: string) => AgentTaskRun[];
"modelContextRuns": (projectId: string, conversationId: string) => TaskContextHistoryRun[];
"requestConversationId": (runId: string) => string | undefined;
"snapshot": (runId: string) => AgentTaskSnapshot;
"hasPendingBackground": (runId: string) => boolean;
"history": (projectId: string, { cursor, limit }?: { cursor?: string; limit?: number; }) => AgentTaskHistoryPage;
"latestDiagnostic": (profile: AgentTaskDiagnostic["profile"]) => AgentTaskSnapshot | null;
"list": (projectId: string, { excludeDiagnostics }?: { excludeDiagnostics?: boolean; }) => AgentTaskRun[];
"events": (runId: string, after?: number) => AgentTaskEvent[];
"eventSequence": (runId: string, after?: number) => number;
"run": (id: string) => AgentTaskRun;
"step": (id: string) => AgentTaskStep;
"transition": (runId: string, expectedRevision: number, status: AgentTaskStatus, reason?: string) => AgentTaskRun;
"beginStep": (runId: string, input: AgentTaskStepInput) => AgentTaskStep;
"beginModelStep": (runId: string, input: Omit<AgentTaskStepInput, "kind">, noteRequestIds: string[]) => AgentTaskStep;
"appendNoteInside": (runId: string, requestId: string, text: string) => AgentTaskNote;
"skipTargetsInside": (runId: string, targets: { stepId: string; target: AgentTaskTarget; }[]) => AgentTaskSkippedTarget[];
"updateStep": (runId: string, stepId: string, patch: Partial<Pick<AgentTaskStep, "status" | "request" | "data" | "result" | "error" | "cost" | "targets" | "tier">>) => AgentTaskStep;
"dispatchPrevented": (runId: string, stepId: string, next: "intent" | "awaiting_approval") => AgentTaskStep;
"markDispatch": (runId: string, stepId: string) => AgentTaskStep;
"completeStepInside": (runId: string, stepId: string, input?: { result?: AgentTaskJson; change?: AgentTaskChangeInput; changes?: AgentTaskChangeInput[]; }) => AgentTaskStep;
"appendChangesInside": (runId: string, stepId: string, changes: AgentTaskChangeInput[]) => AgentTaskChange[];
"completeStep": (runId: string, stepId: string, input: Parameters<(runId: string, stepId: string, input?: { result?: AgentTaskJson; change?: AgentTaskChangeInput; changes?: AgentTaskChangeInput[]; }) => AgentTaskStep>[2]) => AgentTaskStep;
"appendText": (runId: string, stepId: string, text: string) => void;
"appendEvent": (runId: string, type: string, data: AgentTaskJson) => AgentTaskEvent;
"control": (input: AgentTaskControlRecord, result?: AgentTaskJson) => AgentTaskReceipt;
"performControl": (input: AgentTaskControlRecord, apply: () => AgentTaskJson) => AgentTaskReceipt;
"rejectControl": (input: AgentTaskControlRecord, failureCode: string) => AgentTaskReceipt;
"beginControl": (input: AgentTaskControlRecord) => AgentTaskReceipt;
"finishControl": (requestId: string, result: AgentTaskJson) => AgentTaskReceipt;
"lookupControl": (requestId: string) => AgentTaskReceipt | null;
"resume": (runId: string, expectedRevision: number, { extendBudget }?: { extendBudget?: boolean; }) => AgentTaskRun;
"recover": () => number;
"policy": () => AgentTaskPolicy;
"updatePolicy": (input: AgentTaskPolicy, requestId?: string) => AgentTaskPolicy;
"lookupPolicy": (requestId: string) => AgentTaskPolicy | null;
"targetRevision": (projectId: string, kind: string, id: string) => number;
"revisionSnapshot": (projectId: string) => AgentTaskTarget[];
"assertTargets": (projectId: string, targets: AgentTaskTarget[]) => void;
"conflictingTargets": (projectId: string, targets: AgentTaskTarget[]) => AgentTaskTarget[];
"claims": (projectId: string, ownerId?: string) => AgentTaskClaim[];
"claim": (input: { projectId: string; ownerId: string; targets: AgentTaskTarget[]; }) => AgentTaskClaim[];
"releaseClaims": (projectId: string, ownerId: string, targets?: AgentTaskTarget[]) => void;
"markChangeRevertedInside": (changeId: string) => AgentTaskChange;
"markChangeRetainedInside": (changeId: string, reason: string) => AgentTaskChange;
"markChangeSupersededInside": (changeId: string) => AgentTaskChange;
 prepareModelStep?:(runId:string,stepId:string)=>AgentTaskStep;
}
