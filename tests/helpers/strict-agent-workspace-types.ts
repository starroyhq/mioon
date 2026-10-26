import type {IncomingHttpHeaders} from 'node:http';
import type {SQLInputValue} from 'node:sqlite';
import type {AgentEditService, EditProposalRow} from '../../packages/business/src/agent/edit-proposals.ts';
import type {ChatRun, ChatActivityEntry} from '../../packages/business/src/agent/chat-journal.ts';
import type {AgentTimelineGainTarget, AgentTimelineGainProposal} from '../../packages/contracts/src/agent-timeline-gain.ts';
import type {AgentTimelineMoveTarget, AgentTimelineMoveProposal} from '../../packages/contracts/src/agent-timeline-move.ts';
import type {FixtureServices, FixtureStore, FixtureTimeline, FixtureClip, FixtureProject, FixtureShot, FixtureAsset, FixtureCall, FixtureServiceResult} from './strict-timeline-core-types.ts';
import type {agentTimelineGainFixture} from './agent-timeline-gain-fixture.ts';
import type {agentTimelineMoveFixture} from './agent-timeline-move-fixture.ts';
import type {startEditWireModel} from './agent-edit-wire-model.ts';
import type {OwnedEditBackend, OwnedFixtureLifetime, fixtureHttpRequest} from './agent-edit-wire-lifecycle.ts';
export type Mutable<T> = T extends (...args: never[])=>unknown ? T : T extends readonly (infer I)[] ? Mutable<I>[] : T extends object ? {-readonly [K in keyof T]: Mutable<T[K]>} : T;
export interface Failure extends Error {code: string; status?: number; details: Record<string, unknown>}
export interface ProposalOutcome {status: string; timelineId?: string; clipId?: string; shotId?: string; revision?: number; code?: string}
export type ProposalKind = 'gain'|'move'|'shot';
interface ShotProposal {id: string;projectId: string;runId: string;digest: string;status: string;runStatus: string;operation: string;target: {projectId: string;shotId: string;expectedRevision: number};patch: {title?: string;prompt?: string};diff: {before: {title: string;prompt: string};after: {title: string;prompt: string}};provenance: {runId: string;toolCallId: string;toolName: string};createdAt: string;updatedAt: string;approval?: {approvedAt: string;requestId: string}}
export type Proposal<K extends ProposalKind> = Mutable<Omit<K extends 'gain' ? AgentTimelineGainProposal : K extends 'move' ? AgentTimelineMoveProposal : ShotProposal,'outcome'>> & {outcome?: ProposalOutcome};
export type TypedEdits<K extends ProposalKind> = Omit<AgentEditService,'get'|'createInside'|'approve'|'reject'|'recover'|'list'|'pinTarget'> & {
 pinTarget(projectId: string,input: unknown): import('../../packages/business/src/agent/edit-proposals.ts').EditProposalTarget;get(input: unknown): Proposal<K>;createInside(input: Parameters<AgentEditService['createInside']>[0]): Proposal<K>;
 approve(input: unknown): Promise<Proposal<K>>;reject(input: unknown): Proposal<K>;recover(input: unknown): Promise<Proposal<K>>;
 list(input: unknown): {proposals: Proposal<K>[];nextCursor: string|null};
};
export interface ProposalRow extends EditProposalRow {definition: string}
export interface TimelineReceipt {requestId: string;projectId: string;operation: string;requestHash: string;response: string;createdAt: string;[key: string]: SQLInputValue}
type FixtureBase<K extends 'gain'|'move'> = Awaited<ReturnType<K extends 'gain' ? typeof agentTimelineGainFixture : typeof agentTimelineMoveFixture>>;
type Prepared<K extends 'gain'|'move'> = Omit<ReturnType<FixtureBase<K>['prepare']>,'target'|'toolCall'> & {toolCall: Parameters<AgentEditService['createInside']>[0]['toolCall'];target: Mutable<K extends 'gain' ? AgentTimelineGainTarget : AgentTimelineMoveTarget>};
export type TimelineFixture<K extends 'gain'|'move'> = Omit<FixtureBase<K>,'timeline'|'clip'|'current'|'store'|'services'|'edits'|'second'|'create'|'proposal'|'row'|'finish'|'prepare'|'receipts'|'setDispatch'> & {
 timeline: FixtureTimeline;clip: FixtureClip;store: FixtureStore;services: Omit<FixtureServices,'moveTimelineClipInProject'|'setTimelineClipGainInProject'> & {moveTimelineClipInProject(...args: Parameters<FixtureServices['moveTimelineClipInProject']>): FixtureTimeline;setTimelineClipGainInProject(...args: Parameters<FixtureServices['setTimelineClipGainInProject']>): FixtureTimeline};edits: TypedEdits<K>;
 setDispatch(fn: Parameters<FixtureBase<K>['setDispatch']>[0]|null): void;current(): FixtureTimeline;second(): TypedEdits<K>;prepare(changes?: Record<string,unknown>,fields?: Record<string,unknown>): Prepared<K>;
 create(prepared: Prepared<K>): Proposal<K>;proposal(changes?: Record<string,unknown>,status?: string): Proposal<K>;
 row(proposal: {id: string}): ProposalRow;receipts(): TimelineReceipt[];
 finish(prepared: Prepared<K>,proposal: {id: string;digest: string}|null|undefined,status?: string): void;
};
export interface WireFunction {name: string;arguments: string}
export interface WireItem {id: string;role: string;type: string;content: string;call_id: string;tool_call_id: string;name: string;arguments: string;output: string;tool_calls: WireItem[];function: WireFunction;[key: string]: unknown}
export interface WireProperty {type: string|string[];minimum?: number;maximum?: number;maxLength?: number;description?: string}
export interface WireDefinition {name: string;type: string;strict?: boolean;description: string;parameters: {type: string;properties: Record<string,WireProperty>;required: string[];additionalProperties: boolean};function: WireDefinition}
export interface WireCapture {id: number;protocol: string;phase: string;callId: string;method: string|undefined;path: string|undefined;headers: IncomingHttpHeaders;closed: boolean;completed: boolean;body: {instructions:string;model:string;input: WireItem[];messages: WireItem[];tools: WireDefinition[];stream: boolean;store?: boolean;tool_choice?: unknown;[key: string]: unknown}}
export type WireModel = Omit<Awaited<ReturnType<typeof startEditWireModel>>,'captures'> & {captures: WireCapture[]};
export interface Selection {project: FixtureProject;timeline: FixtureTimeline;clip: FixtureClip;clipId: string;sources: FixtureAsset[]}
export interface WireInput {requestId: string;instanceId: string;expectedSettingsRevision: number;expectedConversationRevision: number;message: string;consent: {reviewTarget: Record<string,unknown>;[key: string]: unknown};[key: string]: unknown}
export interface WireRun extends ChatRun {activity: ChatActivityEntry[];provenance: {category: string;projectId: string;sourceRunIds: string[]}}
export interface WireResult<K extends ProposalKind> {run: WireRun;revision: number;instanceId: string;replayed: boolean;proposal: Proposal<K>;proposals: Proposal<K>[];nextCursor: string|null;[key: string]: unknown}
export interface WireResponse<K extends ProposalKind> {status: number;headers: Headers;body: {ok: boolean;data: WireResult<K>;error: Failure}}
export interface WireFixture<K extends ProposalKind> {
 root: string;protocol: string;model: WireModel;lifetime: OwnedFixtureLifetime;process: OwnedEditBackend;testRuntimeEnvironment: NodeJS.ProcessEnv;signal: AbortSignal;
 deferCleanup(dispose: ()=>unknown): void;restart(options?: {crash?: boolean}): Promise<OwnedEditBackend>;
 request(route: string,options?: Parameters<typeof fixtureHttpRequest>[3]): Promise<WireResponse<K>>;
 data(route: string,options?: Parameters<typeof fixtureHttpRequest>[3]): Promise<WireResult<K>>;
 rpc: FixtureCall;cli<O extends string>(operation: O,input?: unknown): Promise<{code: number|null;stderr: string;body: {ok: boolean;data: FixtureServiceResult<O>;error: Failure}}>;
 setup(): Promise<K extends 'shot' ? {project: FixtureProject;shot: FixtureShot & {prompt: string}} : Selection>;
 input(projectId: string,selection: K extends 'shot' ? {id: string;revision: number} : Partial<Selection>|FixtureTimeline,changes?: Record<string,unknown>): Promise<WireInput>;
 send(projectId: string,input: unknown): Promise<WireResult<K>>;lookup(projectId: string,requestId: string): Promise<WireResult<K>>;terminal(projectId: string,requestId: string): Promise<WireResult<K>>;
 proposals(projectId: string,query?: string): Promise<WireResult<K>>;proposal(projectId: string,id: string): Promise<WireResult<K>>;
 action(projectId: string,proposal: {id: string;digest: string},action: string,overrides?: Record<string,unknown>): Promise<WireResult<K>>;
 propose(projectId: string,selection: K extends 'shot' ? {id: string;revision: number} : Partial<Selection>|FixtureTimeline,plan?: Record<string,unknown>): Promise<{input: WireInput;sent: WireResult<K>;done: WireResult<K>;proposal: Proposal<K>}>;
 lostAcknowledgement(route: string,input: unknown): Promise<number>;trace(): Promise<{label: string;phase: string;result: string;[key: string]: unknown}[]>;
}
export type ChatRuntimeBase = ReturnType<typeof import('../../packages/business/src/agent/chat-runtime.ts').createChatRuntime>;
export interface RuntimeEnvelope {instanceId: string;threadId: string;projectId: string;revision: number;run: RuntimeRun;replayed: boolean;historyCursor: string|null;runs: ChatRun[]}
export type RuntimeSnapshot = Awaited<ReturnType<ChatRuntimeBase['snapshot']>> & Omit<RuntimeEnvelope,'run'|'replayed'>;
export type TypedRuntime<K extends ProposalKind = 'shot'> = Omit<ChatRuntimeBase,'snapshot'|'send'|'get'|'lookup'|'history'|'stop'|'subscribe'|'editGet'|'editList'|'editApprove'|'editRecover'|'editReject'> & {
 editGet(projectId:string,proposalId:string): {proposal:Proposal<K>};editList(projectId:string,input?:unknown): {proposals:Proposal<K>[];nextCursor:string|null};editApprove(projectId:string,proposalId:string,input:unknown):Promise<{proposal:Proposal<K>}>;editRecover(projectId:string,proposalId:string,input:unknown):Promise<{proposal:Proposal<K>}>;editReject(projectId:string,proposalId:string,input:unknown):Promise<{proposal:Proposal<K>}>;
 snapshot(projectId: string): Promise<RuntimeSnapshot>;send(projectId: string,input: unknown): Promise<RuntimeEnvelope>;
 get(projectId: string,runId: string,instanceId: unknown): RuntimeEnvelope;lookup(projectId: string,requestId: string): RuntimeEnvelope;
 history(projectId: string,options?: unknown): RuntimeEnvelope;stop(projectId: string,runId: string,input: unknown): RuntimeEnvelope;
 subscribe(projectId: string,runId: string,instanceId: unknown,after: unknown,listener: (event: import('../../packages/business/src/agent/chat-journal.ts').ChatStoredEvent)=>unknown,onClose?: ()=>void): ()=>void;
};
export type RuntimeFixtureOptions = {gateway?: import('../../packages/business/src/agent/agent-gateway.ts').AgentGateway;journalLimits?: Record<string,number>;settingsWrapper?: (settings: SettingsStub)=>SettingsStub};
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
export interface PreparedShot {projectId: string;runId: string;target: import('../../packages/business/src/agent/edit-proposals.ts').EditProposalTarget;changes: Record<string,unknown>;toolCall: import('../../packages/business/src/agent/tool-wire.ts').ToolCall;run: {id: string;projectId: string;requestId: string;threadId: string;status: string;contextMode: string;editTarget: unknown;modelRequestState: string;activity: ChatActivityEntry[]};tool: {id: string;projectId: string;runId: string;position: number;kind: string;ordinal: number;status: string;intent: {toolCall: import('../../packages/business/src/agent/tool-wire.ts').ToolCall;provenance: Record<string,unknown>};observation?: {result: Record<string,unknown>;resultJson: string;provenance: Record<string,unknown>}}}
export interface ShotFixtureOptions {fault?: (label: string)=>void;limits?: import('../../packages/business/src/agent/edit-proposals.ts').AgentEditServiceOptions['limits'];dispatch?: ((operation: string,input: ShotMutationInput,services: {call(operation: string,input: unknown): Promise<unknown>})=>unknown)|null}
export interface SchemaObject {type: string;name: string;tbl_name: string;sql: string|null}
export type SqlRow = Record<string,import('node:sqlite').SQLOutputValue>;
export interface FrozenSource {text: string;sha256: string}
export interface FrozenBaseline {sourceCommit: string;objects: SchemaObject[];tables: Record<string,SqlRow[]>;sequence: {__rowid__: number;name: string;seq: number}[];media: {relativePath: string;base64: string};sources: Record<string,FrozenSource>;dependencyHashes: Record<string,string>;substitutions: {canonicalSource: string};projectId: string;proposals: {id: string;digest: string;version: number}[];catalogs: Record<string,{definitions: string;hash: string;policy: unknown}>}
export interface FrozenClosure {sourceCommit: string;sources: Record<string,FrozenSource>;dependencyHashes: Record<string,string>}
export interface HistoricalDelta48 {objectSql: Record<string,string>;lifecycleObjects: SchemaObject[];lutCatalog: {count: number;sha256: string};annotationCatalog: {count: number;sha256: string};lifecycleCatalog: {count: number;sha256: string}}
export interface RuntimeTarget {projectId?: string;shotId?: string;timelineId?: string;expectedRevision?: number;title?: string;prompt?: string;clip?: FixtureClip;track?: FixtureTimeline['tracks'][number];[key: string]: unknown}
export interface RuntimeRun extends ChatRun {editTarget: RuntimeTarget;activity: ChatActivityEntry[];provenance: import('../../packages/business/src/agent/chat-journal.ts').ChatProvenance}
export interface TestDispatch extends Omit<import('../../packages/business/src/agent/agent-gateway.ts').AgentDispatchOptions,'readTools'|'messages'> {messages: {role:string;content:string;[key:string]:unknown}[];readTools?: {scope?: string;phase: string;result: string;[key: string]: unknown}}
export interface RuntimeToolOptions {gateway?: (options: TestDispatch,call: number)=>AsyncGenerator<import('../../packages/business/src/agent/agent-gateway.ts').AgentStreamItem,void,undefined>}
export interface AcceptedRun {consent: {timelineId:string;clipId:string;[key:string]:unknown};execution: {target: RuntimeTarget;request: {context: import('../../packages/business/src/agent/tool-wire.ts').WireMessage[];body: string;[key: string]: unknown};policy: Record<string,unknown>};messages: import('../../packages/business/src/agent/tool-wire.ts').WireMessage[];configuration: import('../../packages/business/src/agent/config.ts').AgentConfiguration;[key: string]: unknown}
export interface ProtocolMode {phase:string;toolCall:import('../../packages/business/src/agent/tool-wire.ts').ToolCall;providerOutput: WireItem|WireItem[];result:string}
export interface HttpFixtureRequest {method?:string;input?:unknown;payload?:unknown;raw?:string;authenticated?:boolean;headers?:Record<string,string>}
export interface AgentHttpFixtureOptions {gateway?:import('../../packages/business/src/agent/agent-gateway.ts').AgentGateway;modelServer?:boolean;hold?:boolean;protocol?:import('../../packages/contracts/src/agent-protocol.ts').AgentProtocol;responseFault?:'truncated'|'tool'|'incomplete'|'failure'|'reasoning'|'unknown'}
export interface AgentHttpCapture extends HttpCapture {closed?:boolean;completed?:boolean;lateAttempted?:boolean;messages?:WireItem[]}
export interface BackendMessage {type:string;pid:number;url:string;requestId:string;acquisitions:number;message:string}
export interface BackendExit {code:number|null;signal:NodeJS.Signals|null}
export interface BackendInstance {child:import('node:child_process').ChildProcess;exited:Promise<BackendExit>;readonly acquisitions:number;readonly output:string;observe():Promise<number>;crash():Promise<BackendExit>;close():Promise<BackendExit>;url:string}
