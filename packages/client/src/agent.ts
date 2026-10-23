// Node-only management client. Deliberately outside the RPC/MCP tool catalog.
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveConnection} from './connection.ts';
import type {LocalConnection} from './connection.ts';
import {ClientError,EXIT_CODES,safeValue} from './index.ts';
import type {ClientOptions} from './index.ts';
import {agentTaskSendSchema,agentTaskDiagnosticSchema,agentTaskControlSchema,agentTaskControlBaseSchema,agentTaskNoteControlSchema,agentTaskPolicySchema,agentTaskSnapshotSchema,agentTaskRunSchema,agentTaskHistoryPageSchema,agentTaskConversationPageSchema,agentTaskReceiptSchema} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskSnapshot} from '@mioon/contracts/agent-tasks-v2';
import {agentAuthorizationSnapshotSchema} from '@mioon/contracts';

const id=z.string().uuid(),revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),requestId=z.string().min(8).max(200);
const text=z.string().max(4096),code=z.string().regex(/^[A-Z][A-Z0-9_]{1,90}$/u);
export const agentConfigurationSchema=z.object({presetId:z.string().min(1).max(100),platformId:z.string().min(1).max(100),baseUrl:z.string().url().max(2048).refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}}),model:z.string().min(1).max(200),protocol:z.enum(['chat_completions','responses'])}).strict();
const presetProtocols={defaultProtocol:z.enum(['chat_completions','responses']),availableProtocols:z.array(z.enum(['chat_completions','responses'])).max(2),supportedModelHints:z.record(z.array(text).max(20)).optional(),protocolNotes:z.record(text).optional()};
const platformSchema=z.object({id:text,label:text,baseUrl:text,model:text,...presetProtocols,notes:text.optional(),baseUrlTemplate:text.optional(),sources:z.array(z.object({label:text,url:text})).max(20)});
export const agentSettingsSnapshotSchema=z.object({revision,configuration:agentConfigurationSchema,secret:z.object({configured:z.boolean(),storage:z.enum(['none','session','persistent'])}),storage:z.object({persistentAvailable:z.boolean(),sessionScope:z.enum(['app','server']),reasonCode:code.nullable()}),presets:z.array(z.object({id:text,label:text,description:text,...presetProtocols,platforms:z.array(platformSchema).max(20)})).max(30),scope:z.literal('settings_only'),verification:z.literal('not_tested')}).refine(value=>value.secret.configured===(value.secret.storage!=='none'));
export type AgentSettingsSnapshot=z.infer<typeof agentSettingsSnapshotSchema>;
export const agentDiagnosticSchema=agentTaskDiagnosticSchema;
const sendSchema=agentTaskSendSchema;
const location=z.object({projectId:id,runId:id}).strict();
const settingInput=z.object({expectedRevision:revision,configuration:agentConfigurationSchema}).strict();
const policyInput=agentTaskPolicySchema.omit({revision:true}).extend({requestId,expectedRevision:revision,acknowledgePaid:z.boolean().optional()}).strict();
const uploadInput=z.object({projectId:id,requestId,name:z.string().min(1).max(200),mimeType:z.string().min(1).max(100),dataBase64:z.string().max(40*1024*1024)}).strict();
const watchInput=location.extend({after:revision.optional()});
export const AGENT_COMMAND_SCHEMAS=Object.freeze({
 'agent.settings.get':z.object({}).strict(),'agent.settings.set':settingInput,'agent.settings.secret.set':settingInput,'agent.settings.secret.remove':settingInput,
 'agent.doctor':z.object({projectId:id.optional()}).strict(),'agent.diagnose':sendSchema.extend({diagnostic:agentDiagnosticSchema}),
 'agent.policy.get':z.object({}).strict(),'agent.policy.set':policyInput,'agent.policy.lookup':z.object({requestId}).strict(),
 'agent.task.conversation':z.object({projectId:id,conversationId:id,cursor:z.string().max(512).optional()}).strict(),
 'agent.task.list':z.object({projectId:id}).strict(),'agent.task.history':z.object({projectId:id,cursor:z.string().max(512).optional()}).strict(),
 'agent.task.status':location,'agent.task.send':sendSchema,'agent.task.lookup':z.object({projectId:id,requestId}).strict(),
 'agent.task.upload':uploadInput.omit({dataBase64:true}).partial({name:true,mimeType:true}),'agent.task.upload-lookup':z.object({projectId:id,requestId}).strict(),
 'agent.task.action-lookup':location.extend({requestId}),'agent.task.watch':watchInput,'agent.task.events':watchInput,
});
export const AGENT_CONTROL_COMMANDS=Object.freeze({'pause':'pause','resume':'resume','stop':'stop','approve':'approve','deny':'deny','skip':'skip','note':'note','undo-change':'undo_change','undo-all':'undo_all','resolve-unknown':'resolve_unknown'} as const);
export type AgentControlCommand=keyof typeof AGENT_CONTROL_COMMANDS;
export const agentControlInputSchema=agentTaskControlBaseSchema.extend({projectId:id}).strict();
export const agentNoteInputSchema=agentTaskNoteControlSchema.omit({action:true}).extend({projectId:id}).strict();
export const agentControlCommandInputSchema=(command:AgentControlCommand)=>command==='note'?agentNoteInputSchema:agentControlInputSchema;
export const agentInputSchema=(schema:z.ZodTypeAny):unknown=>zodToJsonSchema(schema,{$refStrategy:'none'});
const uploadSchema=z.object({id,name:text,mimeType:text,status:z.string().max(80),handle:id.optional()});
const projectSchema=z.object({version:z.literal(2),instanceId:z.string().min(1).max(200),projectId:id,runs:z.array(agentTaskRunSchema).max(100),policy:agentTaskPolicySchema,settings:agentSettingsSnapshotSchema,authorization:agentAuthorizationSnapshotSchema,readOnly:z.boolean().optional()});
const policyView=z.object({policy:agentTaskPolicySchema,readOnly:z.boolean()});
const doctorSchema=z.object({version:z.literal(1),settings:agentSettingsSnapshotSchema,policy:agentTaskPolicySchema,authorization:agentAuthorizationSnapshotSchema,catalog:z.object({count:revision,valid:z.boolean(),issues:z.array(z.object({code,tool:z.string().max(100).optional(),path:z.string().max(512).optional()})).max(500)}),projectId:id.optional(),verification:z.literal('not_tested')});
type Json=Record<string,unknown>;
type Recovery={operation:string;projectId?:string;runId?:string;requestId?:string;lookup:string};
export interface AgentRequestOptions {signal?:AbortSignal;timeoutMs?:number}
export interface AgentWatchOptions extends AgentRequestOptions {intervalMs?:number;onProgress?:(snapshot:AgentTaskSnapshot,sequence:number)=>void}
export interface AgentWatchResult {outcome:'completed'|'action_needed'|'failed'|'stopped';sequence:number;snapshot:AgentTaskSnapshot}
const object=(value:unknown):value is Json=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=():never=>{throw new ClientError('VALIDATION_ERROR','Invalid Agent command input. Run the command with --help.');};
export function parseAgentInput<T>(schema:z.ZodType<T>,value:unknown):T {const parsed=schema.safeParse(value);if(!parsed.success)return invalid();return parsed.data;}
const api='/api/agent/tasks/v2';
const projectPath=(projectId:string)=>`${api}/${encodeURIComponent(projectId)}`;
const runPath=(projectId:string,runId:string)=>`${projectPath(projectId)}/${encodeURIComponent(runId)}`;
const requestLookupSchema=z.object({found:z.boolean(),snapshot:agentTaskSnapshotSchema.optional()}).refine(value=>value.found===(value.snapshot!==undefined));
const uploadLookupSchema=z.object({found:z.boolean(),upload:uploadSchema.optional()}).refine(value=>value.found===(value.upload!==undefined));
const actionLookupSchema=z.object({found:z.boolean(),snapshot:agentTaskSnapshotSchema.optional(),receipt:agentTaskReceiptSchema.optional()}).refine(value=>value.found===(value.snapshot!==undefined)&&value.found===(value.receipt!==undefined));
const validateSnapshot=(value:unknown,projectId:string,runId?:string):AgentTaskSnapshot=>{const parsed=agentTaskSnapshotSchema.safeParse(value);if(!parsed.success||parsed.data.run.projectId!==projectId||runId!==undefined&&parsed.data.run.id!==runId||parsed.data.steps.some(step=>step.runId!==parsed.data.run.id)||parsed.data.changes.some(change=>change.runId!==parsed.data.run.id||change.projectId!==projectId))throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid Agent task response.');return parsed.data;};
function outcome(snapshot:AgentTaskSnapshot):AgentWatchResult['outcome']|null {
 if(snapshot.run.status==='stopped')return 'stopped';
 if(snapshot.steps.some(step=>step.status==='unknown')||['paused','awaiting_approval','interrupted'].includes(snapshot.run.status))return 'action_needed';
 if(snapshot.run.status==='failed')return 'failed';
 if(['completed','reverted'].includes(snapshot.run.status)&&!snapshot.backgroundPending)return 'completed';
 return null;
}
function timeout(value:number):number{if(!Number.isSafeInteger(value)||value<1||value>86400000)return invalid();return value;}
async function responseJson(response:Response):Promise<unknown>{
 if(!response.body)throw new ClientError('BACKEND_PROTOCOL_ERROR','Empty Agent response.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16*1024*1024)throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent response exceeds the safe size limit.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new ClientError('BACKEND_PROTOCOL_ERROR','Unreadable Agent response.');}
}
/** A failed write is never retried. Recovery metadata names only a GET lookup. */
export function createAgentClient({env=process.env,fetchImpl=fetch,requestTimeoutMs=30000}:ClientOptions={}){
 async function request(route:string,{method='GET',body,signal,timeoutMs=requestTimeoutMs,recovery,secret,validate,connection}:{method?:'GET'|'POST'|'PUT';body?:unknown;recovery?:Recovery;secret?:string;validate?:(value:unknown)=>unknown;connection?:LocalConnection}&AgentRequestOptions={}):Promise<unknown>{
  timeout(timeoutMs);const checkpoint=()=>{if(signal?.aborted)throw new ClientError('INTERRUPTED','Stopped locally before dispatch.',{exitCode:EXIT_CODES.interrupted});};checkpoint();const {base,token}=connection??await resolveConnection(env);checkpoint();
  const timer=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timer]):timer;
  const details=recovery?{...recovery,outcomeUnknown:true,recovery:'Query the original operation with GET. Do not resubmit or invent another request ID.'}:{};
  try{
   const response=await fetchImpl(base+route,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:combined,redirect:'error'});
   const value=await responseJson(response);
   if(!object(value)||typeof value.ok!=='boolean'||value.ok&&(!response.ok||!Object.hasOwn(value,'data'))||!value.ok&&response.ok)throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid Agent response.');
   if(!value.ok||!response.ok){const raw=object(value.error)?value.error.code:undefined;const safeCode=typeof raw==='string'&&/^(?:AGENT_TASK_|AGENT_SETTINGS_|RESTORE_|WORKSPACE_)[A-Z0-9_]{1,80}$|^(?:UNAUTHORIZED|ORIGIN_REJECTED|METHOD_NOT_ALLOWED)$/u.test(raw)?String(safeValue(raw,[token,secret??''])):'BACKEND_PROTOCOL_ERROR';throw new ClientError(safeCode,'The local backend rejected the Agent operation.',{status:response.status,details:recovery?{...recovery,recovery:'Query the original operation before any further action.'}:{}});}
   validate?.(value.data);return value.data;
  }catch(error){
   if(signal?.aborted)throw new ClientError('INTERRUPTED','Stopped locally; the Agent task was not cancelled.',{details,exitCode:EXIT_CODES.interrupted});
   if(timer.aborted)throw new ClientError('TIMEOUT','The Agent observation or request timed out.',{details,exitCode:EXIT_CODES.timeout});
   if(error instanceof ClientError&&error.status!==undefined)throw error;
   if(recovery)throw new ClientError(recovery.operation==='settings.put'?'AGENT_SETTINGS_OUTCOME_UNKNOWN':'AGENT_OPERATION_OUTCOME_UNKNOWN','The response is unknown. Read the original state or receipt; do not resubmit.',{details,exitCode:EXIT_CODES.conflict});
   if(error instanceof ClientError)throw error;
   throw new ClientError('BACKEND_UNAVAILABLE','The local Agent backend is unavailable.');
  }
 }
 function parsed<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new ClientError('BACKEND_PROTOCOL_ERROR','Invalid Agent response.');return result.data;}
 const client={
  async settingsGet(options:AgentRequestOptions={}){return parsed(agentSettingsSnapshotSchema,await request('/api/agent/settings',options));},
  async settingsPut(value:unknown,secret:{action:'keep'|'remove'}|{action:'replace';storage:'session'|'persistent';value:string}={action:'keep'},options:AgentRequestOptions={}){
   const input=parseAgentInput(settingInput,value);
   const secretSchema=z.union([z.object({action:z.enum(['keep','remove'])}).strict(),z.object({action:z.literal('replace'),storage:z.enum(['session','persistent']),value:z.string().min(1).refine(v=>Buffer.byteLength(v)<=8192&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)&&Boolean(v.trim()))}).strict()]);
   const chosen=parseAgentInput(secretSchema,secret);
   const connection=await resolveConnection(env);
   try{return parsed(agentSettingsSnapshotSchema,await request('/api/agent/settings',{...options,connection,method:'PUT',body:{...input,secret:chosen},secret:'value'in chosen?chosen.value:undefined,validate:value=>parsed(agentSettingsSnapshotSchema,value),recovery:{operation:'settings.put',lookup:'agent settings get'}}));}
   catch(error){
    if(!(error instanceof ClientError)||!object(error.details)||error.details.outcomeUnknown!==true)throw error;
    const recoveryDetails=error.details;
    // Settings have no durable request receipt. Observe once on the same bound
    // local connection, but never interpret revision/configured as proof that
    // this write (especially a replacement key) succeeded. Ctrl+C stays local.
    let observation:Record<string,unknown>={state:'not_attempted',reason:'cancelled'};
    if(!options.signal?.aborted){
     try{
      const current=parsed(agentSettingsSnapshotSchema,await request('/api/agent/settings',{connection,signal:options.signal,timeoutMs:Math.min(options.timeoutMs??requestTimeoutMs,5000)}));
      observation={state:'read',revision:current.revision,configurationMatchesRequested:JSON.stringify(current.configuration)===JSON.stringify(input.configuration),keyConfigured:current.secret.configured,keyStorage:current.secret.storage,provesWriteSucceeded:false};
     }catch(readError){
      const readCode=readError instanceof ClientError&&['BACKEND_UNAVAILABLE','BACKEND_PROTOCOL_ERROR','TIMEOUT','INTERRUPTED'].includes(readError.code)?readError.code:'BACKEND_UNAVAILABLE';
      observation={state:'unavailable',code:readCode,provesWriteSucceeded:false};
     }
    }
    const interrupted=options.signal?.aborted===true;
    throw new ClientError(interrupted?'INTERRUPTED':error.code,interrupted?'Stopped observing locally; the settings write outcome remains unknown. Read the original settings; do not resubmit.':error.message,{status:error.status,exitCode:interrupted?EXIT_CODES.interrupted:error.exitCode,details:{...recoveryDetails,observation}});
   }
  },
  async doctor(value:unknown={},options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.doctor'],value);const result=parsed(doctorSchema,await request(`/api/agent/diagnostics${input.projectId?`?projectId=${encodeURIComponent(input.projectId)}`:''}`,options));if(result.projectId!==input.projectId)throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent diagnostic project mismatch.');return result;},
  async policyGet(options:AgentRequestOptions={}){return parsed(policyView,await request(`${api}/policy`,options));},
  async policySet(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(policyInput,value);return parsed(policyView,await request(`${api}/policy`,{...options,method:'PUT',body:input,validate:value=>parsed(policyView,value),recovery:{operation:'policy.set',requestId:input.requestId,lookup:'agent policy lookup'}}));},
  async policyLookup(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.policy.lookup'],value);return parsed(z.object({found:z.boolean(),policy:agentTaskPolicySchema.optional(),readOnly:z.boolean()}).refine(value=>value.found===(value.policy!==undefined)),await request(`${api}/policy/requests/${encodeURIComponent(input.requestId)}`,options));},
  async list(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.list'],value);const result=parsed(projectSchema,await request(projectPath(input.projectId),options));if(result.projectId!==input.projectId||result.runs.some(run=>run.projectId!==input.projectId))throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent project mismatch.');return result;},
  async history(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.history'],value);const result=parsed(agentTaskHistoryPageSchema,await request(`${projectPath(input.projectId)}/history${input.cursor?`?cursor=${encodeURIComponent(input.cursor)}`:''}`,options));if(result.conversations.some(conversation=>conversation.projectId!==input.projectId))throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent history project mismatch.');return result;},
  async conversation(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.conversation'],value);const result=parsed(agentTaskConversationPageSchema,await request(`${projectPath(input.projectId)}/conversations/${encodeURIComponent(input.conversationId)}${input.cursor?`?cursor=${encodeURIComponent(input.cursor)}`:''}`,options));if(result.conversation.projectId!==input.projectId||result.conversation.id!==input.conversationId||result.runs.some(run=>run.projectId!==input.projectId||(run.conversationId??run.id)!==input.conversationId||run.diagnostic!==undefined))throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent conversation mismatch.');return result;},
  async status(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(location,value);return validateSnapshot(await request(runPath(input.projectId,input.runId),options),input.projectId,input.runId);},
  async send(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(sendSchema,value),{projectId,...body}=input;const validate=(value:unknown)=>{const snapshot=validateSnapshot(value,projectId);if(snapshot.run.requestId!==body.requestId||body.conversationId!==undefined&&(snapshot.run.conversationId??snapshot.run.id)!==body.conversationId)throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent send request mismatch.');return snapshot;};return validate(await request(projectPath(projectId),{...options,method:'POST',body,validate,recovery:{operation:'task.send',projectId,requestId:body.requestId,lookup:'agent task lookup'}}));},
  async lookup(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.lookup'],value);const result=parsed(requestLookupSchema,await request(`${projectPath(input.projectId)}/requests/${encodeURIComponent(input.requestId)}`,options));if(result.snapshot){validateSnapshot(result.snapshot,input.projectId);if(result.snapshot.run.requestId!==input.requestId)throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent request mismatch.');}return result;},
  async upload(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(uploadInput,value),{projectId,...body}=input;return parsed(uploadSchema,await request(`${projectPath(projectId)}/uploads`,{...options,method:'POST',body,validate:value=>parsed(uploadSchema,value),recovery:{operation:'task.upload',projectId,requestId:body.requestId,lookup:'agent task upload-lookup'}}));},
  async uploadLookup(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.upload-lookup'],value);return parsed(uploadLookupSchema,await request(`${projectPath(input.projectId)}/uploads/requests/${encodeURIComponent(input.requestId)}`,options));},
  async action(command:AgentControlCommand,value:unknown,options:AgentRequestOptions={}){if(!Object.hasOwn(AGENT_CONTROL_COMMANDS,command))return invalid();const {projectId,...input}=parseAgentInput(agentControlCommandInputSchema(command),value);const body=parseAgentInput(agentTaskControlSchema,{...input,action:AGENT_CONTROL_COMMANDS[command]});return validateSnapshot(await request(`${runPath(projectId,input.runId)}/actions`,{...options,method:'POST',body,validate:value=>validateSnapshot(value,projectId,input.runId),recovery:{operation:`task.${command}`,projectId,runId:input.runId,requestId:input.requestId,lookup:'agent task action-lookup'}}),projectId,input.runId);},
  async actionLookup(value:unknown,options:AgentRequestOptions={}){const input=parseAgentInput(AGENT_COMMAND_SCHEMAS['agent.task.action-lookup'],value);const result=parsed(actionLookupSchema,await request(`${runPath(input.projectId,input.runId)}/actions/${encodeURIComponent(input.requestId)}`,options));if(result.snapshot)validateSnapshot(result.snapshot,input.projectId,input.runId);if(result.receipt&&(result.receipt.runId!==input.runId||result.receipt.requestId!==input.requestId))throw new ClientError('BACKEND_PROTOCOL_ERROR','Agent action receipt mismatch.');return result;},
  async watch(value:unknown,{signal,timeoutMs=60000,intervalMs=500,onProgress}:AgentWatchOptions={}):Promise<AgentWatchResult>{
   const input=parseAgentInput(watchInput,value);timeout(timeoutMs);if(!Number.isInteger(intervalMs)||intervalMs<20||intervalMs>60000)return invalid();
   const timer=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timer]):timer;let sequence=input.after??0;
   let latest:AgentTaskSnapshot|undefined;const read=async()=>{const incoming=await client.status({projectId:input.projectId,runId:input.runId},{signal:combined,timeoutMs:Math.min(requestTimeoutMs,timeoutMs)}),snapshot=latest&&latest.run.revision>incoming.run.revision?latest:incoming;latest=snapshot;onProgress?.(snapshot,sequence);return snapshot;};
   try{let snapshot=await read();while(true){const done=outcome(snapshot);if(done)return {outcome:done,sequence,snapshot};
    const connection=await resolveConnection(env);let received=false;
    try{
     const response=await fetchImpl(`${connection.base}${runPath(input.projectId,input.runId)}/events?after=${sequence}`,{headers:{authorization:`Bearer ${connection.token}`,accept:'text/event-stream'},redirect:'error',signal:combined});
     if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream')||!response.body)throw new Error('Disconnected');
     const reader=response.body.getReader();let pending='',frameBytes=0;
     try{const decoder=new TextDecoder('utf-8',{fatal:true});while(true){const part=await reader.read();if(part.done)break;pending=(pending+decoder.decode(part.value,{stream:true})).replaceAll('\r\n','\n');frameBytes+=part.value.length;if(frameBytes>2*1024*1024)throw new Error('Invalid frame');let end:number;
      while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);frameBytes=Buffer.byteLength(pending);const lines=frame.split('\n'),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;const event:unknown=JSON.parse(data),wireId=lines.find(line=>line.startsWith('id:'))?.slice(3).trim(),wireType=lines.find(line=>line.startsWith('event:'))?.slice(6).trim();if(!object(event)||event.type!=='changed'||wireType!=='changed'||event.runId!==input.runId||!Number.isSafeInteger(event.sequence)||Number(event.sequence)<sequence||wireId!==String(event.sequence)||event.id!==undefined&&event.id!==event.sequence)throw new Error('Invalid event');sequence=Number(event.sequence);received=true;snapshot=await read();const next=outcome(snapshot);if(next)return {outcome:next,sequence,snapshot};}
     }}finally{await reader.cancel().catch(()=>{});}
    }catch(error){if(combined.aborted)throw error;}
    // SSE is advisory. A disconnect never resends send/control/upload.
    snapshot=await read();if(!received)await delay(intervalMs,undefined,{signal:combined});
   }}catch(error){if(signal?.aborted)throw new ClientError('INTERRUPTED','Stopped observing locally; the Agent task continues.',{exitCode:EXIT_CODES.interrupted});if(timer.aborted)throw new ClientError('WATCH_TIMEOUT','Stopped observing at the deadline; the Agent task continues.',{exitCode:EXIT_CODES.timeout,details:{projectId:input.projectId,runId:input.runId,after:sequence}});throw error;}
  },
 };
 return client;
}
export type AgentClient=ReturnType<typeof createAgentClient>;
