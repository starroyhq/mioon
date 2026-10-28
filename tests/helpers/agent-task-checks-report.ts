import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {readAgentTaskChecks} from '../../packages/business/src/agent/task-checks-v2.ts';
import type {AgentTaskChecksPreflight} from '../../packages/business/src/agent/task-checks-v2.ts';
import type {AgentTaskJson} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {png} from './timeline-image-fixtures.ts';

const object=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');

/** Real bounded local preflight through services.call. Synthetic model-free
 * setup is discarded after measurement; reported checks are never handwritten. */
export async function agentTaskChecksReport(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-checks-report-')),store=openStore(root),services=createServices(store,new Map(),{imageOptions:{autoRun:false},frameOptions:{autoRun:false},sceneOptions:{autoRun:false}}),tools=createAgentTaskTools({store,services});
 try{
  const project=object(await services.call('project.create',{name:'Synthetic combined check report'})),projectId=String(project.id),journal=createAgentTaskJournal(store),run=journal.create({projectId,requestId:randomUUID(),text:'Synthetic export, generation and timeline observations',configuration:{}}).run;
  const tool=async(name:string,args:AgentTaskJson)=>{
   const step=journal.beginStep(run.id,{kind:'tool',toolCall:{id:randomUUID(),name,arguments:args}}),prepared=tools.prepare({projectId,operation:name,input:args});journal.markDispatch(run.id,step.id);
   const result=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,beforeEffect:()=>{},recordInside:(value,changes)=>{journal.completeStepInside(run.id,step.id,{result:value,changes});},appendChangesInside:changes=>{journal.appendChangesInside(run.id,step.id,changes);}});
   if(journal.step(step.id).status!=='completed')journal.completeStep(run.id,step.id,{result:result.result,changes:result.changes});return journal.step(step.id);
  };
  const sourceBytes=png({width:128,height:128,rgba:false,tagged:false,pixel:(x,y)=>[(x*17+y*31)%256,(x*43+y*7)%256,(x*11+y*53)%256]}),createdAt=new Date().toISOString();
  const asset=(index:number)=>{
   const id=randomUUID(),relativePath=`media/${id}.png`;writeFileSync(join(root,relativePath),sourceBytes,{mode:0o600});return store.put('assets',{id,projectId,name:`Synthetic-${index}.png`,mimeType:'image/png',relativePath,sha256:digest(sourceBytes),sizeBytes:sourceBytes.length,width:128,height:128,duration:1,provenance:'user-import',url:`/media/${id}`,createdAt});
  };
  const first=asset(0),initial=object(await services.call('timeline.get',{projectId})),tracks=initial.tracks;assert.ok(Array.isArray(tracks));
  await tool('mioon_timeline_clip_add',{assetId:first.id,trackId:String(object(tracks[0]).id),expectedRevision:Number(initial.revision),startFrame:0,durationFrames:30});
  const saved=object(await services.call('timeline.get',{projectId})),render=await tool('mioon_timeline_render',{expectedRevision:Number(saved.revision),purpose:'export'}),exportId=String(object(render.result).id),outputBytes=Buffer.from('SYNTHETIC_EXPORT_EXISTENCE_OBSERVATION'),outputId=randomUUID(),relativePath=`media/export-${exportId}-${randomUUID()}.mp4`;writeFileSync(join(root,relativePath),outputBytes,{mode:0o600});
  store.put('assets',{id:outputId,projectId,name:'Synthetic output.mp4',mimeType:'video/mp4',relativePath,sizeBytes:outputBytes.length,sha256:digest(outputBytes),width:saved.width,height:saved.height,duration:1,provenance:'export',url:`/media/${outputId}`,createdAt});store.put('exports',{...object(store.get('exports',exportId)),status:'succeeded',assetId:outputId,url:`/media/${outputId}`,updatedAt:new Date().toISOString()});
  const shot=object(await services.call('shot.create',{projectId,title:'Synthetic generation shot'})),jobId=randomUUID(),step=journal.beginStep(run.id,{kind:'tool',toolCall:{id:randomUUID(),name:'mioon_generation_submit',arguments:{shotId:String(shot.id),expectedRevision:Number(shot.revision),providerId:'mock'}}});journal.updateStep(run.id,step.id,{status:'completed',result:{id:jobId}});
  store.put('jobs',{id:jobId,projectId,shotId:shot.id,requestId:step.id,status:'running',phase:'rendering',progress:62,providerId:'mock',model:'mock-v1',revision:1,createdAt,updatedAt:createdAt});store.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run('job',jobId,run.id,step.id,projectId,step.id,'generation.submit');
  let preflightCalls=0,preflightTimings:number[]|undefined,preflightResults:string[]|undefined;
  const preflight:AgentTaskChecksPreflight=async(input,options)=>{preflightCalls++;const started=performance.now();try{const result=await services.call('timeline.export.preflight',input,{signal:options?.signal});preflightResults?.push(String(object(result).status));return result;}finally{preflightTimings?.push(performance.now()-started);}};
  const before=store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const combinedExample=await readAgentTaskChecks(store,journal.snapshot(run.id),{preflight,includePreflight:true}),after=store.db.prepare('SELECT total_changes() AS n').get()!.n,combinedExamplePreflightCalls=preflightCalls;assert.equal(after,before);assert.equal(combinedExamplePreflightCalls,1);
  const measurements:Array<{clips:number;uniqueAssets:number;sourceBytes:number;milliseconds:number[];medianMs:number;maxMs:number;preflightStatuses:string[];noDatabaseWrites:boolean;defaultReadMilliseconds:number[];defaultReadMedianMs:number;defaultPreflightCalls:number;defaultReadNoDatabaseWrites:boolean;fullReadMilliseconds:number[];fullReadMedianMs:number;fullPreflightCalls:number;fullReadNoDatabaseWrites:boolean}>=[];
  const clips=saved.clips;assert.ok(Array.isArray(clips));const firstClip=object(clips[0]);
  for(const count of [1,10,100]){
   const assets=[first,...Array.from({length:count-1},(_value,index)=>asset(index+1))],current={...saved,revision:Number(saved.revision)+count,clips:assets.map((source,index)=>({...firstClip,id:randomUUID(),assetId:source.id,startFrame:index*30})),durationFrames:count*30};store.db.prepare('UPDATE timelines SET data=? WHERE projectId=?').run(JSON.stringify(current),projectId);
   const milliseconds:number[]=[],statuses:string[]=[],defaultReadMilliseconds:number[]=[],fullReadMilliseconds:number[]=[],before=store.db.prepare('SELECT total_changes() AS n').get()!.n;let defaultPreflightCalls=0,fullPreflightCalls=0,defaultReadNoDatabaseWrites=true,fullReadNoDatabaseWrites=true;preflightTimings=milliseconds;preflightResults=statuses;
   for(let attempt=0;attempt<3;attempt++){
    const snapshot=journal.snapshot(run.id),defaultWrites=store.db.prepare('SELECT total_changes() AS n').get()!.n,defaultCallsBefore=preflightCalls,startedDefault=performance.now(),light=await readAgentTaskChecks(store,snapshot,{preflight});defaultReadMilliseconds.push(performance.now()-startedDefault);defaultPreflightCalls+=preflightCalls-defaultCallsBefore;defaultReadNoDatabaseWrites&&=store.db.prepare('SELECT total_changes() AS n').get()!.n===defaultWrites;
    assert.equal(light.groups[2].items.find(item=>item.type==='timeline_references')?.status,'passed');assert.equal(light.groups[2].items.find(item=>item.type==='timeline_preflight')?.reason?.code,'PREFLIGHT_NOT_REQUESTED');assert.equal(preflightCalls,defaultCallsBefore);
    const fullWrites=store.db.prepare('SELECT total_changes() AS n').get()!.n,fullCallsBefore=preflightCalls,startedFull=performance.now(),full=await readAgentTaskChecks(store,snapshot,{preflight,includePreflight:true});fullReadMilliseconds.push(performance.now()-startedFull);fullPreflightCalls+=preflightCalls-fullCallsBefore;fullReadNoDatabaseWrites&&=store.db.prepare('SELECT total_changes() AS n').get()!.n===fullWrites;
    const check=full.groups[2].items.find(item=>item.type==='timeline_preflight');assert.equal(check?.status,'passed');
   }
   const sorted=[...milliseconds].sort((a,b)=>a-b),defaultSorted=[...defaultReadMilliseconds].sort((a,b)=>a-b),fullSorted=[...fullReadMilliseconds].sort((a,b)=>a-b);assert.equal(defaultPreflightCalls,0);assert.equal(fullPreflightCalls,3);
   measurements.push({clips:count,uniqueAssets:count,sourceBytes:sourceBytes.length*count,milliseconds,medianMs:sorted[1],maxMs:sorted[2],preflightStatuses:statuses,noDatabaseWrites:store.db.prepare('SELECT total_changes() AS n').get()!.n===before,defaultReadMilliseconds,defaultReadMedianMs:defaultSorted[1],defaultPreflightCalls,defaultReadNoDatabaseWrites,fullReadMilliseconds,fullReadMedianMs:fullSorted[1],fullPreflightCalls,fullReadNoDatabaseWrites});
  }
  return {node:process.version,platform:process.platform,arch:process.arch,preflight:'services.call(timeline.export.preflight)',defaultRead:'readAgentTaskChecks without includePreflight',fullRead:'readAgentTaskChecks with includePreflight=true',combinedExampleMode:'explicit_preflight',combinedExample,combinedExamplePreflightCalls,combinedExampleNoDatabaseWrites:before===after,measurements};
 }finally{tools.dispose();await services.drain();store.close();rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])process.stdout.write(`${JSON.stringify(await agentTaskChecksReport(),null,2)}\n`);
