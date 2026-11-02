import type {IncomingHttpHeaders} from 'node:http';
import type {SQLInputValue} from 'node:sqlite';
import type {AgentTimelineGainTarget, AgentTimelineGainProposal} from '../../packages/contracts/src/agent-timeline-gain.ts';
import type {AgentTimelineMoveTarget, AgentTimelineMoveProposal} from '../../packages/contracts/src/agent-timeline-move.ts';
import type {FixtureServices, FixtureStore, FixtureTimeline, FixtureClip, FixtureProject, FixtureShot, FixtureAsset, FixtureCall, FixtureServiceResult} from './strict-timeline-core-types.ts';
import type {startEditWireModel} from './agent-edit-wire-model.ts';
import type {OwnedEditBackend, OwnedFixtureLifetime, fixtureHttpRequest} from './agent-edit-wire-lifecycle.ts';
export type Mutable<T> = T extends (...args: never[])=>unknown ? T : T extends readonly (infer I)[] ? Mutable<I>[] : T extends object ? {-readonly [K in keyof T]: Mutable<T[K]>} : T;
export interface Failure extends Error {code: string; status?: number; details: Record<string, unknown>}
export interface ProposalOutcome {status: string; timelineId?: string; clipId?: string; shotId?: string; revision?: number; code?: string}
export type ProposalKind = 'gain'|'move'|'shot';
interface ShotProposal {id: string;projectId: string;runId: string;digest: string;status: string;runStatus: string;operation: string;target: {projectId: string;shotId: string;expectedRevision: number};patch: {title?: string;prompt?: string};diff: {before: {title: string;prompt: string};after: {title: string;prompt: string}};provenance: {runId: string;toolCallId: string;toolName: string};createdAt: string;updatedAt: string;approval?: {approvedAt: string;requestId: string}}
export type Proposal<K extends ProposalKind> = Mutable<Omit<K extends 'gain' ? AgentTimelineGainProposal : K extends 'move' ? AgentTimelineMoveProposal : ShotProposal,'outcome'>> & {outcome?: ProposalOutcome};
export interface TimelineReceipt {requestId: string;projectId: string;operation: string;requestHash: string;response: string;createdAt: string;[key: string]: SQLInputValue}
export interface WireFunction {name: string;arguments: string}
export interface WireItem {id: string;role: string;type: string;content: string;call_id: string;tool_call_id: string;name: string;arguments: string;output: string;tool_calls: WireItem[];function: WireFunction;[key: string]: unknown}
export interface WireProperty {type: string|string[];minimum?: number;maximum?: number;maxLength?: number;description?: string}
export interface WireDefinition {name: string;type: string;strict?: boolean;description: string;parameters: {type: string;properties: Record<string,WireProperty>;required: string[];additionalProperties: boolean};function: WireDefinition}
export interface WireCapture {id: number;protocol: string;phase: string;callId: string;method: string|undefined;path: string|undefined;headers: IncomingHttpHeaders;closed: boolean;completed: boolean;body: {instructions:string;model:string;input: WireItem[];messages: WireItem[];tools: WireDefinition[];stream: boolean;store?: boolean;tool_choice?: unknown;[key: string]: unknown}}
export type WireModel = Omit<Awaited<ReturnType<typeof startEditWireModel>>,'captures'> & {captures: WireCapture[]};
export interface Selection {project: FixtureProject;timeline: FixtureTimeline;clip: FixtureClip;clipId: string;sources: FixtureAsset[]}
export interface WireInput {requestId: string;instanceId: string;expectedSettingsRevision: number;expectedConversationRevision: number;message: string;consent: {reviewTarget: Record<string,unknown>;[key: string]: unknown};[key: string]: unknown}
type UnionToIntersection<U> = (U extends unknown ? (value: U)=>void : never) extends (value: infer I)=>void ? I : never;
export type MutationInput<F extends (...args: never[])=>unknown> = UnionToIntersection<Parameters<F>[0]>;

export type SettingsStub = Pick<import('../../packages/business/src/agent/settings.ts').AgentSettingsService,'get'|typeof import('../../packages/business/src/agent/settings.ts').AGENT_CREDENTIAL_ACQUIRE>;
export interface HttpCapture {path?: string;method?: string;headers: IncomingHttpHeaders;body: WireCapture['body']}
export interface ProviderPart {type: string;text?: string;refusal?: string;annotations?: unknown[];logprobs?: unknown[];[key: string]: unknown}
export interface ProviderItem {id: string;type: string;role?: string;status?: string;content?: ProviderPart[];call_id?: string;name?: string;arguments?: string;[key: string]: unknown}
export interface ProviderResponse {id: string;object: string;status: string;output: ProviderItem[];error: unknown;incomplete_details: unknown;reasoning?: unknown;[key: string]: unknown}
export interface ProviderDelta {role?: string;content?: string|null;reasoning_content?: string;tool_calls?: {index: number;id?: string;type?: string;function?: {name?: string;arguments?: string;[key:string]:unknown};[key:string]:unknown}[];[key:string]:unknown}
export interface ProviderEvent {type?: string;choices?: {index: number;delta: ProviderDelta;finish_reason: string|null;[key: string]: unknown}[];sequence_number?: number;response?: ProviderResponse;item?: ProviderItem;output_index?: number;content_index?: number;item_id?: string;part?: ProviderPart;delta?: string;text?: string;arguments?: string;[key: string]: unknown}
export type MockIncoming = import('node:stream').Readable & {statusCode?: number;headers: IncomingHttpHeaders};
export type MockRequest = import('node:events').EventEmitter & {setTimeout(milliseconds?: number,handler?: ()=>void): void;destroy(): void;end(body?: string): void};
export interface MockRequestState {lookups:number;requests:number;bodyWrites:number;fences:number;changed:boolean;socketDestroyed?:boolean;requestDestroyed?:boolean;calls: number;ends: number;destroyed: boolean;request(options: import('node:https').RequestOptions,callback: (incoming: MockIncoming)=>void): MockRequest;options: import('node:https').RequestOptions & {autoSelectFamily?: boolean;headers: Record<string,string>;lookup(hostname: string,options: Record<string,unknown>,callback: (error: unknown,address: unknown,family?: unknown)=>void): void;checkServerIdentity(hostname: string,certificate: unknown): Error|undefined};body: WireCapture['body'];response: MockIncoming;timeout?: ()=>void;payload: unknown}
export interface PersistedSettings {version: unknown;revision: number;configuration: import('../../packages/business/src/agent/config.ts').AgentConfiguration;secret: {binding: string;encrypted: string}|null;[key: string]: unknown}
export interface ShotMutationInput {projectId?: string;shotId: string;expectedRevision: number;requestId: string;patch: {title?: string;prompt?: string}}
export interface SchemaObject {type: string;name: string;tbl_name: string;sql: string|null}
export type SqlRow = Record<string,import('node:sqlite').SQLOutputValue>;
export interface FrozenSource {text: string;sha256: string}
export interface FrozenBaseline {sourceCommit: string;objects: SchemaObject[];tables: Record<string,SqlRow[]>;sequence: {__rowid__: number;name: string;seq: number}[];media: {relativePath: string;base64: string};sources: Record<string,FrozenSource>;dependencyHashes: Record<string,string>;substitutions: {canonicalSource: string};projectId: string;proposals: {id: string;digest: string;version: number}[];catalogs: Record<string,{definitions: string;hash: string;policy: unknown}>}
export interface FrozenClosure {sourceCommit: string;sources: Record<string,FrozenSource>;dependencyHashes: Record<string,string>}
export interface HistoricalDelta48 {objectSql: Record<string,string>;lifecycleObjects: SchemaObject[];lutCatalog: {count: number;sha256: string};annotationCatalog: {count: number;sha256: string};lifecycleCatalog: {count: number;sha256: string}}
export interface RuntimeTarget {projectId?: string;shotId?: string;timelineId?: string;expectedRevision?: number;title?: string;prompt?: string;clip?: FixtureClip;track?: FixtureTimeline['tracks'][number];[key: string]: unknown}
export interface HttpFixtureRequest {method?:string;input?:unknown;payload?:unknown;raw?:string;authenticated?:boolean;headers?:Record<string,string>}
export interface AgentHttpCapture extends HttpCapture {closed?:boolean;completed?:boolean;lateAttempted?:boolean;messages?:WireItem[]}
export interface BackendMessage {type:string;pid:number;url:string;requestId:string;acquisitions:number;message:string}
export interface BackendExit {code:number|null;signal:NodeJS.Signals|null}
export interface BackendInstance {child:import('node:child_process').ChildProcess;exited:Promise<BackendExit>;readonly acquisitions:number;readonly output:string;observe():Promise<number>;crash():Promise<BackendExit>;close():Promise<BackendExit>;url:string}
