import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentEditService} from '../../packages/business/src/agent/edit-proposals.ts';
import {timelineEditToolPolicy} from '../../packages/business/src/agent/timeline-edit-tool-policy.ts';

export async function agentTimelineMoveFixture(t, options={}) {
  const root=mkdtempSync(path.join(tmpdir(),'mioon-agent-timeline-move-'));
  let store=openStore(root),services=createServices(store,new Map()),edits,calls=0,fault=options.fault??(()=>{}),dispatch=options.dispatch;
  function scoped(){return {updateShotInProject:(...args)=>services.updateShotInProject(...args),moveTimelineClipInProject(projectId,input,target){
    calls++;assert.equal(store.db.isTransaction,false);
    return dispatch?dispatch(projectId,input,target,services):services.moveTimelineClipInProject(projectId,input,target);
  }};}
  const start=()=>{edits=createAgentEditService({store,services:scoped(),fault:label=>fault(label),limits:options.limits});};start();
  const project=await services.call('project.create',{name:'Synthetic reviewed clip move'}),other=await services.call('project.create',{name:'PRIVATE other project'});
  const asset=store.put('assets',{id:randomUUID(),projectId:project.id,name:'PRIVATE source file',mimeType:'video/mp4',duration:10,width:720,height:1280,
    hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:'media/PRIVATE.fixture',createdAt:'2026-10-10T00:00:00.000Z'});
  let timeline=await services.call('timeline.get',{projectId:project.id});
  timeline=await services.call('timeline.clip.add',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision,assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:30,durationFrames:60,sourceInFrame:15,name:'Selected clip'});
  const clip=structuredClone(timeline.clips[0]);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const f={root,project,other,asset,timeline,clip,get store(){return store;},get services(){return services;},get edits(){return edits;},get calls(){return calls;},
    current(){return store.get('timelines',timeline.id);},setFault(fn){fault=fn;},setDispatch(fn){dispatch=fn;},
    restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
    second(){return createAgentEditService({store,services:scoped()});},
    request(proposal){return {projectId:project.id,proposalId:proposal.id,digest:proposal.digest};},
    row(proposal){return store.db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(proposal.id);},
    receipts(){return store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all();},
    prepare(changes={startFrame:120},fields={}){
      const target=edits.pinTimelineTarget(project.id,{timelineId:timeline.id,clipId:clip.id,expectedRevision:f.current().revision});
      const runId=randomUUID(),requestId=randomUUID(),threadId=randomUUID(),toolId=randomUUID();
      const existing=store.db.prepare('SELECT id FROM agent_chat_threads WHERE projectId=?').get(project.id),tid=existing?.id??threadId;
      if(!existing)store.db.prepare('INSERT INTO agent_chat_threads VALUES(?,?,0,1)').run(tid,project.id);
      const position=store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(project.id).n+1;
      const run={id:runId,projectId:project.id,requestId,threadId:tid,status:'running',contextMode:'selected_timeline_clip_move',editTarget:target,
        modelRequestState:'dispatch_started',activity:[],...fields};
      const acceptance={version:1,execution:{version:1,target,policy:timelineEditToolPolicy(project.id)}};
      store.db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?,?,?)').run(requestId,project.id,tid,runId,'fixture',JSON.stringify(acceptance),100);
      store.db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?,?,?,?)').run(runId,project.id,tid,requestId,position,run.status,JSON.stringify(run),100);
      const toolCall={id:'call_'+randomUUID(),name:'mioon_propose_timeline_clip_move',arguments:changes,argumentsJson:JSON.stringify(changes)};
      const tool={id:toolId,projectId:project.id,runId,position:2,kind:'tool',ordinal:1,status:'dispatch_started',
        intent:{toolCall,provenance:{category:'project_selected_timeline_timing',projectId:project.id,operation:'timeline.clip.update'}}};
      store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(toolId,runId,project.id,2,'tool',tool.status,JSON.stringify(tool),100);
      return {run,tool,target,changes,toolCall,projectId:project.id,runId};
    },
    create(prepared){return store.tx(()=>edits.createInside(prepared));},
    finish(prepared,proposal,status='completed'){
      const {run,tool}=prepared;
      if(proposal){
        const result={kind:'untrusted_timeline_clip_move_proposal',status:'pending_review',applied:false,proposalId:proposal.id,digest:proposal.digest,operation:'timeline.clip.update'};
        tool.observation={result,resultJson:JSON.stringify(result),provenance:tool.intent.provenance};tool.status='completed';
        store.db.prepare('UPDATE agent_chat_steps SET status=?,data=? WHERE id=?').run(tool.status,JSON.stringify(tool),tool.id);
        run.activity=[{id:tool.id,kind:'tool',ordinal:1,status:'completed',resultJson:tool.observation.resultJson}];
      }
      if(status==='completed'){
        const final={id:randomUUID(),runId:run.id,projectId:project.id,kind:'model',position:3,ordinal:2,status:'completed',output:{type:'done',finishReason:'stop'}};
        store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(final.id,run.id,project.id,3,'model','completed',JSON.stringify(final),100);
        run.activity.push({id:final.id,kind:'model',ordinal:2,status:'completed'});
      }
      run.status=status;run.modelRequestState=status==='completed'?'completed':'unknown';
      store.db.prepare('UPDATE agent_chat_runs SET status=?,data=? WHERE id=?').run(status,JSON.stringify(run),run.id);
    },
    proposal(changes,status='completed'){const prepared=f.prepare(changes),proposal=f.create(prepared);f.finish(prepared,proposal,status);return proposal;},
  };
  return f;
}
