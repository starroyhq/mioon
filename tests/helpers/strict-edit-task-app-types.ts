import type {EditTaskSnapshot} from '../../apps/web/src/edit-task-controller.ts';
import type {RootTree} from './strict-root-ui-types.ts';
export interface AppFixtureTask {
 id: string; projectId: string; operation: string; input: Record<string, unknown>; requestId: string; digest: string;
 lane: string | null; status: string; revision: number; createdAt: string; updatedAt: string; acknowledged: boolean; origin: string; errorCode?: string;
}
export interface AppTaskArguments extends Record<string, unknown> {projectId: string; operation: string; input: Record<string, unknown> & {requestId: string}; origin: string; expectedRevision: number; status: string}
export interface AppTaskHooks {
 list?(args: AppTaskArguments): unknown;
 prepare?(args: AppTaskArguments, task: AppFixtureTask): unknown;
 execute?(args: AppTaskArguments, task: AppFixtureTask): unknown;
 get?(args: AppTaskArguments, task: AppFixtureTask | null): unknown;
 acknowledge?(args: AppTaskArguments, task: AppFixtureTask): unknown;
}
export interface AppTaskState {
 epoch: number; notices: {message: string; type: unknown}[]; calls: [string, unknown][]; refreshes: unknown[]; snapshots: EditTaskSnapshot[];
 pending: unknown[]; auth: boolean; jobs: boolean; draft: Record<string, unknown>; recoveredTasks: AppFixtureTask[];
 recoveredSubtitleTasks?: AppFixtureTask[]; subjectRefresh?: Record<string, unknown>;
}
interface RunOptions {onFailure?(error: unknown, details: unknown): unknown; validateResponse?(response: unknown): unknown; [key: string]: unknown}
export interface AppTaskFunctions {
 run(key: string, operation: string, input: Record<string, unknown>, message?: unknown, options?: RunOptions): Promise<unknown>;
 runDurable(key: string, operation: string, input: Record<string, unknown>, message?: unknown, options?: RunOptions): Promise<unknown>;
 recoverTask(task: unknown, acknowledgeOnly?: boolean): Promise<unknown>; adoptLegacyTask(entry: unknown): Promise<unknown>;
}
export interface UiComponentModule {exports: Record<string, (props: Record<string, unknown>) => RootTree>}
