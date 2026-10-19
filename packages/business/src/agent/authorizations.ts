import {randomUUID,createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import path from 'node:path';
import {calculateWorkspaceScope} from '../../../contracts/src/workspace-scope.ts';
import {deriveAgentEndpoint} from '../../../contracts/src/agent-protocol.ts';
import type {AgentEndpointConfiguration} from '../../../contracts/src/agent-protocol.ts';
import {AGENT_AUTHORIZATION_LIMITS,AGENT_AUTHORIZATION_SCOPES,agentAuthorizationSchemas,
  agentAuthorizationTargetSchema,agentAuthorizationCurrentTargetSchema,agentAuthorizationDiskSchema} from '../../../contracts/src/agent-authorization.ts';
import type {AgentAuthorizationTarget,AgentAuthorizationSnapshot,AgentAuthorizationList,AgentAuthorizationReceipt,AgentAuthorizationDisk} from '../../../contracts/src/agent-authorization.ts';
import type {LocalDraftStorage} from '../local-drafts.ts';

export const AGENT_AUTHORIZATION_FILENAME='agent-authorizations-v1.json';
const messages={
  AGENT_AUTHORIZATION_VALIDATION:[400,'智能助理授权参数无效。'],
  AGENT_AUTHORIZATION_REQUIRED:[403,'此目标、模型或发送范围尚未授权，或授权已撤销。'],
  AGENT_AUTHORIZATION_CONFLICT:[409,'智能助理授权已更新，请重新读取后再操作。'],
  AGENT_AUTHORIZATION_SETTINGS_CONFLICT:[409,'智能助理连接已改变，请核对当前目标和模型。'],
  AGENT_AUTHORIZATION_IDEMPOTENCY_CONFLICT:[409,'此授权请求标识已用于不同操作。'],
  AGENT_AUTHORIZATION_NOT_FOUND:[404,'此智能助理授权不存在。'],
  AGENT_AUTHORIZATION_UNAVAILABLE:[503,'无法安全读取或保存智能助理授权，已有记录已保留。'],
  AGENT_AUTHORIZATION_LIMIT:[507,'智能助理授权记录容量已满，已有记录已保留。'],
  AGENT_AUTHORIZATION_RESTORED:[409,'恢复工作区不支持智能助理授权。'],
} as const;
type ErrorCode=keyof typeof messages;
export class AgentAuthorizationError extends Error{
  readonly code:ErrorCode;readonly status:number;
  constructor(code:ErrorCode){super(messages[code][1]);this.code=code;this.status=messages[code][0];}
}
function fail(code:ErrorCode):never{throw new AgentAuthorizationError(code);}
type Disk=AgentAuthorizationDisk;
interface Options{
  root:string;channel?:'web'|'production'|'development';storage:LocalDraftStorage;
  guards:{ownsLock():boolean;isRestored():boolean};readCurrentTarget():Promise<unknown>;
  signal?:AbortSignal;
}
export interface AgentAuthorizations{
  list(input?:unknown):Promise<AgentAuthorizationList>;
  grant(input:unknown):Promise<AgentAuthorizationReceipt>;
  revoke(input:unknown):Promise<AgentAuthorizationReceipt>;
  assertAuthorized(input:unknown):void;
  snapshot(configuration:AgentEndpointConfiguration&{model:string}):AgentAuthorizationSnapshot;
}
function plain(value:unknown):void{
  if(value===null||typeof value!=='object'||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('AGENT_AUTHORIZATION_VALIDATION');
  for(const key of Reflect.ownKeys(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!descriptor?.enumerable||!Object.hasOwn(descriptor,'value')||!['string','number'].includes(typeof descriptor.value))fail('AGENT_AUTHORIZATION_VALIDATION');
  }
}
function parse<T>(schema:{safeParse(value:unknown):{success:true;data:T}|{success:false}},value:unknown):T{
  plain(value);const parsed=schema.safeParse(value);if(!parsed.success)fail('AGENT_AUTHORIZATION_VALIDATION');return parsed.data;
}
const identity=(value:AgentAuthorizationTarget):string=>JSON.stringify([value.destination,value.model,value.scope]);
const digest=(operation:string,input:unknown):string=>createHash('sha256').update(JSON.stringify([operation,input])).digest('hex');
/** Separate, private workspace companion. It holds only target metadata and
 * exact authorization receipts, never messages, project text or credentials. */
export function createAgentAuthorizations({root,channel='web',storage,guards,readCurrentTarget,signal}:Options):AgentAuthorizations{
  if(!path.isAbsolute(root)||!['web','production','development'].includes(channel))fail('AGENT_AUTHORIZATION_VALIDATION');
  const file=path.join(root,AGENT_AUTHORIZATION_FILENAME);let scope:string|undefined,tail:Promise<unknown>=Promise.resolve();
  function owned():void{
    if(signal?.aborted||!guards.ownsLock())fail('AGENT_AUTHORIZATION_UNAVAILABLE');
    if(guards.isRestored())fail('AGENT_AUTHORIZATION_RESTORED');
  }
  function boundary():string{
    owned();
    const directory=storage.validatePrivateDirectory(root),db=storage.validateManagedFile(path.join(root,'workbench.sqlite'),{root});
    if(!directory||!db)fail('AGENT_AUTHORIZATION_UNAVAILABLE');
    const current=calculateWorkspaceScope({channel,root,directory,db});
    if(scope!==undefined&&scope!==current)fail('AGENT_AUTHORIZATION_UNAVAILABLE');scope=current;owned();return current;
  }
  function guarded<T>(work:()=>T):T{
    try{return work();}catch(error){if(error instanceof AgentAuthorizationError)throw error;return fail('AGENT_AUTHORIZATION_UNAVAILABLE');}
  }
  function read():Disk{
    return guarded(()=>{
      const workspaceScope=boundary(),bytes=storage.readPrivateFile(file,{root,private:true,allowMissing:true,maxBytes:AGENT_AUTHORIZATION_LIMITS.fileBytes});
      if(bytes===null)return {version:1,workspaceScope,revision:0,authorizations:[],requests:[]};
      if(!Buffer.isBuffer(bytes)||bytes.length>AGENT_AUTHORIZATION_LIMITS.fileBytes)fail('AGENT_AUTHORIZATION_UNAVAILABLE');
      const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      const result=agentAuthorizationDiskSchema.safeParse(value);if(!result.success||result.data.workspaceScope!==workspaceScope)fail('AGENT_AUTHORIZATION_UNAVAILABLE');
      const disk=result.data,ids=new Set(disk.authorizations.map(row=>row.id)),keys=new Set(disk.authorizations.map(identity));
      if(ids.size!==disk.authorizations.length||keys.size!==disk.authorizations.length||
        new Set(disk.requests.map(row=>row.requestId)).size!==disk.requests.length||
        disk.requests.length!==disk.revision||disk.requests.some((row,index)=>row.receipt.revision!==index+1||row.receipt.requestId!==row.requestId))fail('AGENT_AUTHORIZATION_UNAVAILABLE');
      boundary();return disk;
    });
  }
  function persist(disk:Disk):void{
    guarded(()=>{
      if(disk.workspaceScope!==boundary())fail('AGENT_AUTHORIZATION_UNAVAILABLE');
      const bytes=JSON.stringify(disk)+'\n';if(Buffer.byteLength(bytes)>AGENT_AUTHORIZATION_LIMITS.fileBytes)fail('AGENT_AUTHORIZATION_LIMIT');
      storage.writePrivateFileAtomic(file,bytes,{root,private:true,maxBytes:AGENT_AUTHORIZATION_LIMITS.fileBytes});boundary();
    });
  }
  async function current():Promise<AgentAuthorizationList['currentTarget']>{
    try{
      owned();const result=agentAuthorizationCurrentTargetSchema.safeParse(await readCurrentTarget());owned();
      if(!result.success)fail('AGENT_AUTHORIZATION_UNAVAILABLE');return result.data;
    }catch(error){if(error instanceof AgentAuthorizationError)throw error;return fail('AGENT_AUTHORIZATION_UNAVAILABLE');}
  }
  function schedule<T>(work:()=>Promise<T>):Promise<T>{
    const result=tail.then(work);tail=result.catch(()=>{});return result;
  }
  function replay(disk:Disk,requestId:string,hash:string):AgentAuthorizationReceipt|undefined{
    const previous=disk.requests.find(row=>row.requestId===requestId);
    if(previous&&previous.digest!==hash)fail('AGENT_AUTHORIZATION_IDEMPOTENCY_CONFLICT');return previous?.receipt;
  }
  function mutation(disk:Disk,expectedRevision:number):void{
    if(disk.revision!==expectedRevision)fail('AGENT_AUTHORIZATION_CONFLICT');
    if(disk.requests.length>=AGENT_AUTHORIZATION_LIMITS.requests||disk.revision===Number.MAX_SAFE_INTEGER)fail('AGENT_AUTHORIZATION_LIMIT');
  }
  const service:AgentAuthorizations={
    async list(input={}){
      parse(agentAuthorizationSchemas['agent.authorization.list'],input);
      const currentTarget=await current(),disk=read();
      return {revision:disk.revision,currentTarget,authorizations:structuredClone(disk.authorizations)};
    },
    grant(value){
      const input=parse(agentAuthorizationSchemas['agent.authorization.grant'],value),hash=digest('grant',input);
      return schedule(async()=>{
        const target=await current(),disk=read(),previous=replay(disk,input.requestId,hash);if(previous)return structuredClone(previous);
        mutation(disk,input.expectedRevision);
        if(target.settingsRevision!==input.expectedSettingsRevision||target.destination!==input.destination||target.model!==input.model)fail('AGENT_AUTHORIZATION_SETTINGS_CONFLICT');
        let grant=disk.authorizations.find(row=>identity(row)===identity(input));
        if(!grant){
          if(disk.authorizations.length>=AGENT_AUTHORIZATION_LIMITS.grants)fail('AGENT_AUTHORIZATION_LIMIT');
          grant={id:randomUUID(),destination:input.destination,model:input.model,scope:input.scope,createdAt:new Date().toISOString()};disk.authorizations.push(grant);
        }
        const receipt:AgentAuthorizationReceipt={operation:'grant',requestId:input.requestId,revision:++disk.revision,authorizationId:grant.id};
        disk.requests.push({requestId:input.requestId,digest:hash,receipt});persist(disk);return structuredClone(receipt);
      });
    },
    revoke(value){
      const input=parse(agentAuthorizationSchemas['agent.authorization.revoke'],value),hash=digest('revoke',input);
      return schedule(async()=>{
        const disk=read(),previous=replay(disk,input.requestId,hash);if(previous)return structuredClone(previous);
        mutation(disk,input.expectedRevision);
        if(!disk.authorizations.some(row=>row.id===input.authorizationId))fail('AGENT_AUTHORIZATION_NOT_FOUND');
        disk.authorizations=disk.authorizations.filter(row=>row.id!==input.authorizationId);
        const receipt:AgentAuthorizationReceipt={operation:'revoke',requestId:input.requestId,revision:++disk.revision,authorizationId:input.authorizationId};
        disk.requests.push({requestId:input.requestId,digest:hash,receipt});persist(disk);return structuredClone(receipt);
      });
    },
    assertAuthorized(value){
      const target=parse(agentAuthorizationTargetSchema,value);
      if(!read().authorizations.some(row=>identity(row)===identity(target)))fail('AGENT_AUTHORIZATION_REQUIRED');
    },
    snapshot(configuration){
      const destination=deriveAgentEndpoint(configuration),disk=read();
      return {revision:disk.revision,scopes:AGENT_AUTHORIZATION_SCOPES.filter(scope=>disk.authorizations.some(row=>identity(row)===identity({destination,model:configuration.model,scope})))};
    },
  };
  return Object.freeze(service);
}
