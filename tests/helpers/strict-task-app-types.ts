import type {TaskWorkspaceContext} from '../../apps/web/src/task-workspace-intent.ts';
import type {AgentTaskRecoveryIntent} from '../../apps/web/src/agent-task-recovery-location.ts';
export interface TaskMethods {
 readTaskRevealContext(): TaskWorkspaceContext; readTaskViewContext(): TaskWorkspaceContext;
 captureTaskView(): (() => boolean) | null;
 openTasks(current?: () => boolean, selectedId?: string): boolean;
 inspectTaskJob(job: unknown, current: () => boolean): Promise<boolean>;
 runDurable(key: string, operation: string, input: Record<string, unknown>, ...options: unknown[]): Promise<unknown>;
 recoverTask(task: unknown, acknowledgeOnly?: boolean, current?: () => boolean): Promise<unknown>;
 openAgentRequests(selectedId?: string): Promise<boolean>;
 retryGeneration(job: unknown, current?: () => boolean): void; confirmGeneration(approval: unknown): void;
}
export interface DraftOwner {
 capture(): unknown; isCurrent(token: never): boolean; getState?(): unknown; hasPendingComposition(): boolean;
}
export interface TaskPaneState {
 projectReady: boolean; selectedTaskId: string | undefined; overlay: string | null; dock: string; page: string; mode: string;
 confirm: {message: unknown; extra: unknown; canDiscard(): boolean}[];
 reveal: [string, ...unknown[]][]; notice: unknown[][]; auth: unknown[]; refresh: unknown[]; ack: unknown[]; busy: unknown[][];
 draft: {name: string; startFrame: number};
}
export interface RequestState {
 ready: boolean; nativeAllowed: boolean; nativeUnknown: boolean; composing: boolean; accept: boolean; guardCalls: number; discards: number;
 reads: {operation: string; input: Record<string, unknown>}[]; effects: [string, ...unknown[]][]; notices: unknown[][];
 recovery: AgentTaskRecoveryIntent | null; throwRead?: boolean; draft: {text: string; inFrame: number; outFrame: number};
}
export interface FakeTask {status?: string; [key: string]: unknown}
export interface FakeTaskController {
 submit(input: {input: unknown; [key: string]: unknown}): Promise<{task: FakeTask; result?: unknown}>;
 acknowledge(task: unknown): Promise<unknown>;
 recover(task: Record<string, unknown>, options: {canExecute(): boolean}): Promise<{task: FakeTask; result?: unknown}>;
}
export interface GenerationApproval {shot: unknown; approvalView: unknown; taskViewGuard(): boolean}
