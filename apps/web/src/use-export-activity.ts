import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {rpc} from './api.ts';
import {exportActivitySchema,exportOutputSchema} from '../../../packages/contracts/src/export-controls.ts';
import type {ExportActivity,ExportOutput} from '../../../packages/contracts/src/export-controls.ts';
interface Binding {projectId:string;exportId:string;status:string;scope:string;enabled:boolean}
/** Observations belong to one visible formal export, never a "latest" output.
 * Reading a completed file hashes it once per owner; polling reads stage only. */
export function useExportActivity(input:Binding){
  const owner=useMemo(()=>({...input}),[input.projectId,input.exportId,input.status,input.scope,input.enabled]);
  const live=useRef<typeof owner|null>(null);
  const [state,setState]=useState<{owner:typeof owner;activity:ExportActivity|null;output:ExportOutput|null;failed:boolean}|null>(null);
  useLayoutEffect(()=>{live.current=owner;return()=>{if(live.current===owner)live.current=null;};},[owner]);
  const current=()=>live.current===owner&&owner.enabled;
  useEffect(()=>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setState({owner,activity:null,output:null,failed:false});
    if(!owner.enabled||!owner.projectId||!owner.exportId)return()=>abort.abort();
    const identity={projectId:owner.projectId,exportId:owner.exportId};
    const read=async()=>{
      try{
        const activity=exportActivitySchema.parse(await rpc('export.activity.get',identity,{signal:abort.signal}));
        if(activity.projectId!==owner.projectId||activity.exportId!==owner.exportId)throw Error('Export identity changed');
        if(!current()||abort.signal.aborted)return;
        setState(previous=>({owner,activity,output:previous?.owner===owner?previous.output:null,failed:false}));
        if(['queued','running'].includes(activity.status))timer=setTimeout(()=>{void read();},1000);
      }catch{if(current()&&!abort.signal.aborted)setState(previous=>({owner,activity:previous?.owner===owner?previous.activity:null,output:previous?.owner===owner?previous.output:null,failed:true}));}
    };
    void read();
    if(owner.status==='succeeded')void rpc('export.output.get',identity,{signal:abort.signal}).then(value=>{
      const output=exportOutputSchema.parse(value);if(output.projectId!==owner.projectId||output.exportId!==owner.exportId)throw Error('Export identity changed');
      if(current()&&!abort.signal.aborted)setState(previous=>({owner,activity:previous?.owner===owner?previous.activity:null,output,failed:false}));
    }).catch(()=>{if(current()&&!abort.signal.aborted)setState(previous=>({owner,activity:previous?.owner===owner?previous.activity:null,output:null,failed:true}));});
    return()=>{abort.abort();if(timer)clearTimeout(timer);};
  },[owner]);
  return {activity:state?.owner===owner?state.activity:null,output:state?.owner===owner?state.output:null,failed:state?.owner===owner&&state.failed,current};
}
