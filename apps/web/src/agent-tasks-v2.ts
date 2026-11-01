import { agentTaskPolicySchema, agentTaskSnapshotSchema, agentTaskRunSchema, agentTaskEventSchema, agentTaskReceiptSchema, agentTaskLocaleSchema, agentTaskHistoryPageSchema, agentTaskConversationPageSchema, agentTaskConversationPolicySchema, agentTaskChecksSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { sameAgentTaskPolicyModes } from './agent-task-policy-menu.ts';
import type { AgentTaskControlAction, AgentTaskControlInput, AgentTaskDiagnostic, AgentTaskEvent, AgentTaskPolicy, AgentTaskRun, AgentTaskSnapshot, AgentTaskReceipt, AgentTaskLocale, AgentTaskConversation, AgentTaskHistoryPage, AgentTaskConversationPage, AgentTaskConversationPolicy, AgentTaskPolicyModes, AgentTaskChecks } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { agentAuthorizationReceiptSchema, safeAgentAuthorizationSnapshot } from './agent-authorization-state.ts';
import type { AgentAuthorizationSnapshot } from '../../../packages/contracts/src/agent-authorization.ts';
import { deriveAgentEndpoint, safeAgentSettings } from './agent-settings.ts';
import type { AgentSettingsSnapshot } from './agent-settings.ts';
import { readAgentChatSSE } from './agent-sse.ts';

export interface AgentTaskProjectSnapshot { version: 2; instanceId: string; projectId: string; runs: AgentTaskRun[]; policy: AgentTaskPolicy; settings: AgentSettingsSnapshot; authorization: AgentAuthorizationSnapshot; readOnly?: boolean }
export interface AgentTaskUpload {id: string; name: string; mimeType: string; status: string}
export interface AgentTaskPolicyView {policy: AgentTaskPolicy; readOnly: boolean}
export interface AgentTaskConversationPolicyView {policy: AgentTaskConversationPolicy; readOnly: boolean}
/** The confirmation modes of the selected conversation. A new conversation has
 * no server record yet: `modes` is its own choice, null to follow the global policy. */
export interface AgentTaskComposerPolicy {conversationId: string | null; phase: 'loading' | 'ready' | 'saving' | 'error'; value: AgentTaskConversationPolicy | null; modes: AgentTaskPolicyModes | null}
export interface AgentTaskLookup { found: boolean; snapshot?: AgentTaskSnapshot; upload?: AgentTaskUpload; receipt?:AgentTaskReceipt }
export interface AgentTaskPending { requestId: string; runId: string | null; action: 'send' | 'upload' | AgentTaskControlAction; definitiveRejected?:boolean; conversationId?:string|null }
interface AgentTaskControlExtras {stepId?:string;changeId?:string;undoChangeIds?:string[];resolution?:'discard'|'accept_result';text?:string;choices?:number[]}
// Answers carry their own choice payload and are submitted through answer().
type AgentTaskPanelControlAction=Exclude<AgentTaskControlAction,'answer'>;
/** The question a run waits on: the latest step of the selected round still awaiting its answer. */
export function agentTaskWaitingQuestion(snapshot:AgentTaskSnapshot|null|undefined){
  if(!snapshot||snapshot.run.status!=='awaiting_answer')return null;
  return snapshot.steps.filter(step=>step.kind==='tool'&&step.status==='awaiting_answer'&&step.toolCall?.name==='mioon_ask').at(-1)??null;
}
export interface AgentTaskAuthorizationReview { projectId: string; settingsRevision: number; authorizationRevision: number; destination: string; model: string; text: string; uploads: string[]; locale: AgentTaskLocale; conversationId?:string|null; modes?:AgentTaskPolicyModes|null }
export interface AgentTaskClient {
  list(projectId: string): Promise<AgentTaskProjectSnapshot>;
  history(projectId:string,cursor?:string|null):Promise<AgentTaskHistoryPage>;
  conversation(projectId:string,conversationId:string,cursor?:string|null):Promise<AgentTaskConversationPage>;
  read(projectId: string, runId: string): Promise<AgentTaskSnapshot>;
  send(projectId: string, input: { requestId: string; text: string; expectedSettingsRevision: number; locale?: AgentTaskLocale; uploads?: string[]; conversationId?:string; diagnostic?: AgentTaskDiagnostic; policy?: {modes: AgentTaskPolicyModes; acknowledgePaid?: true} }): Promise<AgentTaskSnapshot>;
  upload(projectId: string, input: {requestId: string; name: string; mimeType: string; dataBase64: string}): Promise<AgentTaskUpload>;
  action(projectId: string, input: AgentTaskControlInput): Promise<AgentTaskSnapshot>;
  lookup(projectId: string, pending: AgentTaskPending): Promise<AgentTaskLookup>;
  authorize(snapshot: AgentTaskProjectSnapshot, requestId: string): Promise<void>;
  stream(projectId: string, runId: string, after: number, signal: AbortSignal, onEvent: (event: AgentTaskEvent) => void): Promise<void>;
  policy(): Promise<AgentTaskPolicyView>;
  savePolicy(input: AgentTaskPolicy & {requestId: string; expectedRevision: number; acknowledgePaid?: boolean}): Promise<AgentTaskPolicyView>;
  lookupPolicy(requestId: string): Promise<{found: boolean; policy?: AgentTaskPolicy; readOnly: boolean}>;
  conversationPolicy(projectId: string, conversationId: string): Promise<AgentTaskConversationPolicyView>;
  setConversationPolicy(projectId: string, conversationId: string, input: {requestId: string; expectedRevision: number; modes: AgentTaskPolicyModes | null; acknowledgePaid?: true}): Promise<AgentTaskConversationPolicyView>;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const agentTaskPromptValid=(text:string):boolean=>Boolean(text.trim())&&text.length<=32000&&new TextEncoder().encode(text).byteLength<=32768;
const failure = (code = 'NETWORK',definitive=false) => Object.assign(new Error('Agent task request failed'), { code,definitive });
export const agentTaskDefinitiveFailure=(error:unknown):boolean=>record(error)&&error.definitive===true;
function safeUpload(value: unknown): AgentTaskUpload { if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.mimeType !== 'string' || typeof value.status !== 'string') throw failure('INVALID_RESPONSE'); return {id:value.id,name:value.name,mimeType:value.mimeType,status:value.status}; }
function safeConversationPolicyView(value: unknown, projectId: string, conversationId: string): AgentTaskConversationPolicyView { if (!record(value) || typeof value.readOnly !== 'boolean') throw failure('INVALID_RESPONSE'); const policy=agentTaskConversationPolicySchema.parse(value.policy); if(policy.projectId!==projectId||policy.conversationId!==conversationId)throw failure('INVALID_RESPONSE'); return {policy,readOnly:value.readOnly}; }
function safePolicyView(value: unknown): AgentTaskPolicyView { if (!record(value) || typeof value.readOnly !== 'boolean') throw failure('INVALID_RESPONSE'); return {policy:agentTaskPolicySchema.parse(value.policy),readOnly:value.readOnly}; }
function errorCode(error: unknown): string { return record(error) && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,90}$/u.test(error.code) ? error.code : 'NETWORK'; }
// Match the existing asset importer aliases; filenames never infer media types.
function uploadMimeType(type: string): string { return type === 'audio/x-m4a' ? 'audio/mp4' : type === 'audio/x-wav' ? 'audio/wav' : type || 'application/octet-stream'; }
// DTOs belong to one project. Unknown/provider fields never become UI errors.
export function safeAgentTaskSnapshot(value: unknown, projectId: string, runId?: string): AgentTaskSnapshot {
  const parsed = agentTaskSnapshotSchema.parse(value);
  if (parsed.run.projectId !== projectId || runId !== undefined && parsed.run.id !== runId || parsed.steps.some(step => step.runId !== parsed.run.id) || parsed.changes.some(change => change.runId !== parsed.run.id || change.projectId !== projectId)) throw failure('INVALID_RESPONSE');
  return parsed;
}
export function safeAgentTaskProject(value: unknown, projectId: string): AgentTaskProjectSnapshot {
  if (!record(value) || value.version !== 2 || value.projectId !== projectId || typeof value.instanceId !== 'string' || !Array.isArray(value.runs) || value.runs.some(run => !record(run) || run.projectId !== projectId)) throw failure('INVALID_RESPONSE');
  return { version: 2, instanceId: value.instanceId, projectId, runs: value.runs.map(run => agentTaskRunSchema.parse(run)), policy: agentTaskPolicySchema.parse(value.policy), settings: safeAgentSettings(value.settings), authorization: safeAgentAuthorizationSnapshot(value.authorization), ...(value.readOnly === true ? {readOnly:true} : {}) };
}
export interface AgentTaskChecksReadOptions {preflight?:boolean;signal?:AbortSignal}
/** Independent advisory GET. It shares neither execution requests nor their
 * timeout: full local media preflight has its own 30-second server budget. */
export function createAgentTaskChecksReader({fetchImpl=globalThis.fetch,timeoutMs=12000}:{fetchImpl?:typeof fetch;timeoutMs?:number}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw failure('AGENT_TASK_INVALID');
  return async(projectId:string,runId:string,{preflight=false,signal}:AgentTaskChecksReadOptions={}):Promise<AgentTaskChecks>=>{
    if(signal?.aborted)throw failure();
    const controller=new AbortController(),externalAbort=()=>controller.abort();
    let rejectAborted:()=>void=()=>{};
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAborted=()=>reject(failure());});
    controller.signal.addEventListener('abort',rejectAborted,{once:true});signal?.addEventListener('abort',externalAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(),preflight?Math.max(timeoutMs,60000):timeoutMs);
    try{
      if(signal?.aborted)controller.abort();
      const work=(async()=>{
        if(controller.signal.aborted)throw failure();
        const response=await fetchImpl(`/api/agent/tasks/v2/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}/checks${preflight?'?preflight=1':''}`,{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(controller.signal.aborted)throw failure();
        let value:unknown;try{value=await response.json();}catch{throw failure(controller.signal.aborted?'NETWORK':'INVALID_RESPONSE');}
        if(controller.signal.aborted)throw failure();
        if(!record(value)||value.ok!==true||!response.ok){
          const backendError=record(value)&&value.ok===false&&record(value.error)?value.error:null;
          const code=backendError&&typeof backendError.code==='string'&&/^[A-Z][A-Z0-9_]{1,90}$/u.test(backendError.code)?backendError.code:'INVALID_RESPONSE';
          throw failure(code);
        }
        const parsed=agentTaskChecksSchema.safeParse(value.data);
        if(!parsed.success||parsed.data.projectId!==projectId||parsed.data.runId!==runId)throw failure('INVALID_RESPONSE');
        return parsed.data;
      })();
      // Reject even when a fetch implementation or body reader ignores abort.
      return await Promise.race([work,aborted]);
    }catch(error){throw failure(errorCode(error));}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAborted);signal?.removeEventListener('abort',externalAbort);}
  };
}
export const readAgentTaskChecks=createAgentTaskChecksReader();
export function createAgentTaskClient({ fetchImpl = globalThis.fetch, timeoutMs = 12000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): AgentTaskClient {
  const root = '/api/agent/tasks/v2', path = (projectId: string, runId?: string) => `${root}/${encodeURIComponent(projectId)}${runId ? `/${encodeURIComponent(runId)}` : ''}`;
  async function json(url: string, method = 'GET', body?: unknown): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const work=(async()=>{const response=await fetchImpl(url,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});const bodyValue:unknown=await response.json();
        if(!record(bodyValue)||bodyValue.ok!==true||!response.ok){const valid=record(bodyValue)&&bodyValue.ok===false&&record(bodyValue.error)&&typeof bodyValue.error.code==='string'&&/^[A-Z][A-Z0-9_]{1,90}$/u.test(bodyValue.error.code);throw failure(valid?errorCode(bodyValue.error):'INVALID_RESPONSE',valid&&response.status>=400&&response.status<500);}
        return bodyValue.data;})();
      return await Promise.race([work,new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(failure()),{once:true}))]);
    } catch (error) { throw failure(errorCode(error),agentTaskDefinitiveFailure(error)); } finally { clearTimeout(timer); }
  }
  return {
    list: async projectId => safeAgentTaskProject(await json(path(projectId)), projectId),
    history:async(projectId,cursor=null)=>{const page=agentTaskHistoryPageSchema.parse(await json(`${path(projectId)}/history${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`));if(page.conversations.some(item=>item.projectId!==projectId))throw failure('INVALID_RESPONSE');return page;},
    conversation:async(projectId,conversationId,cursor=null)=>{const page=agentTaskConversationPageSchema.parse(await json(`${path(projectId)}/conversations/${encodeURIComponent(conversationId)}${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`));if(page.conversation.id!==conversationId||page.conversation.projectId!==projectId||page.runs.some(run=>run.projectId!==projectId||(run.conversationId??run.id)!==conversationId||run.diagnostic))throw failure('INVALID_RESPONSE');return page;},
    read: async (projectId, runId) => safeAgentTaskSnapshot(await json(path(projectId, runId)), projectId, runId),
    send: async (projectId, input) => { if(input.locale!==undefined&&!agentTaskLocaleSchema.safeParse(input.locale).success)throw failure('AGENT_TASK_INVALID',true);return safeAgentTaskSnapshot(await json(path(projectId), 'POST', input), projectId); },
    upload: async (projectId, input) => safeUpload(await json(`${path(projectId)}/uploads`, 'POST', input)),
    action: async (projectId, input) => safeAgentTaskSnapshot(await json(`${path(projectId, input.runId)}/actions`, 'POST', input), projectId, input.runId),
    lookup: async (projectId, pending) => {
      const result = await json(pending.action === 'upload' ? `${path(projectId)}/uploads/requests/${encodeURIComponent(pending.requestId)}` : pending.runId ? `${path(projectId, pending.runId)}/actions/${encodeURIComponent(pending.requestId)}` : `${path(projectId)}/requests/${encodeURIComponent(pending.requestId)}`);
      if (!record(result) || typeof result.found !== 'boolean' || result.found && result.snapshot === undefined && result.upload === undefined) throw failure('INVALID_RESPONSE');
      const receipt=result.receipt===undefined?undefined:agentTaskReceiptSchema.parse(result.receipt);if(receipt&&(receipt.requestId!==pending.requestId||receipt.runId!==pending.runId))throw failure('INVALID_RESPONSE');
      return { found: result.found, ...(result.snapshot === undefined ? {} : { snapshot: safeAgentTaskSnapshot(result.snapshot, projectId, pending.runId ?? undefined) }), ...(result.upload === undefined ? {} : {upload:safeUpload(result.upload)}),...(receipt?{receipt}:{}) };
    },
    authorize: async (snapshot, requestId) => {
      agentAuthorizationReceiptSchema.parse(await json('/api/rpc', 'POST', { operation: 'agent.authorization.grant', input: { requestId, expectedRevision: snapshot.authorization.revision, expectedSettingsRevision: snapshot.settings.revision, destination: deriveAgentEndpoint(snapshot.settings.configuration), model: snapshot.settings.configuration.model, scope: 'project_agent' } }));
    },
    async stream(projectId, runId, after, signal, onEvent) {
      const response = await fetchImpl(`${path(projectId, runId)}/events?after=${after}`, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'text/event-stream' } });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw failure('NETWORK');
      await readAgentChatSSE(response.body, frame => {
        if(!record(frame.data))throw failure('INVALID_RESPONSE');
        const {id:wireId,...event}=frame.data;
        const value = agentTaskEventSchema.parse(event);
        if(String(value.sequence)!==frame.id||frame.type!==value.type||wireId!==undefined&&wireId!==value.sequence)throw failure('INVALID_RESPONSE');
        if (value.runId !== runId) throw failure('INVALID_RESPONSE');
        onEvent(value);
      }, signal);
    },
    policy: async () => safePolicyView(await json(`${root}/policy`)),
    savePolicy: async input => safePolicyView(await json(`${root}/policy`, 'PUT', input)),
    conversationPolicy: async (projectId, conversationId) => safeConversationPolicyView(await json(`${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/policy`), projectId, conversationId),
    setConversationPolicy: async (projectId, conversationId, input) => safeConversationPolicyView(await json(`${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/policy`, 'PUT', input), projectId, conversationId),
    lookupPolicy: async requestId => { const value = await json(`${root}/policy/requests/${encodeURIComponent(requestId)}`); if (!record(value) || typeof value.found !== 'boolean' || typeof value.readOnly !== 'boolean') throw failure('INVALID_RESPONSE'); return {found:value.found,readOnly:value.readOnly,...(value.policy === undefined ? {} : {policy:agentTaskPolicySchema.parse(value.policy)})}; },
  };
}

export interface AgentTaskSessionState { phase: 'loading' | 'refreshing' | 'ready' | 'submitting' | 'unknown' | 'detached' | 'error' | 'read_error'; project: AgentTaskProjectSnapshot | null; snapshot: AgentTaskSnapshot | null; draft: string; uploads: AgentTaskUpload[]; pending: AgentTaskPending | null; error: string; conversationId:string|null; conversation:AgentTaskConversation|null; rounds:AgentTaskSnapshot[]; selectionKey:string; draftDirty:boolean; draftVersion:number; unknownOutcome:boolean; backgroundPending?:boolean; policy:AgentTaskComposerPolicy; history:{conversations:AgentTaskConversation[];nextCursor:string|null;phase:'closed'|'loading'|'ready'|'error'} }
export const agentTaskSessionBusy=(state:Pick<AgentTaskSessionState,'phase'>):boolean=>['loading','refreshing','submitting'].includes(state.phase);
export interface AgentTaskReceiptStore { read(projectId: string): AgentTaskPending | null; write(projectId: string, value: AgentTaskPending | null): void }
export function createAgentTaskReceiptStore(storage: () => Storage | null = () => typeof sessionStorage === 'undefined' ? null : sessionStorage, workspaceScope = 'normal'): AgentTaskReceiptStore {
  const key = (id: string) => `mioon.agent-task-v2.pending.${encodeURIComponent(workspaceScope)}.${id}`;
  return { read(id) { const store=storage();if(!store)throw failure('LOCAL_RECEIPT_UNAVAILABLE');const raw:unknown=JSON.parse(store.getItem(key(id))??'null');if(raw===null)return null;if(!record(raw)||typeof raw.requestId!=='string'||raw.requestId.length<8||raw.runId!==null&&typeof raw.runId!=='string'||raw.conversationId!==undefined&&raw.conversationId!==null&&(typeof raw.conversationId!=='string'||!uuid.test(raw.conversationId))||typeof raw.action!=='string'||!['send','upload','pause','resume','retry','skip','note','stop','approve','deny','undo_change','undo_all','resolve_unknown','answer'].includes(raw.action))throw failure('LOCAL_RECEIPT_UNAVAILABLE');return raw as unknown as AgentTaskPending; }, write(id, value) { const store = storage(); if (!store)throw failure('LOCAL_RECEIPT_UNAVAILABLE'); if (value) store.setItem(key(id), JSON.stringify(value)); else store.removeItem(key(id)); } };
}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const terminal = new Set(['completed', 'failed', 'stopped', 'reverted']);
const finished=(snapshot:AgentTaskSnapshot):boolean=>terminal.has(snapshot.run.status)&&snapshot.backgroundPending!==true;
const conversationIdOf=(run:AgentTaskRun):string=>run.conversationId??run.id;
function conversationTitle(text:string):string {const value=text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,' ').replace(/\s+/gu,' ').trim();let result='';for(const character of value){if(result.length+character.length>120)break;result+=character;}return result;}
export function agentTaskNewConversationBlock(state:AgentTaskSessionState):'unavailable'|'pending'|'interrupted'|'running'|null {
  if(!state.project||state.project.readOnly||agentTaskSessionBusy(state)||['error','read_error'].includes(state.phase))return 'unavailable';
  if(state.pending||state.phase==='unknown')return 'pending';
  if(state.unknownOutcome||state.project.runs.some(run=>run.status==='interrupted')||state.rounds.some(item=>item.steps.some(step=>step.status==='unknown')))return 'interrupted';
  if(state.backgroundPending||state.project.runs.some(run=>!terminal.has(run.status))||state.rounds.some(item=>!finished(item)))return 'running';
  return null;
}
export function createAgentTaskSession({ projectId, client = createAgentTaskClient(), receipts = createAgentTaskReceiptStore(), requestId = () => crypto.randomUUID(), getLocale = () => 'zh-Hans', onChange = () => {}, onChangeApplied = () => {} }: { projectId: string; client?: AgentTaskClient; receipts?: AgentTaskReceiptStore; requestId?: () => string; getLocale?: () => AgentTaskLocale; onChange?: (state: AgentTaskSessionState) => void; onChangeApplied?: (snapshot: AgentTaskSnapshot, landed: readonly string[]) => void }) {
  let authorizationEpoch = 0,selectionOwner:number|null=null;
  let restored:AgentTaskPending|null=null,receiptsBlocked=false;try{restored=receipts.read(projectId);}catch{receiptsBlocked=true;}
  const drafts=new Map<string,{text:string;uploads:AgentTaskUpload[]}>(),unknownRuns=new Set<string>(),backgroundRuns=new Set<string>();let selectionChosen=false;
  const noteDrafts=new Map<string,{selectionKey:string;version:number;text:string}>();
  let state: AgentTaskSessionState = { phase: receiptsBlocked?'error':'loading', project: null, snapshot: null, draft: '', uploads: [], pending: restored, error: receiptsBlocked?'LOCAL_RECEIPT_UNAVAILABLE':'',conversationId:restored?.conversationId??null,conversation:null,rounds:[],selectionKey:restored?.conversationId??'new',draftDirty:false,draftVersion:0,unknownOutcome:false,policy:{conversationId:null,phase:'ready',value:null,modes:null},history:{conversations:[],nextCursor:null,phase:'closed'} }, active = true, generation = 0, visible = true, busy = false, after = 0, historyEpoch=0, retryAttempt=0, stream: AbortController | null = null, retry: ReturnType<typeof setTimeout> | null = null;
  const publish = (patch: Partial<AgentTaskSessionState>) => { const previous=state;state = { ...state, ...patch };drafts.set(state.selectionKey,{text:state.draft,uploads:state.uploads});state.draftDirty=[...drafts.values()].some(value=>Boolean(value.text.trim())||value.uploads.length>0);state.unknownOutcome=unknownRuns.size>0;state.backgroundPending=backgroundRuns.size>0;if(previous.draft!==state.draft||previous.uploads!==state.uploads||previous.selectionKey!==state.selectionKey)state.draftVersion++;if (active) onChange(state);syncPolicy(); };
  function rememberPendingResults(snapshot:AgentTaskSnapshot){if(snapshot.steps.some(step=>step.status==='unknown'))unknownRuns.add(snapshot.run.id);else unknownRuns.delete(snapshot.run.id);if(snapshot.backgroundPending===true)backgroundRuns.add(snapshot.run.id);else backgroundRuns.delete(snapshot.run.id);}
  const persist = (value: AgentTaskPending | null) => { receipts.write(projectId, value); publish({ pending: value }); };
  // The composer shows the selected conversation's own modes; a new one has
  // only a local choice until its first send saves it with the run.
  let policyEpoch=0;
  function syncPolicy(){
    const id=state.conversationId;
    if(!active||state.policy.conversationId===id)return;
    policyEpoch++;
    if(id===null)publish({policy:{conversationId:null,phase:'ready',value:null,modes:null}});else void loadPolicy(id);
  }
  async function loadPolicy(id:string):Promise<void>{
    const epoch=++policyEpoch,previous=state.policy.conversationId===id?state.policy.value:null;
    publish({policy:{conversationId:id,phase:'loading',value:previous,modes:null}});
    try{const view=await client.conversationPolicy(projectId,id);if(active&&epoch===policyEpoch&&state.policy.conversationId===id)publish({policy:{conversationId:id,phase:'ready',value:view.policy,modes:null}});}
    catch{if(active&&epoch===policyEpoch&&state.policy.conversationId===id)publish({policy:{conversationId:id,phase:'error',value:previous,modes:null}});}
  }
  const policyLocked=():boolean=>!active||!visible||receiptsBlocked||!state.project||state.project.readOnly===true||state.policy.phase==='saving'||state.policy.phase==='loading';
  /** Choose this conversation's modes. Choosing the global ones follows the global policy again. */
  async function choosePolicy(modes:AgentTaskPolicyModes):Promise<boolean>{
    if(policyLocked())return false;
    const global=state.project!.policy.modes,next=sameAgentTaskPolicyModes(modes,global)?null:structuredClone(modes),current=state.policy;
    if(current.conversationId===null){publish({policy:{conversationId:null,phase:'ready',value:null,modes:next}});return true;}
    if(!current.value||current.phase!=='ready')return false;
    const id=current.conversationId,epoch=++policyEpoch,after=next??global;
    publish({policy:{...current,phase:'saving'}});
    try{
      const view=await client.setConversationPolicy(projectId,id,{requestId:requestId(),expectedRevision:current.value.revision,modes:next,...(after.paid==='direct'&&current.value.effective.paid!=='direct'?{acknowledgePaid:true as const}:{})});
      if(!active||epoch!==policyEpoch||state.policy.conversationId!==id)return false;
      publish({policy:{conversationId:id,phase:'ready',value:view.policy,modes:null},error:''});return true;
    }catch(error){
      if(!active||epoch!==policyEpoch||state.policy.conversationId!==id)return false;
      // Never resend: read the saved modes back and show the failure.
      publish({error:errorCode(error)});await loadPolicy(id);return false;
    }
  }
  /** Write these modes to the global policy, keeping its step limit. */
  async function setGlobalPolicy(modes:AgentTaskPolicyModes):Promise<boolean>{
    if(policyLocked())return false;
    const saved=state.project!.policy,current=state.policy,epoch=++policyEpoch,request=requestId();
    publish({policy:{...current,phase:'saving'}});
    try{
      let view:{policy:AgentTaskPolicy};
      try{view=await client.savePolicy({...saved,modes:structuredClone(modes),requestId:request,expectedRevision:saved.revision,...(modes.paid==='direct'&&saved.modes.paid!=='direct'?{acknowledgePaid:true}:{})});}
      catch(error){const receipt=await client.lookupPolicy(request).catch(()=>null);if(!receipt?.found||!receipt.policy)throw error;view={policy:receipt.policy};}
      if(!active||epoch!==policyEpoch||!state.project)return false;
      publish({project:{...state.project,policy:view.policy},error:''});
      if(current.conversationId===null)publish({policy:{conversationId:null,phase:'ready',value:null,modes:current.modes&&sameAgentTaskPolicyModes(current.modes,view.policy.modes)?null:current.modes}});
      else await loadPolicy(current.conversationId);
      return true;
    }catch(error){
      if(!active||epoch!==policyEpoch)return false;
      publish({error:errorCode(error)});
      if(current.conversationId===null)publish({policy:{...current,phase:'ready'}});else await loadPolicy(current.conversationId);
      return false;
    }
  }
  function switchDraft(key:string){const saved=drafts.get(key);return {selectionKey:key,draft:saved?.text??'',uploads:saved?.uploads??[]};}
  function noteAccepted(pending:AgentTaskPending,snapshot:AgentTaskSnapshot|undefined):boolean {
    const captured=noteDrafts.get(pending.requestId);return pending.action!=='note'||Boolean(snapshot?.run.notes?.some(note=>note.requestId===pending.requestId&&(!captured||note.text===captured.text)));
  }
  function finishNoteDraft(pending:AgentTaskPending):Partial<AgentTaskSessionState> {
    const captured=noteDrafts.get(pending.requestId);noteDrafts.delete(pending.requestId);
    // An acknowledgement only consumes the exact draft this control captured.
    // Input edited while the request or its lookup was in flight stays intact.
    return captured&&state.selectionKey===captured.selectionKey&&state.draftVersion===captured.version&&state.draft===captured.text?{draft:''}:{};
  }

  const accept = (next: AgentTaskSnapshot) => {
    if (!active) return;
    safeAgentTaskSnapshot(next, projectId);
    if (state.snapshot?.run.id === next.run.id && state.snapshot.run.revision > next.run.revision) return;
    const id=conversationIdOf(next.run),same=state.conversationId===id,previous=state.rounds.find(item=>item.run.id===next.run.id);
    if(previous&&previous.run.revision>next.run.revision)return;
    rememberPendingResults(next);
    if (state.snapshot?.run.id !== next.run.id) after = 0;
    const changed = JSON.stringify(previous?.changes) !== JSON.stringify(next.changes);
    // Only a change new to a round already on screen was saved while it was watched. A first read of a round
    // (opening history, reloading, selecting a run) reports none, so old changes are never announced again.
    const landed = previous ? next.changes.filter(change => change.status === 'applied' && !previous.changes.some(item => item.id === change.id)).map(change => change.id) : [];
    const existing=same?state.rounds:[],rounds=existing.some(item=>item.run.id===next.run.id)?existing.map(item=>item.run.id===next.run.id?next:item):[...existing,next];
    // A first-send receipt assigns the server identity to the unsent draft;
    // keep input typed while that exact request was in flight in its new bucket.
    if(state.selectionKey==='new'&&!state.conversationId){drafts.delete('new');}
    const first=rounds[0]!.run,last=rounds.at(-1)!.run;
    const conversation:AgentTaskConversation={id,projectId,title:(same?state.conversation?.title:undefined)??conversationTitle(first.text),createdAt:first.createdAt,updatedAt:rounds.reduce((value,item)=>item.run.updatedAt>value?item.run.updatedAt:value,last.updatedAt),lastRunId:last.id,lastRunStatus:last.status,changeCount:rounds.reduce((sum,item)=>sum+item.changes.length,0),runCount:rounds.length};
    selectionChosen=true;publish({ snapshot: rounds.at(-1)!,rounds,conversationId:id,conversation,selectionKey:id, ...(state.project?{project:{...state.project,runs:[next.run,...state.project.runs.filter(run=>run.id!==next.run.id)].slice(0,100)}}:{}) }); if (changed) onChangeApplied(next, landed);
  };
  const detach = () => { stream?.abort(); stream = null; if (retry) clearTimeout(retry); retry = null; };
  function reconnect(owner: number, runId: string) {
    if (!active || !visible || generation !== owner || state.snapshot?.run.id !== runId || finished(state.snapshot)) return;
    stream?.abort(); stream = null;
    if (retry) return;
    const delay = Math.min(1500 * 2 ** Math.min(retryAttempt++, 4), 15000);
    retry = setTimeout(() => { retry = null; if (active && visible && generation === owner && state.snapshot?.run.id === runId) void reloadSelected(); }, delay);
  }
  async function observe() {
    detach(); const run = state.snapshot?.run;
    if (!active || !visible || !run || finished(state.snapshot!)) return;
    const owner = generation, controller = new AbortController(); stream = controller;
    let reading = false, readAgain = false;
    const readUpdate = async () => {
      if (reading) { readAgain = true; return; } reading = true;
      do {
        readAgain = false;
        try { const next = await client.read(projectId, run.id); if (active && generation === owner && state.snapshot?.run.id === run.id && !controller.signal.aborted) { retryAttempt=0; accept(next); publish({phase:state.pending?'unknown':'ready'}); if (finished(next)) detach(); } }
        catch { if (active && generation === owner && !controller.signal.aborted) { publish({phase:'detached'}); reconnect(owner, run.id); } }
      } while (readAgain && active && generation === owner && !controller.signal.aborted);
      reading = false;
    };
    try {
      await client.stream(projectId, run.id, after, controller.signal, event => {
        if (!active || generation !== owner || controller.signal.aborted || state.snapshot?.run.id !== run.id || event.sequence <= after) return;
        after = event.sequence;
        // Read the durable aggregate; event data is never treated as executable
        // commands and late deltas cannot overwrite a newer revision.
        if (event.type === 'snapshot') { const next = safeAgentTaskSnapshot(event.data, projectId, run.id); retryAttempt=0; accept(next); publish({phase:state.pending?'unknown':'ready'}); if (finished(next)) detach(); }
        else void readUpdate();
      });
    } catch { if (!controller.signal.aborted && active && generation === owner) publish({ phase: 'detached' }); }
    if (active && visible && generation === owner && !controller.signal.aborted && state.snapshot!==null&&!finished(state.snapshot)) reconnect(owner, run.id);
  }
  async function reloadSelected() {
    const runId = state.snapshot?.run.id, owner = generation;
    if (!runId || !active || !visible) return;
    try { const next = await client.read(projectId, runId); if (active && visible && generation === owner && state.snapshot?.run.id === runId) { retryAttempt=0; accept(next); publish({ phase: state.pending ? 'unknown' : 'ready', error: '' }); void observe(); } } catch (error) { if (active && visible && generation === owner) { publish({ phase: 'detached', error: errorCode(error) }); reconnect(owner, runId); } }
  }
  async function reconcile() {
    const pending = state.pending, owner = generation; if (!pending || busy) return false;
    busy = true;let confirmed=false;
    try { const result = await client.lookup(projectId, pending); if (!active || generation !== owner) return false;
      if(!result.found&&pending.definitiveRejected){
        noteDrafts.delete(pending.requestId);persist(null);
        // No upload was accepted: keep its notice and selection without a reload
        // that clears the notice or a hard-error phase that blocks native close.
        if(pending.action==='upload'){publish({phase:'ready',error:'UPLOAD_REJECTED'});return false;}
        busy=false;await load();return false;
      }
      if (!result.found || !result.snapshot && !result.upload) { publish({ phase: 'unknown', error: 'REQUEST_UNCONFIRMED' }); return false; } if(result.snapshot&&pending.conversationId&&conversationIdOf(result.snapshot.run)!==pending.conversationId)throw failure('INVALID_RESPONSE');if (result.snapshot) accept(result.snapshot); if (result.upload && !state.uploads.some(upload=>upload.id===result.upload!.id)) publish({uploads:[...state.uploads,result.upload]});
      const rejected=Boolean(result.receipt&&record(result.receipt.result)&&result.receipt.result.state==='rejected');if(!rejected&&!noteAccepted(pending,result.snapshot))throw failure('INVALID_RESPONSE');
      if(result.receipt&&record(result.receipt.result)&&result.receipt.result.state==='pending'){publish({phase:'unknown',error:'OPERATION_PENDING'});return false;}
      persist(null);confirmed=true;if(!rejected)publish(finishNoteDraft(pending));else noteDrafts.delete(pending.requestId);if(state.conversationId){const value=await readConversation(state.conversationId,owner);if(!value)return false;showConversation(value);} publish({ phase: 'ready', error: rejected?errorCode(result.receipt!.result):result.receipt&&record(result.receipt.result)&&result.receipt.result.state==='blocked'?'REQUEST_BLOCKED':'' }); void observe(); return !rejected; }
    catch (error) { if (active && generation === owner) publish({ phase: confirmed?'read_error':'unknown', error: errorCode(error) }); return false; } finally { busy = false; }
  }
  async function readConversation(id:string,owner:number):Promise<{conversation:AgentTaskConversation;rounds:AgentTaskSnapshot[]}|null>{
    let cursor:string|null=null,conversation:AgentTaskConversation|null=null;const seen=new Set<string>(),runs=new Map<string,AgentTaskRun>();
    do{const page=await client.conversation(projectId,id,cursor);if(!active||generation!==owner)return null;
      if(page.conversation.id!==id||page.conversation.projectId!==projectId||page.runs.some(run=>run.projectId!==projectId||conversationIdOf(run)!==id||run.diagnostic))throw failure('INVALID_RESPONSE');
      conversation=page.conversation;for(const run of page.runs)runs.set(run.id,run);cursor=page.nextCursor;if(cursor){if(seen.has(cursor))throw failure('INVALID_RESPONSE');seen.add(cursor);}
    }while(cursor);
    const ordered=[...runs.values()],rounds:AgentTaskSnapshot[]=[];
    for(let index=0;index<ordered.length;index+=4){const chunk=await Promise.all(ordered.slice(index,index+4).map(run=>client.read(projectId,run.id)));if(!active||generation!==owner)return null;for(const item of chunk){safeAgentTaskSnapshot(item,projectId);if(conversationIdOf(item.run)!==id||item.run.diagnostic)throw failure('INVALID_RESPONSE');rounds.push(item);}}
    if(!conversation||!rounds.length)throw failure('INVALID_RESPONSE');return{conversation,rounds};
  }
  function showConversation(value:{conversation:AgentTaskConversation;rounds:AgentTaskSnapshot[]}){
    const {conversation}=value,rounds=value.rounds.map(item=>{const saved=state.conversationId===conversation.id?state.rounds.find(existing=>existing.run.id===item.run.id):undefined;return saved&&saved.run.revision>item.run.revision?saved:item;});for(const snapshot of rounds)rememberPendingResults(snapshot);selectionChosen=true;after=0;publish({...switchDraft(conversation.id),conversationId:conversation.id,conversation,rounds,snapshot:rounds.at(-1)!,phase:'ready',error:''});
  }
  async function load() {
    if(receiptsBlocked){try{const restored=receipts.read(projectId);receiptsBlocked=false;publish({pending:restored});}catch{publish({phase:'error',error:'LOCAL_RECEIPT_UNAVAILABLE'});return;}}
    // Revalidating a known finished conversation is only observation. Keep
    // controls fenced until it settles without making native close depend on
    // a slow GET; new selections and unconfirmed work still use loading.
    const refreshing=Boolean(state.project&&!state.pending&&!state.unknownOutcome&&!state.backgroundPending&&
      ['ready','refreshing'].includes(state.phase)&&state.snapshot&&finished(state.snapshot)&&state.rounds.every(finished));
    const owner = ++generation; detach(); publish({ phase: refreshing?'refreshing':'loading', error: '' });
    try { const next = await client.list(projectId); if (!active || owner !== generation) return; publish({ project: next }); if (state.pending) { publish({ phase: 'unknown' }); await reconcile(); return; } const chosen = state.conversationId ?? (!selectionChosen&&next.runs.find(run=>!run.diagnostic)?conversationIdOf(next.runs.find(run=>!run.diagnostic)!):null); if (chosen) {const value=await readConversation(chosen,owner);if(!value)return;showConversation(value);} if (!active || owner !== generation) return; publish({ phase: 'ready' }); if(state.conversationId&&state.policy.conversationId===state.conversationId&&state.policy.phase==='error')void loadPolicy(state.conversationId); void observe(); }
    // A failed GET after a verified receipt read must not trap an untouched
    // window behind the same close gate needed to restart its local service.
    catch (error) { if (active && owner === generation) publish({ phase: state.pending ? 'unknown' : 'read_error', error: errorCode(error) }); }
  }
  async function refreshRound(runId:string):Promise<AgentTaskSnapshot|null> {
    const owner=generation,key=state.selectionKey,conversationId=state.conversationId;
    if(!active||!visible||busy||state.pending||agentTaskSessionBusy(state)||!state.rounds.some(item=>item.run.id===runId))return null;
    try {
      const next=await client.read(projectId,runId);
      if(!active||!visible||owner!==generation||key!==state.selectionKey||busy||state.pending)return null;
      safeAgentTaskSnapshot(next,projectId,runId);
      if(conversationIdOf(next.run)!==conversationId)throw failure('INVALID_RESPONSE');
      accept(next);return state.rounds.find(item=>item.run.id===runId)??null;
    }catch(error){if(active&&visible&&owner===generation&&key===state.selectionKey)publish({error:errorCode(error)});return null;}
  }
  async function mutate(action: 'send' | AgentTaskControlAction, extras: AgentTaskControlExtras = {},targetRunId=state.snapshot?.run.id) {
    const target=state.rounds.find(item=>item.run.id===targetRunId)??(state.snapshot?.run.id===targetRunId?state.snapshot:null);
    if (!active || !visible || receiptsBlocked || busy || agentTaskSessionBusy(state) || state.pending || !state.project || state.project.readOnly || action !== 'send' && !target) return false;
    if (action === 'send' && (!agentTaskPromptValid(state.draft) || !state.project.authorization.scopes.includes('project_agent') || agentTaskNewConversationBlock(state)!==null)) return false;
    if(action==='note'&&(!target||target.run.id!==state.snapshot?.run.id||!['running','awaiting_approval','paused'].includes(target.run.status)||target.steps.some(step=>step.status==='unknown')||state.unknownOutcome||!agentTaskPromptValid(extras.text??state.draft)))return false;
    // Only the question the run waits on can be answered, with a choice or typed text.
    if(action==='answer'&&(!target||agentTaskWaitingQuestion(target)?.id!==extras.stepId||!(extras.choices?.length)&&!(extras.text?.trim())))return false;
    const owner = generation, pending: AgentTaskPending = { requestId: requestId(), action, runId: action === 'send' ? null : target!.run.id,conversationId:state.conversationId }, text = action==='note'?extras.text??state.draft:state.draft, locale = action === 'send' ? getLocale() : undefined,conversationId=state.conversationId,modes=action==='send'&&!conversationId&&state.policy.conversationId===null?state.policy.modes:null;
    // A note, or an answer typed in the composer, consumes only the draft it captured.
    if(action==='note'||action==='answer'&&extras.text!==undefined&&extras.text===state.draft)noteDrafts.set(pending.requestId,{selectionKey:state.selectionKey,version:state.draftVersion,text:action==='note'?text:extras.text!});
    try { persist(pending); } catch { noteDrafts.delete(pending.requestId);publish({ phase: 'error', error: 'LOCAL_RECEIPT_UNAVAILABLE' }); return false; }
    busy = true; publish({ phase: 'submitting', error: '' });
    try { const next = action === 'send' ? await client.send(projectId, { requestId: pending.requestId, text, expectedSettingsRevision: state.project.settings.revision, locale,...(conversationId?{conversationId}:{}), ...(state.uploads.length ? {uploads:state.uploads.map(upload=>upload.id)} : {}),...(!conversationId&&modes?{policy:{modes,...(modes.paid==='direct'&&state.project.policy.modes.paid!=='direct'?{acknowledgePaid:true as const}:{})}}:{}) }) : await client.action(projectId, action==='note'?{requestId:pending.requestId,runId:pending.runId!,expectedRevision:target!.run.revision,action,text}:action==='answer'?{requestId:pending.requestId,runId:pending.runId!,expectedRevision:target!.run.revision,action,stepId:extras.stepId!,choices:extras.choices??[],...(extras.text!==undefined?{text:extras.text}:{})}:{requestId:pending.requestId,runId:pending.runId!,expectedRevision:target!.run.revision,action,...extras}); if (!active || owner !== generation) return false;if(conversationId&&conversationIdOf(next.run)!==conversationId||!noteAccepted(pending,next))throw failure('INVALID_RESPONSE'); accept(next); if(action==='undo_all'||action==='undo_change'){busy=false;return await reconcile();} persist(null); publish({ phase: 'ready', ...(action === 'send' && state.draft === text ? { draft: '', uploads:[] } : {}),...finishNoteDraft(pending) }); void observe(); return true; }
    catch (error) { if (active && owner === generation) {if(agentTaskDefinitiveFailure(error)){try{persist({...pending,definitiveRejected:true});busy=false;const accepted=await reconcile();if((action==='note'||action==='answer')&&!accepted&&active&&!state.pending&&state.conversationId===conversationId&&state.snapshot?.run.id===targetRunId)publish({error:errorCode(error)});return accepted;}catch{}}publish({ phase: 'unknown', error: errorCode(error) });} return false; } finally { busy = false; }
  }
  function authorizationReview(): AgentTaskAuthorizationReview | null {
    const project = state.project;
    if (!active || !visible || !project || project.readOnly || receiptsBlocked || busy || state.pending || !agentTaskPromptValid(state.draft) || agentTaskNewConversationBlock(state)!==null) return null;
    return { projectId, settingsRevision: project.settings.revision, authorizationRevision: project.authorization.revision, destination: deriveAgentEndpoint(project.settings.configuration), model: project.settings.configuration.model, text: state.draft, uploads: state.uploads.map(upload => upload.id), locale: getLocale(),conversationId:state.conversationId,modes:state.conversationId===null&&state.policy.conversationId===null?state.policy.modes:null };
  }
  function sameReview(review: AgentTaskAuthorizationReview, includeAuthorization: boolean): boolean {
    const current = authorizationReview();
    return Boolean(current && current.projectId === review.projectId && current.conversationId===review.conversationId && current.settingsRevision === review.settingsRevision && (!includeAuthorization || current.authorizationRevision === review.authorizationRevision) && current.destination === review.destination && current.model === review.model && current.text === review.text && current.locale === review.locale && JSON.stringify(current.uploads) === JSON.stringify(review.uploads) && JSON.stringify(current.modes ?? null) === JSON.stringify(review.modes ?? null));
  }
  async function authorize(): Promise<boolean> {
    if (!active || !visible || !state.project || state.project.readOnly || busy || agentTaskSessionBusy(state) || state.pending) return false;
    busy = true; publish({ phase: 'submitting', error: '' });
    try { await client.authorize(state.project, requestId()); busy = false; await load(); return state.phase === 'ready' && state.project?.authorization.scopes.includes('project_agent') === true; }
    catch (error) { if (active) publish({ phase: 'error', error: errorCode(error) }); return false; }
    finally { busy = false; }
  }
  return { getState: () => state, load, reconcile, refreshRound, choosePolicy, setGlobalPolicy, send: () => mutate('send'), note: () => mutate('note',{text:state.draft}), answer: (stepId:string,choices:number[],text?:string,runId?:string) => mutate('answer',{stepId,choices,...(text!==undefined?{text}:{})},runId), action: (action: AgentTaskPanelControlAction, extras?: AgentTaskControlExtras,runId?:string) => mutate(action, extras,runId), edit(text: string,selectionKey=state.selectionKey) { if (active && visible&&selectionKey===state.selectionKey) publish({ draft: text }); },
    authorizationReview,
    async authorizeAndSend(review: AgentTaskAuthorizationReview) {
      // Confirm exactly the reviewed destination and input. A settings, draft,
      // attachment or visibility change never grants permission to a new send.
      const epoch = authorizationEpoch;
      if (!sameReview(review, true) || !await authorize() || epoch !== authorizationEpoch || !sameReview(review, false)) return false;
      return mutate('send');
    },
    async history(older=false){if(!active||!visible||state.history.phase==='loading'||older&&!state.history.nextCursor)return false;const token=++historyEpoch;publish({history:{...state.history,phase:'loading'}});try{const page=await client.history(projectId,older?state.history.nextCursor:null);if(!active||!visible||token!==historyEpoch)return false;if(page.conversations.some(item=>item.projectId!==projectId))throw failure('INVALID_RESPONSE');if(older&&page.nextCursor===state.history.nextCursor)throw failure('INVALID_RESPONSE');publish({history:{...page,conversations:older?[...state.history.conversations,...page.conversations.filter(item=>!state.history.conversations.some(existing=>existing.id===item.id))]:page.conversations,phase:'ready'}});return true;}catch{if(active&&token===historyEpoch)publish({history:{...state.history,phase:'error'}});return false;}},
    async upload(file: {name:string;type:string;size:number;arrayBuffer():Promise<ArrayBuffer>},expectedSelection=state.selectionKey) { if (expectedSelection!==state.selectionKey || !active || !visible || busy || agentTaskSessionBusy(state) || state.pending || state.project?.readOnly || receiptsBlocked || file.size > (/\.cube$/iu.test(file.name)?7:30)*1024*1024 || file.size < 1) return false; const owner=generation,selectionKey=state.selectionKey,pending:AgentTaskPending={requestId:requestId(),runId:null,action:'upload',conversationId:state.conversationId}; try{persist(pending);}catch{publish({phase:'error',error:'LOCAL_RECEIPT_UNAVAILABLE'});return false;} busy=true;publish({phase:'submitting',error:''});let dispatched=false;try{const bytes=new Uint8Array(await file.arrayBuffer());if(!active||!visible||owner!==generation||state.selectionKey!==selectionKey)throw failure('REQUEST_BLOCKED');if(bytes.byteLength!==file.size)throw failure('INVALID_FILE');let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));dispatched=true;const upload=await client.upload(projectId,{requestId:pending.requestId,name:file.name,mimeType:uploadMimeType(file.type),dataBase64:btoa(binary)});if(!active||owner!==generation||state.selectionKey!==selectionKey)return false;publish({uploads:[...state.uploads,upload],phase:'ready',error:''});persist(null);return true;}catch(error){if(active&&owner===generation){if(!dispatched){try{persist(null);}catch{}publish({phase:'error',error:errorCode(error)});}else if(agentTaskDefinitiveFailure(error)){try{persist({...pending,definitiveRejected:true});busy=false;return await reconcile();}catch{publish({phase:'unknown',error:errorCode(error)});}}else publish({phase:'unknown',error:errorCode(error)});}return false;}finally{busy=false;} },
    removeUpload(id:string,selectionKey=state.selectionKey){if(active&&visible&&selectionKey===state.selectionKey&&!state.pending&&!busy)publish({uploads:state.uploads.filter(upload=>upload.id!==id)});},
    authorize,
    async select(runId: string) { if (busy || receiptsBlocked || state.pending || !active || !visible) return; authorizationEpoch++; const owner = ++generation; detach(); publish({ phase: 'loading' }); try { const next = await client.read(projectId, runId); if (active && owner === generation) { const id=conversationIdOf(next.run);publish({...switchDraft(id),conversationId:id,rounds:[],snapshot:null});accept(next); publish({ phase: 'ready' }); void observe(); } } catch (error) { if (active && owner === generation) publish({ phase: state.pending ? 'unknown' : 'read_error', error: errorCode(error) }); } },
    async selectConversation(id:string){if(busy||receiptsBlocked||state.pending||!active||!visible||!uuid.test(id))return false;authorizationEpoch++;const owner=++generation;selectionOwner=owner;detach();publish({phase:'loading',error:''});try{const value=await readConversation(id,owner);if(!value)return false;showConversation(value);void observe();return true;}catch(error){if(active&&owner===generation)publish({phase:'read_error',error:errorCode(error)});return false;}finally{if(selectionOwner===owner)selectionOwner=null;}},
    cancelSelection(){if(selectionOwner===null)return;selectionOwner=null;generation++;detach();publish({phase:'ready',error:''});void observe();},
    newConversation(){if(!active||!visible||busy||receiptsBlocked||agentTaskNewConversationBlock(state))return false;authorizationEpoch++;generation++;detach();selectionChosen=true;publish({...switchDraft('new'),conversationId:null,conversation:null,rounds:[],snapshot:null,phase:'ready',error:''});return true;},
    setVisible(next: boolean) { if(visible===next)return;authorizationEpoch++;visible = next; if (!visible) detach(); else if (active && !busy) void load(); },
    dispose() { active = false; generation++;historyEpoch++;authorizationEpoch++; detach(); },
  };
}
