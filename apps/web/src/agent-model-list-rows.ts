import type {AgentModelListResult} from '../../../packages/contracts/src/agent-model-list.ts';

type Observation=Extract<AgentModelListResult,{outcome:'success'}>;
export interface AgentModelListRow {id:string;displayName?:string;adapted:boolean;manual:boolean;current:boolean;pending:boolean;missing:boolean}
/** A provider observation never chooses a model or changes the manual list.
 * Adaptation is recomputed from this service/protocol's static catalog. */
export function agentModelListRows({observation,adaptedIds,manualIds,currentId,draftId,custom=false,showMissing=true,hasCompleteList=observation?.complete===true}:{observation?:Observation|null;adaptedIds:readonly string[];manualIds:readonly string[];currentId?:string|null;draftId?:string|null;custom?:boolean;showMissing?:boolean;hasCompleteList?:boolean}):AgentModelListRow[]{
 const remote=new Map(observation?.models.map(model=>[model.id,model])??[]),manual=new Set(manualIds),adapted=new Set(custom?[]:adaptedIds);
 // A retained observation may outlive a failed or pending refresh. The caller
 // decides whether a complete list is currently available for this selection.
 const ids=[...new Set([...(currentId?[currentId]:[]),...remote.keys(),...(!hasCompleteList?adapted:[]),...manualIds,...(draftId?[draftId]:[])])];
 const rank=(id:string)=>id===currentId?0:adapted.has(id)?1:remote.has(id)?2:manual.has(id)?3:4;
 return ids.map((id,index)=>({id,index})).sort((a,b)=>rank(a.id)-rank(b.id)||a.index-b.index).map(({id})=>({
  id,...(remote.get(id)?.displayName?{displayName:remote.get(id)!.displayName}:{}),adapted:adapted.has(id),manual:manual.has(id),current:id===currentId,pending:id===draftId&&id!==currentId,
  missing:Boolean(showMissing&&id===currentId&&observation?.complete&&!remote.has(id)),
 }));
}
