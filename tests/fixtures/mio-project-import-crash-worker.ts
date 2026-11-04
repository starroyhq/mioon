import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../../packages/business/src/project-service-application.ts';
import {createAgentTaskJournal} from '../../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createMioProjectImport} from '../../packages/business/src/agent/mio-project-import.ts';
import {installProjectVersionCapture} from '../../packages/business/src/project-versions/capture.ts';
import {MIO_PROJECT_FILE_IMPORT_TOOL} from '../../packages/contracts/src/mio-project-import.ts';
import type {AgentTaskJson} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {beginFixtureToolStep,mioFixtureConfiguration} from '../helpers/mio-model-fixture.ts';
import {png} from '../helpers/timeline-image-fixtures.ts';

const {root,point}=JSON.parse(process.argv[2]??'null') as {root:string;point:string};
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const store=openStore(root),services=createServices(store,new Map());
const receipts=()=>{
  const directory=path.join(store.tempDir,'asset-imports');
  return existsSync(directory)?readdirSync(directory).filter(name=>name.endsWith('.json')).sort().map(name=>({name,sha256:hash(readFileSync(path.join(directory,name))),phase:(JSON.parse(readFileSync(path.join(directory,name),'utf8')) as {phase:string}).phase})):[];
};
try{
  await services.call('project.create',{name:'Crash-safe project file import'});
  const source=path.join(root,'source.png'),bytes=png({width:32,height:24,rgba:false});writeFileSync(source,bytes);
  // Production installs this before Mio's transaction observers too.
  const removeCapture=installProjectVersionCapture(store,{assertMutationAllowed:()=>services.assertMutationAllowed()});
  const application=testProjectAppLibrary(store);assert.ok(application);
  const port=createMioProjectImport({store,services,privateDirectories:[application.dataDir,store.cacheDir,store.tempDir]});
  const journal=createAgentTaskJournal(store),tools=createAgentTaskTools({store,services,projectImport:port,journal});
  const projectId=store.projectId,run=journal.create({projectId,requestId:randomUUID(),text:'Register one project file',configuration:mioFixtureConfiguration}).run;
  const input={path:'source.png',name:'Crash-safe source'},initial=tools.prepare({projectId,operation:MIO_PROJECT_FILE_IMPORT_TOOL,input});
  const step=beginFixtureToolStep(journal,run.id,{tier:initial.risk,targets:initial.targets,toolCall:{id:randomUUID(),name:MIO_PROJECT_FILE_IMPORT_TOOL,arguments:input}});
  const prepared=await tools.prepareProjectFileImport(initial,{requestId:step.id,beforeEffect(){}});assert.ok(prepared.projectFileImport);
  const data=step.data&&typeof step.data==='object'&&!Array.isArray(step.data)?step.data:{};
  journal.updateStep(run.id,step.id,{status:'intent',data:{...data,projectFileImport:JSON.parse(JSON.stringify(prepared.projectFileImport)) as AgentTaskJson}});
  const controlId=randomUUID(),evidence={projectId,runId:run.id,stepId:step.id,controlId,preparation:prepared.projectFileImport,sourceSha256:hash(bytes),receiptBeforeUndo:[] as ReturnType<typeof receipts>};
  const save=()=>writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence));save();
  const kill=(reached:string)=>{
    writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify({point:reached,inTransaction:store.db.isTransaction,assets:store.list('assets',projectId).length,step:journal.step(step.id).status,changes:journal.snapshot(run.id).changes.map(change=>({id:change.id,status:change.status})),receipts:receipts(),control:journal.lookupControl(controlId)}));
    process.kill(process.pid,'SIGKILL');throw Error('SIGKILL did not terminate the worker');
  };
  journal.markDispatch(run.id,step.id);
  const outcome=await tools.execute(prepared,{runId:run.id,stepId:step.id,requestId:step.id,
    beforeEffect(){
      if(point==='before_register'&&store.db.isTransaction&&store.list('assets',projectId).length===0&&receipts().some(receipt=>receipt.phase==='prepared'))kill(point);
      if(point==='after_commit_before_ack'&&!store.db.isTransaction&&journal.step(step.id).status==='completed')kill(point);
    },
    recordInside(result,changes){
      assert.equal(store.db.isTransaction,true);journal.completeStepInside(run.id,step.id,{result,changes});
      if(point==='inside_record_created')kill(point);
    }});
  assert.equal(outcome.recorded,true);assert.equal(journal.step(step.id).status,'completed');
  assert.equal(receipts()[0]?.phase,'registered');
  if(point==='after_registered')kill(point);
  evidence.receiptBeforeUndo=receipts();save();
  journal.transition(run.id,journal.run(run.id).revision,'completed');
  const change=journal.snapshot(run.id).changes[0];assert.ok(change);
  journal.beginControl({requestId:controlId,runId:run.id,expectedRevision:journal.run(run.id).revision,action:'undo_change',changeId:change.id});
  tools.undo(change,{beforeEffect(){},beforeCompensation(){if(point==='undo_before_delete')kill(point);},
    recordInside(value){
      assert.equal(store.db.isTransaction,true);journal.markChangeRevertedInside(value.id);
      journal.finishControl(controlId,{state:'completed',revertedIds:[value.id]});
      if(point==='undo_inside_record')kill(point);
    },retainInside(){assert.fail('Project import compensation must remove its unchanged row');}});
  if(point==='undo_after_commit')kill(point);
  assert.equal(point,'stable');writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify({point:'stable',inTransaction:store.db.isTransaction}));
  tools.dispose();removeCapture();await services.drain();store.close();
}catch(error){
  writeFileSync(path.join(root,'worker-failure.json'),JSON.stringify({message:error instanceof Error?error.message:'Worker failed',code:error&&typeof error==='object'&&'code'in error?String(error.code):null}));
  throw error;
}
