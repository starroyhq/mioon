export type WorkspaceBackupResult=ReturnType<typeof import('../../packages/contracts/src/workspace-backup.ts').workspaceBackupResultSchema.parse>;
export type WorkspaceRestoreResult=ReturnType<typeof import('../../packages/contracts/src/workspace-restore-offline.ts').workspaceRestoreOfflineResultSchema.parse>;
export type WorkspaceRestoreStatus=ReturnType<typeof import('../../packages/contracts/src/workspace-restore-offline.ts').workspaceRestorePublicationStatusSchema.parse>;
export type WorkspaceInspection=import('../../packages/contracts/src/workspace-restore.ts').WorkspaceRestoreInspection;
export type WorkspaceResponse<O extends string>=O extends 'workspace.restore.inspect'?WorkspaceInspection:import('./strict-service-responses.ts').ServiceResponse<O>;
export type WorkspaceServices=Omit<import('./strict-service-responses.ts').TypedServices,'call'|'handlers'>&{call<O extends string>(operation:O,input:unknown,context?:import('../../packages/business/src/services.ts').ServiceHandlerContext):Promise<WorkspaceResponse<O>>;handlers:Record<string,(input:unknown,context?:import('../../packages/business/src/services.ts').ServiceHandlerContext)=>Promise<unknown>>};
export interface SchemaObject {type:string;name:string;tbl_name:string;sql:string|null}
export interface SchemaSnapshot {objects:SchemaObject[];tables:Record<string,{fields:readonly string[];rows:(readonly string[])[]}>}
export type SchemaFacade=(db:import('node:sqlite').DatabaseSync,hook:(event:{index:number;sql:string;phase:'before'|'after'})=>unknown)=>import('node:sqlite').DatabaseSync;
export interface PreferenceState {projectId:string;revision:number;state:import('../../apps/web/src/workspace-state.ts').WorkspaceState|null}
export type PreferenceService=Omit<ReturnType<typeof import('../../packages/business/src/workspace-preferences.ts').createWorkspacePreferences>,'get'|'put'>&{get(...args:Parameters<ReturnType<typeof import('../../packages/business/src/workspace-preferences.ts').createWorkspacePreferences>['get']>):PreferenceState;put(projectId:unknown,input:unknown,context?:Record<string,unknown>):PreferenceState&{state:import('../../apps/web/src/workspace-state.ts').WorkspaceState}};
export interface PreferenceCall {url?:string;projectId:string;options:RequestInit;body:{expectedRevision:number;state:import('../../apps/web/src/workspace-state.ts').WorkspaceState;expectedWorkspaceOrigin?:string}}
export interface PreferenceResponse {ok:boolean;status:number;json():Promise<unknown>}
export type PreferenceHook=(call:PreferenceCall,apply:()=>PreferenceResponse)=>unknown;
export type PreferenceOptions=Omit<import('../../apps/web/src/workspace-preferences.ts').WorkspacePreferencesOptions,'fetchImpl'|'setTimeout'|'clearTimeout'>&{fetchImpl?:{invoke(...args:Parameters<typeof fetch>):unknown}['invoke'];setTimeout?:(fn:()=>void,delay:number)=>number;clearTimeout?:(id:unknown)=>void};
export interface MutableColourSource {assetSha256:string;profileId:string;streamIndex?:number;range?:string;declaredBy:string;declaredAt:string;interpretation?:string;evidence?:{profileId:string;sha256:string;sourceByteLength:number;width:number;height:number;bitDepth:number;alphaMode:string;orientation:number;colourTag:string;sampling?:string;decoderPolicy?:string;[key:string]:unknown}}
export interface MutableColour {profileId:string;source:MutableColourSource|null;look:{resourceId:string;resourceSha256:string;resourceProfile:string;purpose:string;declaredBy:string;enabled:boolean;strength:number}|null}
export interface MutableClip extends Omit<importTypeFixtureClip,'colour'> {name:string;assetId:string;colour:MutableColour|null}
export interface MutableTimeline extends Omit<importTypeFixtureTimeline,'clips'> {clips:MutableClip[]}
import type {FixtureClip as importTypeFixtureClip,FixtureTimeline as importTypeFixtureTimeline} from './strict-timeline-core-types.ts';
export interface ChildOutcome {code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string}
export type SpawnChild=(command:string,args:readonly string[],options?:import('node:child_process').SpawnOptions)=>import('node:child_process').ChildProcessWithoutNullStreams;
export interface CurrentOrdinary48 {objectSql:Record<string,string>;lutCatalog:{count:number;sha256:string};annotationCatalog:{count:number;sha256:string};lifecycleObjects:SchemaObject[];lifecycleCatalog:{count:number;sha256:string};lifecycleTables:Record<string,{fields:string[];rows:unknown}>;schemaVersionRows:string[][]}
export type PinIntent=<T extends object>(intent:T,workspace:Parameters<typeof import('../../apps/web/src/workspace-origin.ts').pinNewWorkspaceIntent>[1])=>T&{readonly expectedWorkspaceOrigin?:string};
export type TaskControllerOptions=Omit<NonNullable<Parameters<typeof import('../../apps/web/src/edit-task-controller.ts').createEditTaskController>[0]>,'client'>&{client:Partial<{[K in keyof import('../../apps/web/src/edit-task-client.ts').EditTaskClient]:{invoke(...args:Parameters<import('../../apps/web/src/edit-task-client.ts').EditTaskClient[K]>):unknown}['invoke']}>};
export type TaskClientOptions=Omit<NonNullable<Parameters<typeof import('../../apps/web/src/edit-task-client.ts').createEditTaskClient>[0]>,'fetcher'>&{fetcher?:{invoke(...args:Parameters<typeof fetch>):unknown}['invoke']};
export type HistoryOperation='image.task.list'|'image.task.get'|'image.group.list'|'image.group.get'|'image.version.list'|'image.version.get'|'image.request.get'|'frame.task.list'|'frame.task.get'|'frame.request.get'|'asset.waveform.get';
export type HistoryHandlers<Operation extends HistoryOperation>={[O in Operation]:(input:unknown,context?:unknown)=>import('./strict-service-responses.ts').ServiceResponse<O>};
export type ImageHistory=Omit<ReturnType<typeof import('../../packages/business/src/images/history.ts').createImageHistoryReaders>,'handlers'>&{handlers:HistoryHandlers<Extract<HistoryOperation,`image.${string}`>>};
export type FrameHistory=Omit<ReturnType<typeof import('../../packages/business/src/frames-history.ts').createFrameHistoryReaders>,'handlers'>&{handlers:HistoryHandlers<Extract<HistoryOperation,`frame.${string}`>>};
export type WaveformHistory=Omit<ReturnType<typeof import('../../packages/business/src/waveforms-history.ts').createWaveformHistoryReaders>,'handlers'>&{handlers:HistoryHandlers<'asset.waveform.get'>};
export interface WireEnvelope<Data=unknown> {ok:boolean;data:Data;error:import('./strict-agent-workspace-types.ts').Failure}
export type WorkspaceTransportCall=<O extends string>(operation:O,input:unknown,selected?:string)=>Promise<WireEnvelope<WorkspaceResponse<O>>>;
export type WorkspaceRouteData<Route extends string>=Route extends '/api/tasks/prepare'|`/api/tasks/${string}`?import('./strict-opacity-fixture-types.ts').OpacityTaskEnvelope:unknown;
export interface SchemaEvent {index:number;phase:'before'|'after';sql:string}
export type WorkspaceClient=Omit<import('./strict-service-responses.ts').TypedClient,'rpc'>&{rpc<O extends string>(operation:O,input?:unknown,options?:Omit<NonNullable<Parameters<ReturnType<typeof import('../../packages/client/src/index.ts').createClient>['rpc']>[2]>,'expectedWorkspaceOrigin'>&{expectedWorkspaceOrigin?:unknown}):Promise<WorkspaceResponse<O>>};
export type WorkspaceClientOptions=Omit<NonNullable<Parameters<typeof import('../../packages/client/src/index.ts').createClient>[0]>,'fetchImpl'>&{fetchImpl?:{invoke(...args:Parameters<typeof fetch>):unknown}['invoke'];expectedWorkspaceOrigin?:unknown};

export interface SchemaRowsSnapshot {objects:SchemaObject[];tables:Record<string,import('./strict-agent-workspace-types.ts').SqlRow[]>}
export interface RestoreMetadata {heldCounts:Record<string,number>;restorationId:string;workspaceOrigin:string;sourceBackupId:string;manifestHash:string;sourceDbHash:string;createdAt:string;schemaVersion:number;sourceSchema:number;profile:string}
