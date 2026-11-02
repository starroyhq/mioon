import type {FixtureSnapshot as importTypeFixtureSnapshot,FixtureExport as importTypeFixtureExport} from './strict-timeline-core-types.ts';
import type {Failure} from './strict-agent-workspace-types.ts';
import type {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import type {EditTask} from '../../packages/contracts/src/edit-tasks.ts';
import type {FixtureTimeline} from './strict-timeline-core-types.ts';
import type {TypedServices} from './strict-service-responses.ts';
export type OpacityServiceResponse<O extends string> = O extends 'asset.get'?import('./strict-timeline-core-types.ts').FixtureAsset:O extends 'project.get'?import('./strict-service-responses.ts').ProjectState&{restore:{workspaceOrigin:string;heldExportIds:string[]}}:O extends 'timeline.render'|'export.get'?OpacityExport:import('./strict-service-responses.ts').ServiceResponse<O>;
export type OpacityServices = Omit<TypedServices,'call'>&{call<O extends string>(operation:O,input:unknown,context?:Parameters<TypedServices['call']>[2]):Promise<OpacityServiceResponse<O>>};
export interface OpacityTaskInput {projectId:string;requestId:string;clipId?:string;expectedRevision?:number;patch?:Record<string,unknown>;[key:string]:unknown}
export interface OpacityTaskEnvelope {instanceId:string;task:Omit<EditTask,'input'>&{input:OpacityTaskInput};result?:FixtureTimeline;restore?:{workspaceOrigin:string;executionEpoch:string;held:boolean}}
type Tasks=ReturnType<typeof createEditTasks>;
export type OpacityTasks=Omit<Tasks,'prepare'|'execute'|'get'|'reconcile'|'acknowledge'|'list'>&{
 prepare(...args:Parameters<Tasks['prepare']>):OpacityTaskEnvelope;
 execute(...args:Parameters<Tasks['execute']>):Promise<OpacityTaskEnvelope>;
 get(...args:Parameters<Tasks['get']>):OpacityTaskEnvelope;
 reconcile(...args:Parameters<Tasks['reconcile']>):OpacityTaskEnvelope;
 acknowledge(...args:Parameters<Tasks['acknowledge']>):OpacityTaskEnvelope;
 list(...args:Parameters<Tasks['list']>):{instanceId:string;items:OpacityTaskEnvelope['task'][];nextCursor:string|null;restore?:{workspaceOrigin:string;tasks:{taskId:string;executionEpoch:string;held:boolean}[]}};
};
export interface OpacityFailure extends Failure {reason?:string;lostAck?:boolean;definitive?:boolean;cleanupUnconfirmed?:boolean;details:Record<string,unknown>&{publication:OpacityFailure['publication']};publication:{state:string;restorationId:string;sourceBackupId:string;manifestHash:string;sourceDbHash:string;targetDbHash:string;[key:string]:unknown};mutationOutcome?:string;retryable?:boolean}
export interface OpacitySnapshot extends importTypeFixtureSnapshot {opacityPlan?:import('../../packages/contracts/src/timeline-opacity-render-candidate.ts').OpacityRenderCandidatePlan}
export interface OpacityExport extends Omit<importTypeFixtureExport,'snapshot'> {snapshot:OpacitySnapshot}
