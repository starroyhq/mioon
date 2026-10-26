import type {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import type {taskFixture, FixtureRequestOptions, FixtureResponse} from './edit-tasks-http-fixture.ts';
import type {ServiceResponse} from './strict-service-responses.ts';
import type {FixtureProject, FixtureTimeline, FixtureAsset} from './strict-timeline-core-types.ts';
import type {MediaNode, MediaShot} from './strict-service-responses.ts';
type Manager = ReturnType<typeof createEditTasks>;
export type TaskRecord<O extends string = string> = Omit<import('../../packages/contracts/src/edit-tasks.ts').EditTask, 'operation' | 'errorCode' | 'status' | 'origin'> & {operation: O; status: string; origin: string; errorCode?: string | null};
export interface TaskEnvelope<O extends string = string> {
 task: TaskRecord<O>; instanceId: string; result?: ServiceResponse<O>;
 restore?: {workspaceOrigin: string; executionEpoch?: string; held: boolean};
}
export interface TaskList {items: TaskRecord[]; nextCursor: string | null; instanceId: string; restore?: {workspaceOrigin: string; tasks: {taskId: string; executionEpoch: string; held: boolean}[]}}
export type TypedTaskManager = Omit<Manager, 'prepare' | 'get' | 'execute' | 'reconcile' | 'acknowledge' | 'list'> & {
 prepare<O extends string>(input: {operation: O; [key: string]: unknown}): TaskEnvelope<O>;
 get(input: unknown): TaskEnvelope;
 execute(input: unknown, context?: Record<string, unknown>): Promise<TaskEnvelope>;
 reconcile(input: unknown): TaskEnvelope;
 acknowledge(input: unknown): TaskEnvelope;
 list(input: unknown): TaskList;
};
export interface TaskHttpResponse extends Omit<FixtureResponse, 'body'> {
 body: {ok: boolean; data: unknown; error: {code: string; message: string; retryable: boolean; details: Record<string, unknown>}}
}
type RawFixture = Awaited<ReturnType<typeof taskFixture>>;
export type TaskHttpFixture = Omit<RawFixture, 'project' | 'foreign' | 'source' | 'node' | 'shot' | 'timeline' | 'backend' | 'observed' | 'phases' | 'request' | 'viaProxy' | 'data' | 'rpc' | 'prepare' | 'execute' | 'reconcile' | 'get' | 'list' | 'acknowledge'> & {
 project: FixtureProject; foreign: FixtureProject; source: FixtureAsset; node: MediaNode; shot: MediaShot; timeline: FixtureTimeline;
 phases: string[]; observed: (TaskHttpResponse & {route: string})[];
 backend: {url: string; close(): Promise<unknown>; arm(phase: string): Promise<unknown>; observe(): Promise<{phases: string[]}>; exited: Promise<{code: number | null; signal: NodeJS.Signals | null}>; child: import('node:child_process').ChildProcess};
 request(route: string, options?: FixtureRequestOptions): Promise<TaskHttpResponse>;
 viaProxy(route: string, options?: FixtureRequestOptions): Promise<TaskHttpResponse>;
 data(route: '/api/tasks/prepare', options?: FixtureRequestOptions): Promise<TaskEnvelope>;
 data(route: string, options?: FixtureRequestOptions): Promise<TaskList>;
 rpc<O extends string>(operation: O, input: unknown): Promise<ServiceResponse<O>>;
 prepare<O extends string>(operation: O, input: unknown, origin?: string): Promise<TaskEnvelope<O>>;
 execute<O extends string>(prepared: TaskEnvelope<O>, overrides?: Record<string, unknown>): Promise<TaskEnvelope<O>>;
 reconcile<O extends string>(task: TaskRecord<O>): Promise<TaskEnvelope<O>>;
 get(taskId: string): Promise<TaskEnvelope>;
 list(suffix?: string): Promise<TaskList>;
 acknowledge<O extends string>(task: TaskRecord<O>): Promise<TaskEnvelope<O>>;
};
