// Views of JSX returned by the controlled React peers in root UI regressions.
// Component modules enter these views only at their evaluated module boundary;
// arbitrary business responses and negative inputs remain unknown.
export type RootTree = RootNode | string | number | boolean | null | undefined | RootTree[];
export interface RootNode {type: string; props: RootProps}
export interface RootProps {
  nextAction:RootNode;checkAction:RootNode;options: {value: string; label: string; disabled: boolean}[]; actions: RootNode;
  'data-testid'?: string; 'aria-label': string;
  ref?: {current: unknown}|((element:RootMediaElement|null)=>void)|null;
  beforeClose(...values:unknown[]):Promise<boolean>;onBlur(...values: unknown[]): unknown;
  onCheckedChange(...values: unknown[]): unknown;
  onClose(...values: unknown[]): unknown;
  onDiscard(...values: unknown[]): unknown;
  onDragStart(...values: unknown[]): unknown;
  onDrop(...values: unknown[]): unknown;
  onFocus(...values: unknown[]): unknown;
  onLoadedMetadata(...values: unknown[]): unknown;
  onOpenOfficial(...values: unknown[]): unknown;
  onPage(...values: unknown[]): unknown;
  onPause(...values: unknown[]): unknown;
  onPlay(...values: unknown[]): unknown;
  onPlaying(...values: unknown[]): unknown;
  onPointerEnter(...values: unknown[]): unknown;
  onPointerLeave(...values: unknown[]): unknown;
  onSeeked(...values: unknown[]): unknown;
  onSelect(...values: unknown[]): unknown;
  onSelectSlot(...values: unknown[]): unknown;
  onTimeUpdate(...values: unknown[]): unknown;
  onValueChange(...values: unknown[]): unknown;
  [key: string]: unknown;
  children: RootTree[]; className: string; id: string; title: string;
  style: Record<string, string | number | undefined>;
  onDoubleClick(...values: unknown[]): unknown; onContextMenu(...values: unknown[]): unknown;
  onClick(...values: unknown[]): unknown; onChange(...values: unknown[]): unknown;
  onSubmit(...values: unknown[]): unknown; onKeyDown(...values: unknown[]): unknown;
  onPointerDownCapture(...values: unknown[]): unknown; onKeyDownCapture(...values: unknown[]): unknown;
  onKeyUpCapture(...values: unknown[]): unknown; onOpenChange(...values: unknown[]): unknown;
  onCompositionStart(...values: unknown[]): unknown; onCompositionEnd(...values: unknown[]): unknown;
}
export interface RootHook {
  unsubscribe?: unknown;current?: unknown; value?: unknown; deps?: readonly unknown[];
  callback?(): void | (() => void);
  effect?(): void | (() => void); fn?(): void | (() => void);
  cleanup?: void | (() => void);
}
// Evaluated modules retain their real export names, arguments and nullable
// results. Only React's element representation changes under the test peer.
export type RootViewResult<Result> = Result extends import('react').ReactElement ? RootNode : Result;
export type RootModule<Module> = {
  [Export in keyof Module]: Module[Export] extends (...args:infer Args)=>infer Result
    ? (...args:Args)=>RootViewResult<Result>
    : Module[Export];
};
export interface RootControlledModules {
  'TargetMarkLayer.tsx': typeof import('../../apps/web/src/TargetMarkLayer.tsx');
  'RecoveryStorageDetails.tsx': typeof import('../../apps/web/src/RecoveryStorageDetails.tsx');
  'TaskCenter.tsx': typeof import('../../apps/web/src/TaskCenter.tsx');
  'TaskWorkspace.tsx': typeof import('../../apps/web/src/TaskWorkspace.tsx');
  'TaskRenderList.tsx': typeof import('../../apps/web/src/TaskRenderList.tsx');
  'PendingSubmission.tsx': typeof import('../../apps/web/src/PendingSubmission.tsx');
  'TimelineSourceBanner.tsx': typeof import('../../apps/web/src/TimelineSourceBanner.tsx');
  'TimelineExportPreflight.tsx': typeof import('../../apps/web/src/TimelineExportPreflight.tsx');
  'SettingsExtraPages.tsx': typeof import('../../apps/web/src/SettingsExtraPages.tsx');
  'SettingsVideoTools.tsx': typeof import('../../apps/web/src/SettingsVideoTools.tsx');
  'SettingsWorkspace.tsx': typeof import('../../apps/web/src/SettingsWorkspace.tsx');
  'ProjectHomeConnections.tsx': typeof import('../../apps/web/src/ProjectHomeConnections.tsx');
  'workspace-visibility.tsx': typeof import('../../apps/web/src/workspace-visibility.tsx');
  'WebSettingsCenter.tsx': typeof import('../../apps/web/src/WebSettingsCenter.tsx');
  'SubtitleInspector.tsx': typeof import('../../apps/web/src/SubtitleInspector.tsx');
  'SubtitleLane.tsx': typeof import('../../apps/web/src/SubtitleLane.tsx');
  'TopbarSaveStatus.tsx': typeof import('../../apps/web/src/TopbarSaveStatus.tsx');
}
export interface RootMediaElement {offsetWidth:number;offsetHeight:number;style:Record<string,string>;dataset:Record<string,string>;[key:string]:unknown}
export interface RootDeferred<T=unknown> {promise:Promise<T>;resolve(value?:T):void;reject(reason?:unknown):void}
export interface RootNavigationApi {inspect(id:string,tab?:string,versionId?:string,options?:{reveal?:boolean}):Promise<boolean>;selectClip(id:string,reveal?:boolean):Promise<boolean>}
export interface RootEditorApi {runSession(...args:unknown[]):Promise<unknown>;createProject(name?:string,description?:string):Promise<unknown>}
export interface RootTopbarView {Component(props:unknown):RootNode;React:{Fragment:unknown;Children:{toArray(value:unknown):RootNode[]};createElement(type:unknown,props:unknown):unknown};Button:unknown;renderToStaticMarkup(tree:unknown):string;render(props:unknown):string}
export interface RootTopbarActions {selectProject(projectId:string|null,...options:boolean[]):Promise<unknown>;reloadPreferences():Promise<unknown>}
export type RootTopbarExpression<E extends string> = E extends 'project'?(env:unknown)=>RootNode:E extends '{ selectProject, reloadPreferences }'?RootTopbarActions:(...args:unknown[])=>unknown;
export interface RootModalElement {attributes:Record<string,string|undefined>;parent:RootModalElement|null;closest(selector:string):RootModalElement|null}
export interface RootWorkspaceBackupStatus {phase:string;directory:string;automatic:boolean;intervalHours:number;lastBackupAt:string|null;nextBackupAt:string|null;lastError:string|null;backups:{id:string;createdAt:string;payloadBytes:number}[];pendingRestore:{state:string;restartRequired:boolean}|null}
