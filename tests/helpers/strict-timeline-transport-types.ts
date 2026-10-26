import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import type {OperationDefinition} from '@mioon/client';
import type {DiscoverySchemaResult} from '@mioon/client';
import type {ServiceResponse} from './strict-service-responses.ts';
import type {Failure} from './strict-timeline-audio-types.ts';
export interface SchemaNode {
 [key:string]:unknown;$ref?:string;type?:string;const?:unknown;enum?:unknown[];
 properties:Record<string,SchemaNode>;required:string[];additionalProperties?:boolean;
 items?:SchemaNode;anyOf?:SchemaNode[];oneOf?:SchemaNode[];allOf?:SchemaNode[];
 minimum?:number;maximum?:number;maxItems?:number;maxLength?:number;pattern?:string;format?:string;
}
export type TestOperationDefinition=Omit<OperationDefinition,'inputSchema'> & {inputSchema:SchemaNode};
export type TestCatalog=Omit<DiscoverySchemaResult,'operations'> & {operations:TestOperationDefinition[]};
export type TestTool=Omit<Tool,'inputSchema'> & {inputSchema:SchemaNode};
type JoinCommand<A extends readonly unknown[]> = A extends readonly [infer H extends string,...infer T] ? H extends `--${string}` ? '' : T extends [] ? H : JoinCommand<T> extends infer R extends string ? R extends '' ? H : `${H}.${R}` : never : '';
export type CliResult<A extends readonly unknown[]> = A extends readonly ['rpc',infer O extends string,...unknown[]] ? ServiceResponse<O> : A extends readonly ['schema'] ? TestCatalog : A extends readonly ['schema',...unknown[]] ? TestOperationDefinition : ServiceResponse<JoinCommand<A>>;
type ToolOperation<N extends string> = N extends `${infer A}_${infer B}` ? `${A}.${ToolOperation<B>}` : N;
export type McpData<N extends string,I> = N extends 'mioon_schema' ? I extends {operation:string} ? TestOperationDefinition : TestCatalog : ServiceResponse<ToolOperation<N>>;
export type WireResult<T,E> = E extends undefined ? T : Failure;
export interface RpcEnvelope<T=unknown> {ok:boolean;data:T;error:Failure}
export type TransportCall=<O extends string,E extends string|undefined=undefined>(operation:O,input:unknown,error?:E)=>Promise<WireResult<ServiceResponse<O>,E>>;
export type EnvelopeTransportCall=<O extends string>(operation:O,input:unknown)=>Promise<RpcEnvelope<ServiceResponse<O>>>;
