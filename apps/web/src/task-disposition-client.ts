import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {rpc,ApiError} from './api.ts';
import {isTaskDispositionListResponse,isTaskDispositionMutationResponse,TASK_DISPOSITION_BATCH_LIMIT} from '../../../packages/contracts/src/task-dispositions.ts';
import type {TaskDisposition,TaskDispositionTarget,TaskDispositionCheckedTarget} from '../../../packages/contracts/src/task-dispositions.ts';
export interface TaskDispositionView {
 phase:'idle'|'loading'|'ready'|'error';items:readonly TaskDisposition[];busy:boolean;mutationUncertain:boolean;
 reload():void;markFailed(item:TaskDisposition):Promise<void>;archiveCompleted(items:readonly TaskDisposition[]):Promise<void>;retry():Promise<void>;
}
interface Options {projectId:string;scope:string;enabled:boolean;targets:readonly (TaskDispositionTarget&{status?:string})[];expectedWorkspaceOrigin?:unknown}
type Pending={operation:'task.disposition.markFailed'|'task.disposition.archiveCompleted';input:Record<string,unknown>};
/** No automatic mutation replay: a lost local response keeps the exact caller
 * request until the user explicitly checks it again. Scope changes revoke it. */
export function useTaskDispositions({projectId,scope,enabled,targets,expectedWorkspaceOrigin}:Options):TaskDispositionView {
 const signature=JSON.stringify(targets.map(item=>[item.kind,item.taskId,item.status]));
 const owner=useMemo(()=>({projectId,scope,enabled,signature,expectedWorkspaceOrigin}),[projectId,scope,enabled,signature,expectedWorkspaceOrigin]);
 const current=useRef<typeof owner|null>(owner),flight=useRef<{owner:typeof owner;value:Pending}|null>(null),pending=useRef<{owner:typeof owner;value:Pending}|null>(null);
 const [state,setState]=useState<{owner:typeof owner;phase:TaskDispositionView['phase'];items:TaskDisposition[];busy:boolean;uncertain:boolean}|null>(null),[revision,setRevision]=useState(0);
 const actual=state?.owner===owner?state:null;
 useLayoutEffect(()=>{current.current=owner;pending.current=null;flight.current=null;return()=>{if(current.current===owner)current.current=null;};},[owner]);
 useEffect(()=>{
  const controller=new AbortController();
  if(!enabled||!projectId||!targets.length){setState({owner,phase:enabled?'ready':'idle',items:[],busy:false,uncertain:false});return()=>{controller.abort();};}
  setState({owner,phase:'loading',items:[],busy:false,uncertain:false});
  void(async()=>{try{const items:TaskDisposition[]=[];for(let offset=0;offset<targets.length;offset+=TASK_DISPOSITION_BATCH_LIMIT){const input={projectId,targets:targets.slice(offset,offset+TASK_DISPOSITION_BATCH_LIMIT).map(({kind,taskId})=>({kind,taskId}))},response=await rpc('task.disposition.list',input,{signal:controller.signal,expectedWorkspaceOrigin});if(!isTaskDispositionListResponse(response,input))throw Error('Invalid task disposition response');items.push(...response.items);}if(current.current===owner&&!controller.signal.aborted)setState({owner,phase:'ready',items,busy:false,uncertain:false});}catch{if(current.current===owner&&!controller.signal.aborted)setState({owner,phase:'error',items:[],busy:false,uncertain:false});}})();
  return()=>{controller.abort();};
 },[owner,revision]);
 const send=async(value:Pending)=>{
  if(current.current!==owner||!enabled||flight.current?.owner===owner)return;
  const ticket={owner,value};flight.current=ticket;
  pending.current={owner,value};setState(previous=>previous?.owner===owner?{...previous,busy:true,uncertain:false}:previous);
  try{const response=await rpc(value.operation,value.input,{expectedWorkspaceOrigin});const expected=value.operation==='task.disposition.markFailed'?[value.input as unknown as TaskDispositionCheckedTarget]:value.input.targets as TaskDispositionCheckedTarget[];if(!isTaskDispositionMutationResponse(response)||response.operation!==value.operation||response.projectId!==projectId||response.requestId!==value.input.requestId||response.items.length!==expected.length||response.items.some((item,index)=>item.kind!==expected[index].kind||item.taskId!==expected[index].taskId||item.revision!==expected[index].expectedRevision+1||item.sourceStatus!==expected[index].expectedStatus))throw Error('Invalid task disposition response');if(current.current!==owner)return;pending.current=null;setState(previous=>previous?.owner===owner?{...previous,busy:false,uncertain:false,items:previous.items.map(item=>response.items.find(next=>next.kind===item.kind&&next.taskId===item.taskId)??item)}:previous);}
  catch(error){if(current.current===owner){const definitive=error instanceof ApiError&&error.definitive;if(definitive)pending.current=null;setState(previous=>previous?.owner===owner?{...previous,phase:definitive?'error':previous.phase,busy:false,uncertain:!definitive}:previous);}}
  finally{if(flight.current===ticket)flight.current=null;}
 };
 const checked=(item:TaskDisposition):TaskDispositionCheckedTarget=>({kind:item.kind,taskId:item.taskId,expectedRevision:item.revision,expectedStatus:item.sourceStatus});
 const allowed=()=>current.current===owner&&enabled&&actual?.phase==='ready'&&!actual.busy&&!pending.current;
 return {phase:actual?.phase??(enabled?'loading':'idle'),items:actual?.items??[],busy:actual?.busy??false,mutationUncertain:actual?.uncertain??false,
  reload(){if(current.current===owner&&!actual?.busy&&!pending.current)setRevision(value=>value+1);},
  async markFailed(item){if(allowed()&&item.projectId===projectId&&item.canMarkFailed)await send({operation:'task.disposition.markFailed',input:{projectId,...checked(item),confirm:true,requestId:crypto.randomUUID()}});},
  async archiveCompleted(items){if(allowed()&&items.length&&items.length<=TASK_DISPOSITION_BATCH_LIMIT&&items.every(item=>item.projectId===projectId&&item.canArchive&&!item.archived))await send({operation:'task.disposition.archiveCompleted',input:{projectId,targets:items.map(checked),requestId:crypto.randomUUID()}});},
  async retry(){const saved=pending.current;if(current.current===owner&&!actual?.busy&&saved?.owner===owner)await send(saved.value);},
 };
}
