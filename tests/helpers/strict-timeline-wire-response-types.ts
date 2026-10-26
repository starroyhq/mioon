import type {LutImportResponse,LutListResponse,LutInspectResponse} from '../../packages/contracts/src/lut-resources.ts';
import type {ServiceResponse} from './strict-service-responses.ts';
import type {McpData,RpcEnvelope} from './strict-timeline-transport-types.ts';
import type {RootFailure} from './strict-root-error-types.ts';
export interface ProcessOutcome {code:number|null;signal:NodeJS.Signals|null}
export interface BackendReady {type:'ready';url:string;pid:number}
export type IpcMessage=BackendReady|{type:'reply';id:string;data:{phases:unknown[];armed?:boolean}}|{type:'fatal';message:string};
export interface WireMessage {event:string;ready?:boolean;url:string;pid:number;type:string;phase:string;ok:boolean;data:unknown;error:RootFailure}
export type WireData<O extends string,I=unknown>=O extends 'mioon_schema'?McpData<O,I>:O extends 'lut.import'?LutImportResponse:O extends 'lut.list'?LutListResponse:O extends 'lut.inspect'?LutInspectResponse:ServiceResponse<O>;
export type WireEnvelope<O extends string,I=unknown>=RpcEnvelope<WireData<O,I>>;
export type WireCall=<O extends string,I=unknown>(operation:O,input?:I,error?:string)=>Promise<WireEnvelope<O,I>>;
export type PipedProcess=import('node:child_process').ChildProcessByStdio<null,import('node:stream').Readable,import('node:stream').Readable>;
export type SqlRows=Record<string,Record<string,import('node:sqlite').SQLOutputValue>[]>;
