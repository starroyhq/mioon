import { agentTaskPolicySchema, agentTaskSnapshotSchema, agentTaskRunSchema, agentTaskEventSchema, agentTaskReceiptSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskControlAction, AgentTaskControlInput, AgentTaskEvent, AgentTaskPolicy, AgentTaskRun, AgentTaskSnapshot, AgentTaskReceipt } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { agentAuthorizationReceiptSchema, safeAgentAuthorizationSnapshot } from './agent-authorization-state.ts';
import type { AgentAuthorizationSnapshot } from '../../../packages/contracts/src/agent-authorization.ts';
import { deriveAgentEndpoint, safeAgentSettings } from './agent-settings.ts';
import type { AgentSettingsSnapshot } from './agent-settings.ts';
import { readAgentChatSSE } from './agent-chat.ts';

export interface AgentTaskProjectSnapshot { version: 2; instanceId: string; projectId: string; runs: AgentTaskRun[]; policy: AgentTaskPolicy; settings: AgentSettingsSnapshot; authorization: AgentAuthorizationSnapshot; readOnly?: boolean }
export interface AgentTaskUpload {id: string; name: string; mimeType: string; status: string}
export interface AgentTaskPolicyView {policy: AgentTaskPolicy; readOnly: boolean}
export interface AgentTaskLookup { found: boolean; snapshot?: AgentTaskSnapshot; upload?: AgentTaskUpload; receipt?:AgentTaskReceipt }
export interface AgentTaskPending { requestId: string; runId: string | null; action: 'send' | 'upload' | AgentTaskControlAction; definitiveRejected?:boolean }
export interface AgentTaskClient {
  list(projectId: string): Promise<AgentTaskProjectSnapshot>;
  history(projectId:string,cursor?:string|null):Promise<{runs:AgentTaskRun[];nextCursor:string|null}>;
  read(projectId: string, runId: string): Promise<AgentTaskSnapshot>;
  send(projectId: string, input: { requestId: string; text: string; expectedSettingsRevision: number; uploads?: string[] }): Promise<AgentTaskSnapshot>;
  upload(projectId: string, input: {requestId: string; name: string; mimeType: string; dataBase64: string}): Promise<AgentTaskUpload>;
  action(projectId: string, input: AgentTaskControlInput): Promise<AgentTaskSnapshot>;
  lookup(projectId: string, pending: AgentTaskPending): Promise<AgentTaskLookup>;
  authorize(snapshot: AgentTaskProjectSnapshot, requestId: string): Promise<void>;
  stream(projectId: string, runId: string, after: number, signal: AbortSignal, onEvent: (event: AgentTaskEvent) => void): Promise<void>;
  policy(): Promise<AgentTaskPolicyView>;
  savePolicy(input: AgentTaskPolicy & {requestId: string; expectedRevision: number; acknowledgePaid?: boolean}): Promise<AgentTaskPolicyView>;
  lookupPolicy(requestId: string): Promise<{found: boolean; policy?: AgentTaskPolicy; readOnly: boolean}>;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const agentTaskPromptValid=(text:string):boolean=>Boolean(text.trim())&&text.length<=32000&&new TextEncoder().encode(text).byteLength<=32768;
const failure = (code = 'NETWORK',definitive=false) => Object.assign(new Error('Agent task request failed'), { code,definitive });
export const agentTaskDefinitiveFailure=(error:unknown):boolean=>record(error)&&error.definitive===true;
function safeUpload(value: unknown): AgentTaskUpload { if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.mimeType !== 'string' || typeof value.status !== 'string') throw failure('INVALID_RESPONSE'); return {id:value.id,name:value.name,mimeType:value.mimeType,status:value.status}; }
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
    history:async(projectId,cursor=null)=>{const value=await json(`${path(projectId)}/history${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);if(!record(value)||!Array.isArray(value.runs)||value.nextCursor!==null&&typeof value.nextCursor!=='string')throw failure('INVALID_RESPONSE');const runs=value.runs.map(run=>agentTaskRunSchema.parse(run));if(runs.some(run=>run.projectId!==projectId))throw failure('INVALID_RESPONSE');return{runs,nextCursor:value.nextCursor as string|null};},
    read: async (projectId, runId) => safeAgentTaskSnapshot(await json(path(projectId, runId)), projectId, runId),
    send: async (projectId, input) => safeAgentTaskSnapshot(await json(path(projectId), 'POST', input), projectId),
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
    lookupPolicy: async requestId => { const value = await json(`${root}/policy/requests/${encodeURIComponent(requestId)}`); if (!record(value) || typeof value.found !== 'boolean' || typeof value.readOnly !== 'boolean') throw failure('INVALID_RESPONSE'); return {found:value.found,readOnly:value.readOnly,...(value.policy === undefined ? {} : {policy:agentTaskPolicySchema.parse(value.policy)})}; },
  };
}

export interface AgentTaskSessionState { phase: 'loading' | 'ready' | 'submitting' | 'unknown' | 'detached' | 'error' | 'read_error'; project: AgentTaskProjectSnapshot | null; snapshot: AgentTaskSnapshot | null; draft: string; uploads: AgentTaskUpload[]; pending: AgentTaskPending | null; error: string; history:{runs:AgentTaskRun[];nextCursor:string|null;phase:'closed'|'loading'|'ready'|'error'} }
export interface AgentTaskReceiptStore { read(projectId: string): AgentTaskPending | null; write(projectId: string, value: AgentTaskPending | null): void }
export function createAgentTaskReceiptStore(storage: () => Storage | null = () => typeof sessionStorage === 'undefined' ? null : sessionStorage, workspaceScope = 'normal'): AgentTaskReceiptStore {
  const key = (id: string) => `mioon.agent-task-v2.pending.${encodeURIComponent(workspaceScope)}.${id}`;
  return { read(id) { const store=storage();if(!store)throw failure('LOCAL_RECEIPT_UNAVAILABLE');const raw:unknown=JSON.parse(store.getItem(key(id))??'null');if(raw===null)return null;if(!record(raw)||typeof raw.requestId!=='string'||raw.requestId.length<8||raw.runId!==null&&typeof raw.runId!=='string'||typeof raw.action!=='string'||!['send','upload','pause','resume','stop','approve','deny','undo_change','undo_all','resolve_unknown'].includes(raw.action))throw failure('LOCAL_RECEIPT_UNAVAILABLE');return raw as unknown as AgentTaskPending; }, write(id, value) { const store = storage(); if (!store)throw failure('LOCAL_RECEIPT_UNAVAILABLE'); if (value) store.setItem(key(id), JSON.stringify(value)); else store.removeItem(key(id)); } };
}
const terminal = new Set(['completed', 'failed', 'stopped', 'reverted']);
const finished=(snapshot:AgentTaskSnapshot):boolean=>terminal.has(snapshot.run.status)&&snapshot.backgroundPending!==true;
export function createAgentTaskSession({ projectId, client = createAgentTaskClient(), receipts = createAgentTaskReceiptStore(), requestId = () => crypto.randomUUID(), onChange = () => {}, onChangeApplied = () => {} }: { projectId: string; client?: AgentTaskClient; receipts?: AgentTaskReceiptStore; requestId?: () => string; onChange?: (state: AgentTaskSessionState) => void; onChangeApplied?: (snapshot: AgentTaskSnapshot) => void }) {
  let restored:AgentTaskPending|null=null,receiptsBlocked=false;try{restored=receipts.read(projectId);}catch{receiptsBlocked=true;}
  let state: AgentTaskSessionState = { phase: receiptsBlocked?'error':'loading', project: null, snapshot: null, draft: '', uploads: [], pending: restored, error: receiptsBlocked?'LOCAL_RECEIPT_UNAVAILABLE':'',history:{runs:[],nextCursor:null,phase:'closed'} }, active = true, generation = 0, visible = true, busy = false, after = 0, historyEpoch=0, retryAttempt=0, stream: AbortController | null = null, retry: ReturnType<typeof setTimeout> | null = null;
  const publish = (patch: Partial<AgentTaskSessionState>) => { state = { ...state, ...patch }; if (active) onChange(state); };
  const persist = (value: AgentTaskPending | null) => { receipts.write(projectId, value); publish({ pending: value }); };
  const accept = (next: AgentTaskSnapshot) => {
    if (!active) return;
    safeAgentTaskSnapshot(next, projectId);
    if (state.snapshot?.run.id === next.run.id && state.snapshot.run.revision > next.run.revision) return;
    if (state.snapshot?.run.id !== next.run.id) after = 0;
    const changed = JSON.stringify(state.snapshot?.changes) !== JSON.stringify(next.changes);
    publish({ snapshot: next, ...(state.project?{project:{...state.project,runs:[next.run,...state.project.runs.filter(run=>run.id!==next.run.id)].slice(0,100)}}:{}) }); if (changed) onChangeApplied(next);
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
    busy = true;
    try { const result = await client.lookup(projectId, pending); if (!active || generation !== owner) return false;
      if(!result.found&&pending.definitiveRejected){
        persist(null);
        // No upload was accepted: keep its notice and selection without a reload
        // that clears the notice or a hard-error phase that blocks native close.
        if(pending.action==='upload'){publish({phase:'ready',error:'UPLOAD_REJECTED'});return false;}
        busy=false;await load();return false;
      }
      if (!result.found || !result.snapshot && !result.upload) { publish({ phase: 'unknown', error: 'REQUEST_UNCONFIRMED' }); return false; } if (result.snapshot) accept(result.snapshot); if (result.upload && !state.uploads.some(upload=>upload.id===result.upload!.id)) publish({uploads:[...state.uploads,result.upload]});
      if(result.receipt&&record(result.receipt.result)&&result.receipt.result.state==='pending'){publish({phase:'unknown',error:'OPERATION_PENDING'});return false;}
      persist(null); publish({ phase: 'ready', error: result.receipt&&record(result.receipt.result)&&result.receipt.result.state==='blocked'?'REQUEST_BLOCKED':'' }); void observe(); return true; }
    catch (error) { if (active && generation === owner) publish({ phase: 'unknown', error: errorCode(error) }); return false; } finally { busy = false; }
  }
  async function load() {
    if(receiptsBlocked){try{const restored=receipts.read(projectId);receiptsBlocked=false;publish({pending:restored});}catch{publish({phase:'error',error:'LOCAL_RECEIPT_UNAVAILABLE'});return;}}
    const owner = ++generation; detach(); publish({ phase: 'loading', error: '' });
    try { const next = await client.list(projectId); if (!active || owner !== generation) return; publish({ project: next }); if (state.pending) { publish({ phase: 'unknown' }); await reconcile(); return; } const chosen = state.snapshot?.run.id ?? next.runs[0]?.id; if (chosen) {const snapshot=await client.read(projectId,chosen);if(!active||owner!==generation)return;accept(snapshot);} if (!active || owner !== generation) return; publish({ phase: 'ready' }); void observe(); }
    // A failed GET after a verified receipt read must not trap an untouched
    // window behind the same close gate needed to restart its local service.
    catch (error) { if (active && owner === generation) publish({ phase: state.pending ? 'unknown' : 'read_error', error: errorCode(error) }); }
  }
  async function mutate(action: 'send' | AgentTaskControlAction, extras: Partial<Pick<AgentTaskControlInput, 'stepId' | 'changeId' | 'resolution'>> = {}) {
    if (!active || !visible || receiptsBlocked || busy || state.pending || !state.project || state.project.readOnly || action !== 'send' && !state.snapshot) return false;
    if (action === 'send' && (!agentTaskPromptValid(state.draft) || !state.project.authorization.scopes.includes('project_agent') || state.snapshot && !terminal.has(state.snapshot.run.status))) return false;
    const owner = generation, pending: AgentTaskPending = { requestId: requestId(), action, runId: action === 'send' ? null : state.snapshot!.run.id }, text = state.draft;
    try { persist(pending); } catch { publish({ phase: 'error', error: 'LOCAL_RECEIPT_UNAVAILABLE' }); return false; }
    busy = true; publish({ phase: 'submitting', error: '' });
    try { const next = action === 'send' ? await client.send(projectId, { requestId: pending.requestId, text, expectedSettingsRevision: state.project.settings.revision, ...(state.uploads.length ? {uploads:state.uploads.map(upload=>upload.id)} : {}) }) : await client.action(projectId, { requestId: pending.requestId, runId: pending.runId!, expectedRevision: state.snapshot!.run.revision, action, ...extras }); if (!active || owner !== generation) return false; accept(next); if(action==='undo_all'||action==='undo_change'){busy=false;return await reconcile();} persist(null); publish({ phase: 'ready', ...(action === 'send' && state.draft === text ? { draft: '', uploads:[] } : {}) }); void observe(); return true; }
    catch (error) { if (active && owner === generation) {if(agentTaskDefinitiveFailure(error)){try{persist({...pending,definitiveRejected:true});busy=false;return await reconcile();}catch{}}publish({ phase: 'unknown', error: errorCode(error) });} return false; } finally { busy = false; }
  }
  return { getState: () => state, load, reconcile, send: () => mutate('send'), action: (action: AgentTaskControlAction, extras?: Partial<Pick<AgentTaskControlInput, 'stepId' | 'changeId' | 'resolution'>>) => mutate(action, extras), edit(text: string) { if (active && visible) publish({ draft: text }); },
    async history(older=false){if(!active||!visible||state.history.phase==='loading'||older&&!state.history.nextCursor)return false;const token=++historyEpoch;publish({history:{...state.history,phase:'loading'}});try{const page=await client.history(projectId,older?state.history.nextCursor:null);if(!active||token!==historyEpoch)return false;publish({history:{...page,runs:older?[...state.history.runs,...page.runs.filter(run=>!state.history.runs.some(existing=>existing.id===run.id))]:page.runs,phase:'ready'}});return true;}catch{if(active&&token===historyEpoch)publish({history:{...state.history,phase:'error'}});return false;}},
    async upload(file: {name:string;type:string;size:number;arrayBuffer():Promise<ArrayBuffer>}) { if (!active || !visible || busy || state.pending || state.project?.readOnly || receiptsBlocked || file.size > (/\.cube$/iu.test(file.name)?7:30)*1024*1024 || file.size < 1) return false; const owner=generation,pending:AgentTaskPending={requestId:requestId(),runId:null,action:'upload'}; try{persist(pending);}catch{publish({phase:'error',error:'LOCAL_RECEIPT_UNAVAILABLE'});return false;} busy=true;publish({phase:'submitting',error:''});let dispatched=false;try{const bytes=new Uint8Array(await file.arrayBuffer());if(bytes.byteLength!==file.size)throw failure('INVALID_FILE');let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));dispatched=true;const upload=await client.upload(projectId,{requestId:pending.requestId,name:file.name,mimeType:uploadMimeType(file.type),dataBase64:btoa(binary)});if(!active||owner!==generation)return false;publish({uploads:[...state.uploads,upload],phase:'ready',error:''});persist(null);return true;}catch(error){if(active&&owner===generation){if(!dispatched){try{persist(null);}catch{}publish({phase:'error',error:errorCode(error)});}else if(agentTaskDefinitiveFailure(error)){try{persist({...pending,definitiveRejected:true});busy=false;return await reconcile();}catch{publish({phase:'unknown',error:errorCode(error)});}}else publish({phase:'unknown',error:errorCode(error)});}return false;}finally{busy=false;} },
    removeUpload(id:string){if(active&&visible&&!state.pending&&!busy)publish({uploads:state.uploads.filter(upload=>upload.id!==id)});},
    async authorize() { if (!active || !visible || !state.project || state.project.readOnly || busy || state.pending) return false; busy = true; publish({ phase: 'submitting' }); try { await client.authorize(state.project, requestId()); busy = false; await load(); return true; } catch (error) { publish({ phase: 'error', error: errorCode(error) }); return false; } finally { busy = false; } },
    async select(runId: string) { if (busy || receiptsBlocked || state.pending || !active || !visible) return; const owner = ++generation; detach(); publish({ phase: 'loading' }); try { const next = await client.read(projectId, runId); if (active && owner === generation) { accept(next); publish({ phase: 'ready' }); void observe(); } } catch (error) { if (active && owner === generation) publish({ phase: state.pending ? 'unknown' : 'read_error', error: errorCode(error) }); } },
    setVisible(next: boolean) { if(visible===next)return;visible = next; if (!visible) detach(); else if (active && !busy) void load(); },
    dispose() { active = false; generation++;historyEpoch++; detach(); },
  };
}
