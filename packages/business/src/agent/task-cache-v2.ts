import type {AgentConfiguration} from './config.ts';
import {AGENT_TASK_TOOL_GROUP_IDS,agentTaskToolGroupForName} from './task-tool-groups-v2.ts';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const ephemeral=Object.freeze({type:'ephemeral'});
const groupOrder=new Map<string,number>(AGENT_TASK_TOOL_GROUP_IDS.map((group,index)=>[group,index]));
const withoutCache=(value:Record<string,unknown>):Record<string,unknown>=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='cache_control'));
const block=(value:unknown):unknown=>object(value)?withoutCache(value):value;
const cacheable=(value:unknown):value is Record<string,unknown>=>object(value)&&['text','tool_use','tool_result'].includes(String(value.type));
function lastIndex<T>(items:readonly T[],predicate:(item:T)=>boolean):number{
  for(let index=items.length-1;index>=0;index--)if(predicate(items[index]!))return index;
  return -1;
}
function officialEndpoint(baseUrl:string):boolean{
  try{const url=new URL(baseUrl);return url.origin==='https://api.anthropic.com'&&['','/'].includes(url.pathname);}catch{return false;}
}

/** Cache metadata is request construction policy. Restoring a frozen intent
 * must use its saved body directly, without running this policy again. Only
 * documented protocol metadata positions are touched; schemas and tool data
 * may themselves contain a business field called cache_control. */
export function applyTaskAnthropicCaching(configuration:AgentConfiguration,body:Record<string,unknown>):Record<string,unknown>{
  if(configuration.protocol!=='anthropic_messages'||configuration.presetId!=='anthropic'||!officialEndpoint(configuration.baseUrl))return body;
  const result=withoutCache(body);
  if(Array.isArray(body.tools)){
    const tools=body.tools.map(block).map((value,index)=>({value,index,group:object(value)&&typeof value.name==='string'?agentTaskToolGroupForName(value.name):undefined}));
    tools.sort((a,b)=>(groupOrder.get(a.group??'')??AGENT_TASK_TOOL_GROUP_IDS.length)-(groupOrder.get(b.group??'')??AGENT_TASK_TOOL_GROUP_IDS.length)||a.index-b.index);
    const coreEnd=lastIndex(tools,tool=>tool.group==='core');
    // An extra core boundary preserves the candidate core prefix when loaded
    // groups are appended. Backend cache eligibility still needs measurement.
    for(const index of new Set([coreEnd,tools.length-1]))if(index>=0&&object(tools[index]!.value))tools[index]!.value={...tools[index]!.value,cache_control:ephemeral};
    result.tools=tools.map(tool=>tool.value);
  }
  if(typeof body.system==='string'){
    if(body.system)result.system=[{type:'text',text:body.system,cache_control:ephemeral}];
  }else if(Array.isArray(body.system)){
    const system=body.system.map(block),index=lastIndex(system,item=>object(item)&&item.type==='text');
    if(index>=0)system[index]={...system[index] as Record<string,unknown>,cache_control:ephemeral};
    result.system=system;
  }
  if(Array.isArray(body.messages)){
    const messages=body.messages.map(message=>object(message)?{...message,...(Array.isArray(message.content)?{content:message.content.map(block)}:{})}:message);
    // The terminal block grows with each turn. Earlier written boundaries can
    // be reused by Anthropic's lookback only while the earlier prefix survives
    // compaction/overview changes and remains within the provider's window.
    const last=messages.at(-1);
    if(object(last)){
      if(typeof last.content==='string'&&last.content)last.content=[{type:'text',text:last.content,cache_control:ephemeral}];
      else if(Array.isArray(last.content)){
        const content=last.content,index=lastIndex(content,cacheable);
        if(index>=0)content[index]={...content[index] as Record<string,unknown>,cache_control:ephemeral};
      }
    }
    result.messages=messages;
  }
  return result;
}
