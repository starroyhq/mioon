import type {AgentModelListResult} from '../../../packages/contracts/src/agent-model-list.ts';

type Observation=Extract<AgentModelListResult,{outcome:'success'}>;
export interface AgentModelListRow {id:string;displayName?:string;adapted:boolean;manual:boolean;current:boolean;pending:boolean;missing:boolean}
/** The settings list retains models the user added and the current selections.
 * An observation supplies metadata and completeness, and is shown in full in the picker. */
export function agentModelListRows({observation,adaptedIds,manualIds,currentId,draftId,custom=false,showMissing=true}:{observation?:Observation|null;adaptedIds:readonly string[];manualIds:readonly string[];currentId?:string|null;draftId?:string|null;custom?:boolean;showMissing?:boolean}):AgentModelListRow[]{
 const remote=new Map(observation?.models.map(model=>[model.id,model])??[]),manual=new Set(manualIds),adapted=new Set(custom?[]:adaptedIds);
 const ids=[...new Set([...(currentId?[currentId]:[]),...adapted,...manualIds,...(draftId?[draftId]:[])])];
 return ids.map(id=>({
  id,...(remote.get(id)?.displayName?{displayName:remote.get(id)!.displayName}:{}),adapted:adapted.has(id),manual:manual.has(id),current:id===currentId,pending:id===draftId&&id!==currentId,
  missing:Boolean(showMissing&&id===currentId&&observation?.complete&&!remote.has(id)),
 }));
}
