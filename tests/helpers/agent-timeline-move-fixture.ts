import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentEditService} from '../../packages/business/src/agent/edit-proposals.ts';
import {timelineEditToolPolicy} from '../../packages/business/src/agent/timeline-edit-tool-policy.ts';

type Store = ReturnType<typeof openStore>;
type Services = ReturnType<typeof createServices>;
type Edits = ReturnType<typeof createAgentEditService>;
interface FixtureTrack {readonly id: string}
interface FixtureClip {readonly id: string}
interface FixtureTimeline {readonly id: string; readonly revision: number; readonly tracks: FixtureTrack[]; readonly clips: FixtureClip[]}
interface ProposalRow {readonly id: string; readonly digest: string}
interface MoveTarget {readonly timelineId: string; readonly expectedRevision: number; readonly clip: {readonly id: string}; readonly [key: string]: unknown}
interface FixtureRun {readonly id: string; status: string; modelRequestState: string; activity: unknown[]; readonly [key: string]: unknown}
interface FixtureTool {
  readonly id: string; status: string;
  readonly intent: {readonly provenance: Record<string, unknown>; readonly toolCall: Record<string, unknown>};
  observation?: {readonly result: Record<string, unknown>; readonly resultJson: string; readonly provenance: Record<string, unknown>};
  readonly [key: string]: unknown;
}
interface PreparedMove {
  readonly run: FixtureRun; readonly tool: FixtureTool; readonly target: MoveTarget;
  readonly changes: Record<string, unknown>; readonly toolCall: Record<string, unknown>;
  readonly projectId: string; readonly runId: string;
}
export interface AgentTimelineMoveFixtureOptions {
  readonly fault?: (label: string)=>void;
  readonly dispatch?: (projectId: string,input: never,target: never,services: Services)=>unknown;
  readonly limits?: unknown;
}
export async function agentTimelineMoveFixture(t: unknown, options: AgentTimelineMoveFixtureOptions = {}) {
  const root=mkdtempSync(path.join(tmpdir(),'mioon-agent-timeline-move-'));
  let store: Store=openStore(root),services: Services=createServices(store,new Map()),edits: Edits|null=null,calls=0;
  let fault: (label: string)=>void=options.fault??(()=>{}),dispatch=options.dispatch;
  const requireEdits=(): Edits=>{if(!edits)throw Error('Fixture has not started');return edits;};
  function scoped(): Record<string, unknown> {
    return {updateShotInProject:(...args: never[])=>(services.updateShotInProject as unknown as (...a: never[])=>unknown)(...args),moveTimelineClipInProject:(projectId: string,input: never,target: never)=>{
      calls++;assert.equal(store.db.isTransaction,false);
      return dispatch?dispatch(projectId,input,target,services):(services as unknown as Record<string,(...a: never[])=>unknown>).moveTimelineClipInProject!(...([projectId,input,target] as never[]));
    }};
  }
  const start=(): void=>{edits=createAgentEditService({store,services:scoped() as never,fault:(label: string)=>fault(label),limits:options.limits as never});};start();
  const project=await services.call('project.create',{name:'Synthetic reviewed clip move'}) as unknown as {id: string};
  const other=await services.call('project.create',{name:'PRIVATE other project'}) as unknown as {id: string};
  const asset=store.put('assets',{id:randomUUID(),projectId:project.id,name:'PRIVATE source file',mimeType:'video/mp4',duration:10,width:720,height:1280,
    hasAudio:true,hasVideo:true,provenance:'user-import',sha256:'a'.repeat(64),relativePath:'media/PRIVATE.fixture',createdAt:'2026-10-10T00:00:00.000Z'});
  let timeline=await services.call('timeline.get',{projectId:project.id}) as unknown as FixtureTimeline;
  timeline=await services.call('timeline.clip.add',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision,assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:30,durationFrames:60,sourceInFrame:15,name:'Selected clip'}) as unknown as FixtureTimeline;
  const clip=structuredClone(timeline.clips[0]);
  (t as {after(callback: ()=>void): void}).after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const f={root,project,other,asset,timeline,clip,get store(){return store;},get services(){return services;},get edits(){return edits;},get calls(){return calls;},
    current(): {revision: number} {return store.get('timelines',timeline.id) as {revision: number};},setFault(fn: (label: string)=>void){fault=fn;},setDispatch(fn: typeof dispatch){dispatch=fn;},
    restart(){store.close();store=openStore(root);services=createServices(store,new Map());start();},
    second(){return createAgentEditService({store,services:scoped() as never});},
    request(proposal: ProposalRow){return {projectId:project.id,proposalId:proposal.id,digest:proposal.digest};},
    row(proposal: ProposalRow){return store.db.prepare('SELECT * FROM agent_edit_proposals WHERE id=?').get(proposal.id);},
    receipts(){return store.db.prepare('SELECT * FROM timeline_requests ORDER BY rowid').all();},
    prepare(changes: Record<string, unknown> = {startFrame:120},fields: Record<string, unknown> = {}): PreparedMove {
      const target=requireEdits().pinTimelineTarget(project.id,{timelineId:timeline.id,clipId:clip.id,expectedRevision:f.current().revision}) as unknown as MoveTarget;
      const runId=randomUUID(),requestId=randomUUID(),threadId=randomUUID(),toolId=randomUUID();
      const existing=store.db.prepare('SELECT id FROM agent_chat_threads WHERE projectId=?').get(project.id) as {id: string}|undefined;
      const tid=existing?.id??threadId;
      if(!existing)store.db.prepare('INSERT INTO agent_chat_threads VALUES(?,?,0,1)').run(tid,project.id);
      const position=Number((store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(project.id) as {n: number}).n)+1;
      const run: FixtureRun={id:runId,projectId:project.id,requestId,threadId:tid,status:'running',contextMode:'selected_timeline_clip_move',editTarget:target,
        modelRequestState:'dispatch_started',activity:[],...fields};
      const acceptance={version:1,execution:{version:1,target,policy:timelineEditToolPolicy(project.id)}};
      store.db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?,?,?)').run(requestId,project.id,tid,runId,'fixture',JSON.stringify(acceptance),100);
      store.db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?,?,?,?)').run(runId,project.id,tid,requestId,position,run.status,JSON.stringify(run),100);
      const toolCall={id:'call_'+randomUUID(),name:'mioon_propose_timeline_clip_move',arguments:changes,argumentsJson:JSON.stringify(changes)};
      const tool: FixtureTool={id:toolId,projectId:project.id,runId,position:2,kind:'tool',ordinal:1,status:'dispatch_started',
        intent:{toolCall,provenance:{category:'project_selected_timeline_timing',projectId:project.id,operation:'timeline.clip.update'}}};
      store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(toolId,runId,project.id,2,'tool',tool.status,JSON.stringify(tool),100);
      return {run,tool,target,changes,toolCall,projectId:project.id,runId};
    },
    create(prepared: PreparedMove){return store.tx(()=>requireEdits().createInside(prepared as never));},
    finish(prepared: PreparedMove,proposal: ProposalRow|undefined,status='completed'): void {
      const {run,tool}=prepared;
      if(proposal){
        const result={kind:'untrusted_timeline_clip_move_proposal',status:'pending_review',applied:false,proposalId:proposal.id,digest:proposal.digest,operation:'timeline.clip.update'};
        const observation={result,resultJson:JSON.stringify(result),provenance:tool.intent.provenance};
        tool.observation=observation;tool.status='completed';
        store.db.prepare('UPDATE agent_chat_steps SET status=?,data=? WHERE id=?').run(tool.status,JSON.stringify(tool),tool.id);
        run.activity=[{id:tool.id,kind:'tool',ordinal:1,status:'completed',resultJson:observation.resultJson}];
      }
      if(status==='completed'){
        const final={id:randomUUID(),runId:run.id,projectId:project.id,kind:'model',position:3,ordinal:2,status:'completed',output:{type:'done',finishReason:'stop'}};
        store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(final.id,run.id,project.id,3,'model','completed',JSON.stringify(final),100);
        run.activity.push({id:final.id,kind:'model',ordinal:2,status:'completed'});
      }
      run.status=status;run.modelRequestState=status==='completed'?'completed':'unknown';
      store.db.prepare('UPDATE agent_chat_runs SET status=?,data=? WHERE id=?').run(status,JSON.stringify(run),run.id);
    },
    proposal(changes: Record<string, unknown>,status='completed'): ProposalRow{const prepared=f.prepare(changes),proposal=f.create(prepared);f.finish(prepared,proposal as unknown as ProposalRow,status);return proposal as unknown as ProposalRow;},
  };
  return f;
}
