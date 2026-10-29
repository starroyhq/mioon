import type {AgentTaskJson} from '@mioon/contracts/agent-tasks-v2';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const historyType='mio.context.history-round';
const overviewType='mio.context.project-overview';
const message=(value:unknown):value is AgentTaskJson=>object(value)&&['user','assistant'].includes(String(value.role))&&typeof value.content==='string';
const exactKeys=(value:Record<string,unknown>,second:string):boolean=>Object.keys(value).length===2&&Object.hasOwn(value,'type')&&Object.hasOwn(value,second);

/** Private structure inside the existing free-JSON run.context. Group identity
 * is host-owned, never inferred from a user's text resembling a host notice.
 * These wrappers are expanded before constructing any provider request. */
export function taskContextHistoryRound(messages:AgentTaskJson[]):AgentTaskJson {
  if(messages.length<2||!messages.every(message))throw new TypeError('Invalid historical context round.');
  return {type:historyType,messages};
}
export function taskContextProjectOverview(value:AgentTaskJson):AgentTaskJson {
  if(!message(value)||!object(value)||value.role!=='user')throw new TypeError('Invalid project overview.');
  return {type:overviewType,message:value};
}

export interface TaskBaseContextParts {before:AgentTaskJson[];past:AgentTaskJson[][];current:AgentTaskJson[]}

/** Recognize H1d's explicit groups; keep H1a/legacy flat contexts readable.
 * Unknown legacy ownership stays pinned rather than guessing a cutoff. */
export function taskBaseContextParts(context:readonly AgentTaskJson[]):TaskBaseContextParts {
  if(!context.length)return {before:[],past:[],current:[]};
  const last=context.at(-1);
  if(!object(last)||last.role!=='user'||typeof last.content!=='string')return {before:[...context],past:[],current:[]};
  let first=0;const before:AgentTaskJson[]=[];
  if(object(context[0])&&context[0].role==='system'){before.push(context[0]);first=1;}
  const middle=context.slice(first,-1),past:AgentTaskJson[][]=[],overview:AgentTaskJson[]=[];
  if(middle.some(item=>object(item)&&[historyType,overviewType].includes(String(item.type)))){
    for(const item of middle){
      if(!object(item))throw new TypeError('Invalid structured base context.');
      if(item.type===historyType&&exactKeys(item,'messages')&&Array.isArray(item.messages)&&item.messages.length>=2&&item.messages.every(message)&&!overview.length){
        past.push([...item.messages]);
      }else if(item.type===overviewType&&exactKeys(item,'message')&&message(item.message)&&object(item.message)&&item.message.role==='user'&&!overview.length){
        overview.push(item.message);
      }else throw new TypeError('Invalid structured base context.');
    }
    return {before,past,current:[...overview,last]};
  }
  const group:AgentTaskJson[]=[];
  for(const item of middle){
    if(!message(item))return {before:[...context],past:[],current:[]};
    group.push(item);
    if(object(item)&&item.role==='assistant'){past.push([...group]);group.length=0;}
  }
  if(group.length)return {before:[...context],past:[],current:[]};
  return {before,past,current:[last]};
}

/** Measure/model-project a base without performing any history compaction. */
export function taskBaseModelHistory(context:readonly AgentTaskJson[]):AgentTaskJson[] {
  const {before,past,current}=taskBaseContextParts(context);return [...before,...past.flat(),...current];
}
