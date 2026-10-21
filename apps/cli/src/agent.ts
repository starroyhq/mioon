import {open} from 'node:fs/promises';
import path from 'node:path';
import {ClientError,EXIT_CODES} from '@mioon/client';
import {createAgentClient,AGENT_COMMAND_SCHEMAS,AGENT_CONTROL_COMMANDS,agentControlInputSchema,parseAgentInput,agentInputSchema} from '@mioon/client/agent';
import type {AgentControlCommand} from '@mioon/client/agent';
import {readAgentKey} from './agent-key.ts';

type Options=Record<string,string|true>;
const generic=new Set(['help','version','json','locale','input','input-file','request-id']);
export const isAgentCommand=(words:readonly string[]):boolean=>words[0]==='agent'&&words[1]!=='authorization';
export const canonicalAgentOperation=(operation:string):string=>operation==='agent.secret.set'?'agent.settings.secret.set':operation==='agent.secret.remove'?'agent.settings.secret.remove':operation;
const fail=(message='Invalid Agent command arguments. Run agent --help.'):never=>{throw new ClientError('VALIDATION_ERROR',message);};
const selected=(source:string)=>{const operation=canonicalAgentOperation(source);return operation==='agent.task.send'?AGENT_COMMAND_SCHEMAS[operation].omit({diagnostic:true}):Object.hasOwn(AGENT_COMMAND_SCHEMAS,operation)?AGENT_COMMAND_SCHEMAS[operation as keyof typeof AGENT_COMMAND_SCHEMAS]:operation.startsWith('agent.task.')&&Object.hasOwn(AGENT_CONTROL_COMMANDS,operation.slice('agent.task.'.length))?agentControlInputSchema:undefined;};
export function validateAgentOptions(operation:string,options:Options):void{
 operation=canonicalAgentOperation(operation);const secret=operation==='agent.settings.secret.set',watch=['agent.task.watch','agent.task.events'].includes(operation),upload=operation==='agent.task.upload',diagnose=operation==='agent.diagnose';
 if(Object.hasOwn(options,'workspace-origin'))fail('Agent management commands do not support --workspace-origin; it is not an HTTP Origin override.');
 for(const name of Object.keys(options))if(!generic.has(name)&&!(secret&&['key-stdin','key-file','storage'].includes(name))&&!(watch&&['timeout-ms','interval-ms'].includes(name))&&!(upload&&name==='file')&&!(diagnose&&name==='live'))fail('This option is not supported by the selected Agent command.');
 if(secret&&(options['key-stdin']&&options['key-file']||options['key-stdin']&&options.input==='-'))fail('Key input sources are exclusive; --key-stdin cannot share stdin with --input -.');
 if(secret&&options.storage!==undefined&&!['session','persistent'].includes(String(options.storage)))fail('Secret storage must be persistent or session.');
 if(diagnose&&!options.live&&!options.help&&!options.version)fail('Live diagnosis may send model requests. Supply --live explicitly with the retained requestId and current settings revision.');
}
export function agentCommandHelp(operation?:string):unknown{
 operation=operation?canonicalAgentOperation(operation):operation;
 const schema=operation?selected(operation):undefined;
 if(operation&&!['agent','agent.task','agent.settings','agent.settings.secret','agent.secret','agent.policy'].includes(operation)&&!schema)throw new ClientError('UNKNOWN_OPERATION','Unknown Agent management command.');
 return {name:'mioon agent',usage:'mioon agent <command words> --input <JSON>',commands:[...Object.keys(AGENT_COMMAND_SCHEMAS),...Object.keys(AGENT_CONTROL_COMMANDS).map(action=>`agent.task.${action}`)],...(schema?{operation,inputSchema:agentInputSchema(schema)}:{}),options:{'--input':'Strict JSON metadata; never include a key. Use - for JSON stdin.','--input-file':'Explicit JSON file, exclusive with --input.','--request-id':'Caller-owned stable ID for task, upload, control and policy writes.','--key-stdin':'agent settings secret set only; exclusive raw key input, never combined with --input -.','--key-file':'agent settings secret set only; owner-only regular file in a private directory.','--storage':'agent settings secret set only: persistent (default) or explicit session.','--file':'agent task upload only; explicit local media/Cube file.','--timeout-ms':'Agent watch/events deadline, 1–86400000 ms, default 60000.','--interval-ms':'Reconnect delay after SSE loss, 20–60000 ms, default 500.','--live':'agent diagnose only; explicitly authorize one diagnostic task under the existing step budget.'},output:'One JSON envelope on stdout; task snapshots/progress on stderr.',safety:'Management commands are not model or MCP tools. No automatic approvals, retries, budget continuation or unknown-result resolution. On lost write response query the original receipt; settings has no receipt and must only be read back. Ctrl+C stops local observation only.'};
}
function rawSecretFields(value:unknown):boolean{
 if(Array.isArray(value))return value.some(rawSecretFields);if(!value||typeof value!=='object')return false;
 return Object.entries(value).some(([key,item])=>/^(?:api_?key|key|secret|token|authorization|cookie|password|credential)$/iu.test(key)||rawSecretFields(item));
}
function number(value:string|true|undefined,fallback:number):number{if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d+$/u.test(value)||!Number.isSafeInteger(Number(value)))return fail();return Number(value);}
async function uploadFile(input:Record<string,unknown>,file:string):Promise<Record<string,unknown>>{
 if(input.dataBase64!==undefined)return fail('Use --file for upload; do not put media bytes in command arguments.');
 let handle:Awaited<ReturnType<typeof open>>|undefined;
 try{handle=await open(file,'r');const info=await handle.stat(),limit=/\.cube$/iu.test(file)?7*1024*1024:30*1024*1024;if(!info.isFile()||info.size>limit)throw new ClientError('FILE_TOO_LARGE','Upload must be a bounded regular file (media 30 MiB; Cube 7 MiB).');const bytes=await handle.readFile();if(bytes.length>limit)throw new ClientError('FILE_TOO_LARGE','Upload exceeds its safe size limit.');
  const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.cube':'application/x-cube'};
  return {...input,name:input.name??path.basename(file),mimeType:input.mimeType??mime[path.extname(file).toLowerCase()],dataBase64:bytes.toString('base64')};
 }catch(error){if(error instanceof ClientError)throw error;throw new ClientError('FILE_READ_ERROR','Cannot read the explicitly selected upload file.');}finally{await handle?.close();}
}
export async function runAgentCommand(operation:string,input:Record<string,unknown>,options:Options,{signal,redact,progress=(value:unknown)=>process.stderr.write(JSON.stringify(value)+'\n')}:{signal?:AbortSignal;redact:(value:string)=>void;progress?:(value:unknown)=>void}):Promise<unknown>{
 operation=canonicalAgentOperation(operation);
 validateAgentOptions(operation,options);if(!selected(operation))throw new ClientError('UNKNOWN_OPERATION','Unknown Agent management command.');
 if(rawSecretFields(input))fail('Keys and credentials are not accepted in JSON metadata. Use agent settings secret set with a secure input source.');
 if(operation==='agent.task.send'&&Object.hasOwn(input,'diagnostic'))fail('Use agent diagnose --live for diagnostic tasks; agent task send accepts ordinary tasks only.');
 const client=createAgentClient(),request={signal};
 if(operation==='agent.settings.secret.set'){
  const metadata=parseAgentInput(AGENT_COMMAND_SCHEMAS[operation],input),storage=options.storage==='session'?'session':'persistent';
  const current=await client.settingsGet(request);if(current.revision!==metadata.expectedRevision)throw new ClientError('AGENT_SETTINGS_CONFLICT','Settings changed; read the current settings before entering a key.',{status:409});
  if(storage==='persistent'&&!current.storage.persistentAvailable)throw new ClientError('AGENT_SETTINGS_STORAGE_UNAVAILABLE','Persistent storage is unavailable. Explicitly choose session storage if intended.',{status:409});
  const key=await readAgentKey({keyStdin:options['key-stdin']===true,keyFile:typeof options['key-file']==='string'?options['key-file']:undefined,signal,redact});
  return client.settingsPut(metadata,{action:'replace',storage,value:key},request);
 }
 if(operation==='agent.task.upload'){
  const file=options.file;if(typeof file!=='string')return fail('Agent task upload requires an explicitly selected --file.');
  parseAgentInput(AGENT_COMMAND_SCHEMAS[operation],input);
  return client.upload(await uploadFile(input,file),request);
 }
 if(operation.startsWith('agent.task.')&&Object.hasOwn(AGENT_CONTROL_COMMANDS,operation.slice('agent.task.'.length)))return client.action(operation.slice('agent.task.'.length) as AgentControlCommand,input,request);
 switch(operation){
  case 'agent.settings.get':parseAgentInput(AGENT_COMMAND_SCHEMAS[operation],input);return client.settingsGet(request);
  case 'agent.settings.set':return client.settingsPut(input,{action:'keep'},request);
  case 'agent.settings.secret.remove':return client.settingsPut(input,{action:'remove'},request);
  case 'agent.doctor':return client.doctor(input,request);
  case 'agent.diagnose':parseAgentInput(AGENT_COMMAND_SCHEMAS[operation],input);return client.send(input,request);
  case 'agent.policy.get':parseAgentInput(AGENT_COMMAND_SCHEMAS[operation],input);return client.policyGet(request);
  case 'agent.policy.set':return client.policySet(input,request);
  case 'agent.policy.lookup':return client.policyLookup(input,request);
  case 'agent.task.list':return client.list(input,request);
  case 'agent.task.history':return client.history(input,request);
  case 'agent.task.status':return client.status(input,request);
  case 'agent.task.send':return client.send(input,request);
  case 'agent.task.lookup':return client.lookup(input,request);
  case 'agent.task.upload-lookup':return client.uploadLookup(input,request);
  case 'agent.task.action-lookup':return client.actionLookup(input,request);
  case 'agent.task.events':case 'agent.task.watch':{
   const result=await client.watch(input,{signal,timeoutMs:number(options['timeout-ms'],60000),intervalMs:number(options['interval-ms'],500),onProgress:(snapshot,sequence)=>progress({type:'agent_snapshot',sequence,snapshot})});
   if(result.outcome==='action_needed')process.exitCode=EXIT_CODES.conflict;else if(['failed','stopped'].includes(result.outcome))process.exitCode=EXIT_CODES.operationFailed;return result;
  }
  default:throw new ClientError('UNKNOWN_OPERATION','Unknown Agent management command.');
 }
}
