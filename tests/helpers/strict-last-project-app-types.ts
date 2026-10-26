import type {WorkspaceIdentity} from '../../apps/web/src/workspace-origin.ts';
import type {WorkspaceState} from '../../apps/web/src/workspace-state.ts';
import type {projectOpenAttempt} from '../../apps/web/src/project-open-state.ts';
export interface SelectionData {project: {id: string}; [key: string]: unknown}
export interface AppFunctions {
 projectSessionReady(): boolean; prepareSettingsDeparture(): Promise<boolean>;
 guardNavigation(...args: unknown[]): Promise<boolean>; guardProjectNavigation(...args: unknown[]): Promise<boolean>;
 selectProject(...args: unknown[]): Promise<boolean>; refresh(...args: unknown[]): Promise<SelectionData | null>; boot(): Promise<void>;
}
export interface SelectionEnvironment extends Record<string, unknown>, Omit<AppFunctions, 'selectProject' | 'boot'> {
 currentProject: {current: string | null}; projectEpoch: {current: number}; navigationEpoch: {current: number};
 workspaceRef: {current: WorkspaceIdentity | null}; importSession: {current: {active: boolean; selection: number}};
 openedProject: {current: ReturnType<typeof projectOpenAttempt> | null}; dataRef: {current: {project?: {id: string}}};
 viewRef: {current: WorkspaceState}; viewReady: {current: boolean}; preferenceScope?: {current: string | null};
 loading: boolean; auth: boolean | string; homePage: string; videoDirectoryUnavailable: boolean; providers: unknown[];
 projectOpening: {phase: string; projectId: string | null; error: string};
 lastProjectRef: {current: {invalidateNavigation(epoch: number): unknown; rememberOpened(projectId: string, epoch: number): unknown; getState(): {identityBlocked: boolean; revision: number | null}; discover(): unknown}};
 preferencesRef: {current: {flush(): Promise<unknown>; load(...args: unknown[]): Promise<unknown>; getStatus(): unknown; update(...args: unknown[]): unknown}};
 window: {location: {href: string; search?: string}; history: {pushState(): void; replaceState(): void}; __mioonUiPreferences: {markOpened(projectId: string): unknown}};
 context(): {projectId: string | null; epoch: number; workspace: WorkspaceIdentity | null}; isCurrent(value: {projectId: string | null; epoch: number; workspace?: WorkspaceIdentity | null}): boolean;
 rpc(operation: string, input?: {projectId: string}): Promise<unknown>;
 setProjectOpening(value: SelectionEnvironment['projectOpening']): void; setHomePage(value: string): void;
 setLoading(value: boolean): void; setAuth(value: boolean | string): void; setVideoDirectoryUnavailable(value: boolean): void;
}
