import type {selectedRangeFixture as originalFixture} from '../fixtures/selected-range-http-fixture.ts';
import type {createLocalDelivery} from '../../packages/business/src/local-delivery.ts';
import type {LocalDeliveryEnvelope, LocalDeliveryExecution, LocalDeliveryPrepare} from '../../packages/contracts/src/local-delivery.ts';
import type {MediaProcessEvent} from '../../packages/business/src/media-processes.ts';
import type {FixtureProject, FixtureTimeline, FixtureAsset, FixtureExport} from './strict-timeline-core-types.ts';
import type {TypedServices, TypedStore, ServiceResponse} from './strict-service-responses.ts';
import type {RpcEnvelope} from './strict-timeline-audio-types.ts';
import type {SQLOutputValue} from 'node:sqlite';
export type DeliveryEnvelope = Extract<LocalDeliveryEnvelope,{supported:true}>;
export type DeliveryExecution = Omit<LocalDeliveryExecution,'envelope'|'response'> & {envelope:DeliveryEnvelope;response:FixtureExport|null};
interface FileEntry {directory?:string;name?:string;hash?:string}
interface Checkpoint {rows:Record<string,unknown[]>;files:FileEntry[]}
interface Observation {path:string;body:unknown;status:number|undefined}
export interface SelectedRangeFixture {
 root:string;project:FixtureProject;timeline:FixtureTimeline;sources:FixtureAsset[];
 dispatches:LocalDeliveryPrepare['input'][];submissions:unknown[];observations:Observation[];media:MediaProcessEvent[];capabilityChecks:unknown[];
 file:string;store:TypedStore;services:TypedServices;delivery:ReturnType<typeof createLocalDelivery>;url:string;
 rows():Record<string,unknown[]>;receipt(requestId:string):Record<string,SQLOutputValue>|undefined;
 checkpoint():Promise<Checkpoint>;unchanged(before:unknown):Promise<void>;
 request<T=unknown>(suffix:string,options?:{method?:string;input?:unknown;signal?:AbortSignal}):Promise<{status:number;body:RpcEnvelope<T>}>;
 rpc<O extends string>(operation:O,input:unknown,options?:Record<string,unknown>):Promise<RpcEnvelope<ServiceResponse<O>>>;
 local<S extends string = ''>(suffix?:S,input?:unknown):Promise<S extends '/execute'|'/recover' ? DeliveryExecution : DeliveryEnvelope>;
 prepare(value:DeliveryEnvelope,extra?:Record<string,unknown>):LocalDeliveryPrepare;
 lose(suffix:string):void;malformRange(kind:'removed'|'incremented'):void;fault(fn:(point:string)=>void):void;
 restart(between?:()=>Promise<unknown>):Promise<void>;assertNoWorker():Promise<void>;
 armCancellation():Promise<{entered:Promise<void>;aborted:Promise<void>;settled:Promise<void>;clear():Promise<void>}>;
}
export type SelectedRangeFixtureFactory = (...args:Parameters<typeof originalFixture>)=>Promise<SelectedRangeFixture>;
