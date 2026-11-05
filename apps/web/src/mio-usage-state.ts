import {mioRunUsageSchema} from '../../../packages/contracts/src/mio-run-usage.ts';
import type {MioRunUsage} from '../../../packages/contracts/src/mio-run-usage.ts';
import {projectIdSchema} from '../../../packages/contracts/src/project-file.ts';
import type {MioUsageClient} from './mio-usage-client.ts';

export interface MioUsageOwner {readonly scope:string; readonly projectId:string; readonly instanceId:string; readonly selectionKey:string; readonly visible:boolean}
export interface MioUsageRound {readonly runId:string; readonly revision:number; readonly terminal:boolean}
export interface MioUsageObservation {readonly runId:string; readonly serial:number; readonly sequence?:number}
export interface MioUsageView {readonly phase:'loading'|'ready'|'error'; readonly value:MioRunUsage|null; readonly stale:boolean; readonly code:string|null; readonly final:boolean}
export interface MioUsageState {readonly rounds:Readonly<Record<string,MioUsageView>>; readonly detailRunId:string|null; readonly revision:number}
export const EMPTY_MIO_USAGE_STATE: MioUsageState = Object.freeze({rounds:Object.freeze({}), detailRunId:null, revision:0});
interface Entry {meta:MioUsageRound; view:MioUsageView; wanted:number; attempted:number; finalRequired:number; finalSatisfied:number; serial:number; sequence:number; flight:AbortController|null}
const validRevision = (value:number) => Number.isSafeInteger(value) && value > 0;

/** Per-visible-selection memory only. A failed attempt consumes its ticket;
 * only a new observation/explicit retry can request more work. */
export function createMioUsageController({client,onChange=()=>{},concurrency=4}: {readonly client:MioUsageClient; readonly onChange?:(value:MioUsageState)=>void; readonly concurrency?:number}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new TypeError('Invalid usage read concurrency');
  let owner:MioUsageOwner|null=null,key='',generation=0,active=0,scheduled=false,disposed=false,revision=0,detailRunId:string|null=null;
  const entries=new Map<string,Entry>();
  const publish=() => {if(disposed)return;const rounds:Record<string,MioUsageView>={};for(const[id,item]of entries)rounds[id]=item.view;onChange({rounds,detailRunId,revision:++revision});};
  const mark=(entry:Entry) => {entry.wanted++;if(entry.meta.terminal)entry.finalRequired=entry.wanted;entry.view={...entry.view,stale:entry.view.value!==null,final:false};};
  const schedule=()=>{if(scheduled||disposed||!owner?.visible)return;scheduled=true;queueMicrotask(()=>{scheduled=false;pump();});};
  function pump(){
    if(disposed||!owner?.visible)return;
    for(const[id,item]of entries){
      if(active>=concurrency)break;
      if(item.flight||item.wanted<=item.attempted||!projectIdSchema.safeParse(id).success||!validRevision(item.meta.revision))continue;
      const controller=new AbortController(),epoch=generation,ticket=item.wanted,minimum=item.meta.revision,projectId=owner.projectId;
      item.attempted=ticket;item.flight=controller;active++;item.view={...item.view,phase:'loading',code:null,stale:item.view.value!==null,final:false};publish();
      const current=()=>!disposed&&generation===epoch&&owner?.visible&&entries.get(id)===item&&item.flight===controller&&!controller.signal.aborted;
      void Promise.resolve().then(()=>client.read(projectId,id,{signal:controller.signal})).then(value=>{
        if(!current())return;
        const parsed=mioRunUsageSchema.safeParse(value);
        if(!parsed.success||parsed.data.runId!==id)throw new Error('BACKEND_PROTOCOL_ERROR');
        if(parsed.data.revision<minimum||parsed.data.revision<item.meta.revision||parsed.data.revision<(item.view.value?.revision??0))throw new Error('USAGE_STALE');
        if(item.meta.terminal&&item.finalRequired<=ticket&&item.wanted===ticket)item.finalSatisfied=ticket;
        item.view={phase:'ready',value:parsed.data,stale:item.wanted>ticket,code:null,final:item.meta.terminal&&item.finalSatisfied>=item.finalRequired&&item.wanted===ticket};publish();
      }).catch(error=>{
        if(!current())return;
        const code=error instanceof Error&&['BACKEND_PROTOCOL_ERROR','USAGE_STALE'].includes(error.message)?error.message:error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z_]{1,80}$/u.test(error.code)?error.code:'BACKEND_UNAVAILABLE';
        item.view={...item.view,phase:'error',stale:item.view.value!==null,code,final:false};publish();
      }).finally(()=>{if(generation!==epoch||entries.get(id)!==item||item.flight!==controller)return;item.flight=null;active--;schedule();});
    }
  }
  return {
    get epoch(){return generation;},
    sync(next:MioUsageOwner|null,rounds:readonly MioUsageRound[]){
      if(disposed)return;
      const nextKey=next?JSON.stringify([next.scope,next.projectId,next.instanceId,next.selectionKey,next.visible]):'';
      if(nextKey!==key){generation++;for(const item of entries.values())item.flight?.abort();entries.clear();active=0;key=nextKey;owner=next?{...next}:null;detailRunId=null;publish();}
      if(!owner?.visible)return;
      let changed=false;
      const present=new Set(rounds.map(item=>item.runId));
      for(const[id,item]of entries)if(!present.has(id)){item.flight?.abort();if(item.flight)active--;entries.delete(id);if(detailRunId===id)detailRunId=null;changed=true;}
      for(const meta of rounds){
        const old=entries.get(meta.runId);
        if(!old){
          const valid=projectIdSchema.safeParse(meta.runId).success&&validRevision(meta.revision);
          const item:Entry={meta:{...meta},view:{phase:valid?'loading':'error',value:null,stale:false,code:valid?null:'UNAVAILABLE',final:false},wanted:0,attempted:0,finalRequired:0,finalSatisfied:0,serial:0,sequence:0,flight:null};
          entries.set(meta.runId,item);if(valid)mark(item);changed=true;
        }else if(meta.revision>=old.meta.revision&&(meta.revision!==old.meta.revision||meta.terminal!==old.meta.terminal)){old.meta={...meta};mark(old);changed=true;}
      }
      if(changed)publish();schedule();
    },
    observe(observation:MioUsageObservation){
      const item=entries.get(observation.runId);if(disposed||!owner?.visible||!item||!Number.isSafeInteger(observation.serial)||observation.serial<1)return;
      if(observation.sequence!==undefined){if(!Number.isSafeInteger(observation.sequence)||observation.sequence<=item.sequence)return;item.sequence=observation.sequence;}
      else {if(observation.serial<=item.serial)return;item.serial=observation.serial;}
      mark(item);publish();schedule();
    },
    refresh(runId:string){const item=entries.get(runId);if(!disposed&&owner?.visible&&item){mark(item);publish();schedule();}},
    open(runId:string){if(disposed||!owner?.visible||!entries.has(runId))return;detailRunId=runId;mark(entries.get(runId)!);publish();schedule();},
    close(){if(detailRunId!==null){detailRunId=null;publish();}},
    dispose(){if(disposed)return;disposed=true;generation++;for(const item of entries.values())item.flight?.abort();entries.clear();active=0;owner=null;},
  };
}
export type MioUsageController=ReturnType<typeof createMioUsageController>;
