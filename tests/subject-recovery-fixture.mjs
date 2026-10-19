import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';

export async function subjectFixture(t, options={}) {
 const root=mkdtempSync(path.join(tmpdir(),'mioon-subject-recovery-'));
 let store=openStore(root),services=createServices(store,new Map()),tasks,calls=0,fault=()=>{},dispatch;
 const start=()=>{tasks=createEditTasks({store,services:{call(op,input){calls++;return dispatch?dispatch(op,input,services):services.call(op,input);}},fault:label=>fault(label),limits:options.limits});};start();
 const project=await services.call('project.create',{name:'Subject recovery fixture'}),other=await services.call('project.create',{name:'PRIVATE_OTHER'});
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const f={root,project,other,get store(){return store;},get services(){return services;},get tasks(){return tasks;},get calls(){return calls;},
  setFault(fn){fault=fn;},setDispatch(fn){dispatch=fn;},
  restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
  asset(patch={}){const id=randomUUID();return store.put('assets',{id,projectId:project.id,name:'Synthetic image',mimeType:'image/png',duration:0,width:64,height:64,hasAudio:false,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:`media/${id}.png`,createdAt:new Date().toISOString(),...patch});},
  row(task){return store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(task.id);},
  request(task){return {projectId:task.projectId,taskId:task.id,digest:task.digest};},
  execute(envelope){return tasks.execute({...f.request(envelope.task),instanceId:envelope.instanceId});},
  ack(task){return tasks.acknowledge({...f.request(task),expectedRevision:task.revision,status:task.status});},
  prepare(operation,input,origin='new'){return tasks.prepare({projectId:project.id,operation,input,origin});},
  snapshot(){return JSON.stringify(['projects','assets','shots','nodes','edges','jobs','versions','exports','timelines','mutation_requests','asset_range_requests','asset_disposition_requests','subjects','subject_versions','subject_bindings','subject_requests'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));},
 };
 f.source=f.asset();
 f.createInput=(patch={})=>({projectId:project.id,kind:'character',name:'Hero',assetId:f.source.id,requestId:randomUUID(),...patch});
 f.shot=await services.call('shot.create',{projectId:project.id,title:'Scene'});
 return f;
}
