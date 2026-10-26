import type {TestContext} from 'node:test';
import type {SQLInputValue} from 'node:sqlite';
import type {EditTask} from '../../packages/contracts/src/edit-tasks.ts';
import type {createEditTasks} from '../../packages/business/src/edit-tasks.ts';
import type {FixtureProject,FixtureAsset} from './strict-timeline-core-types.ts';
import type {TypedStore,TypedServices,ServiceResponse,MediaShot} from './strict-service-responses.ts';
import {subjectFixture as originalSubjectFixture} from '../subject-recovery-fixture.mjs';

export type SubjectTask<O extends string=string>=Omit<EditTask,'operation'>&{operation:O};
export interface PreparedSubjectTask<O extends string=string>{task:SubjectTask<O>;instanceId:string}
export interface ExecutedSubjectTask<O extends string=string> extends PreparedSubjectTask<O>{result:ServiceResponse<O>}
type FixtureTasks=Omit<ReturnType<typeof createEditTasks>,'prepare'|'execute'|'get'|'list'|'acknowledge'|'reconcile'>&{
  prepare(input:unknown):PreparedSubjectTask;
  execute(input:unknown):Promise<ExecutedSubjectTask>;
  get(input:unknown):PreparedSubjectTask;
  list(input:unknown):{items:EditTask[];instanceId:string;nextCursor:string|null};
  acknowledge(input:unknown):PreparedSubjectTask;
  reconcile(input:unknown):ExecutedSubjectTask;
};
type RecoveryAsset=Omit<FixtureAsset,'url'|'sizeBytes'>;
interface SubjectRecoveryFixture {
 root:string;project:FixtureProject;other:FixtureProject;store:TypedStore;services:TypedServices;tasks:FixtureTasks;calls:number;
 source:RecoveryAsset;shot:MediaShot;
 setFault(fn:(label:string)=>void):void;
 setDispatch(fn:((operation:string,input:unknown,services:TypedServices)=>unknown)|undefined):void;
 restart():void;
 asset(patch?:Record<string,unknown>):RecoveryAsset;
 row(task:Pick<EditTask,'id'>):Record<string,SQLInputValue>|undefined;
 request(task:EditTask):{projectId:string;taskId:string;digest:string};
 execute<O extends string>(envelope:PreparedSubjectTask<O>|undefined):Promise<ExecutedSubjectTask<O>>;
 ack<O extends string>(task:SubjectTask<O>):PreparedSubjectTask<O>;
 prepare<O extends string>(operation:O,input:unknown,origin?:string):PreparedSubjectTask<O>;
 snapshot():string;
 createInput(patch?:Record<string,unknown>):{projectId:string;kind:string;name:string;assetId:string;requestId:string};
}
// Expose the same frozen fixture function through its actual public test seam.
export const subjectFixture=originalSubjectFixture as unknown as (t:TestContext,options?:{limits?:Record<string,number>})=>Promise<SubjectRecoveryFixture>;
