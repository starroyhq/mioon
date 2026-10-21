import type {IncomingMessage,ServerResponse} from 'node:http';
import {sanitizeAgentSettingsResult} from '@mioon/business/agent/settings';
import type {AgentSettingsService} from '@mioon/business/agent/settings';
import type {ChatAuthorizations} from '@mioon/business/agent/chat-runtime';
import type {AgentTaskTools} from '@mioon/business/agent/task-tools-v2';
import type {AgentTaskPolicy} from '@mioon/contracts/agent-tasks-v2';
import {agentTaskFailure} from '@mioon/business/agent/task-runtime-v2';

const route='/api/agent/diagnostics';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
interface CatalogIssue {code:string;tool?:string;path?:string}
/** Structural diagnostics only: a valid JSON schema may still be rejected by
 * one provider. No credential acquisition, DNS lookup or provider call occurs. */
export function inspectAgentTaskCatalog(tools:Pick<AgentTaskTools,'list'>|undefined){
  const issues:CatalogIssue[]=[],definitions=tools?.list()??[],names=new Set<string>();
  if(!definitions.length)issues.push({code:'TOOL_CATALOG_UNAVAILABLE'});
  for(const tool of definitions){
    const validName=/^[A-Za-z0-9_-]{1,64}$/u.test(tool.name);
    if(!validName||names.has(tool.name))issues.push({code:'TOOL_NAME_INVALID',...(validName?{tool:tool.name}:{})});
    names.add(tool.name);
    try{
      if(!object(tool.parameters)||tool.parameters.type!=='object'||Buffer.byteLength(JSON.stringify(tool.parameters))>512*1024)throw Error();
      const walk=(value:unknown,depth=0):void=>{
        if(depth>128)throw Error();
        if(Array.isArray(value)){for(const child of value)walk(child,depth+1);return;}
        if(object(value)){if(Object.hasOwn(value,'$ref'))throw Error();for(const child of Object.values(value))walk(child,depth+1);return;}
        if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Error();
      };walk(tool.parameters);
    }catch{issues.push({code:'TOOL_SCHEMA_INVALID',...(validName?{tool:tool.name}:{})});}
  }
  return {count:definitions.length,valid:issues.length===0,issues};
}
interface Dependencies {
  settings:Pick<AgentSettingsService,'get'>;authorizations:Pick<ChatAuthorizations,'snapshot'>;
  tools:AgentTaskTools|undefined;policy:()=>AgentTaskPolicy;selfPort:()=>number;hasProject:(id:string)=>boolean;
}
/** Enclosing server enforces loopback Host/Origin and local bearer auth. This
 * management route is deliberately absent from the model and RPC catalogs. */
export function createAgentDiagnosticsHttp(deps:Dependencies){
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!==route)return false;
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.method!=='GET'){res.setHeader('Allow','GET');reply(405,{ok:false,error:{code:'METHOD_NOT_ALLOWED',message:'请使用 GET。',details:{},retryable:false}});return true;}
    try{
      const keys=[...url.searchParams.keys()],projectId=url.searchParams.get('projectId');
      if(keys.length>1||keys.some(key=>key!=='projectId')||projectId!==null&&!/^[a-f0-9-]{36}$/u.test(projectId))throw agentTaskFailure('AGENT_TASK_INVALID');
      if(projectId!==null&&!deps.hasProject(projectId))throw agentTaskFailure('AGENT_TASK_NOT_FOUND');
      const settings=sanitizeAgentSettingsResult(await deps.settings.get({selfPort:deps.selfPort()}));
      reply(200,{ok:true,data:{version:1,settings,policy:deps.policy(),authorization:deps.authorizations.snapshot(settings.configuration),catalog:inspectAgentTaskCatalog(deps.tools),...(projectId!==null?{projectId}:{}),verification:'not_tested'}});
    }catch(error){
      const failure=agentTaskFailure(object(error)&&['AGENT_TASK_INVALID','AGENT_TASK_NOT_FOUND'].includes(String(error.code))?String(error.code):'AGENT_TASK_STORAGE_UNAVAILABLE');
      reply(failure.status,{ok:false,error:{code:failure.code,message:failure.message,details:{},retryable:false}});
    }
    return true;
  };
}
