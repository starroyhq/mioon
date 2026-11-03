import {openStore} from '../../packages/business/src/project-file/index.ts';
import {testProjectAppLibrary} from '../../packages/business/src/project-service-application.ts';
import {createMioProjectRules} from '../../packages/business/src/agent/mio-rules.ts';
import {createMioProjectJournal} from '../../packages/business/src/agent/mio-journal-factory.ts';
import type {MioRulesApproval} from '../../packages/business/src/agent/mio-rules.ts';

const [root,requestId,crashPhase,approvalJson]=process.argv.slice(2);
if(!root||!requestId||!crashPhase)throw Error('Missing crash fixture arguments');
const store=openStore(root),application=testProjectAppLibrary(store);
if(!application)throw Error('Missing real application library');
const rules=createMioProjectRules({store,application,onPhase:phase=>{if(phase===crashPhase)process.kill(process.pid,'SIGKILL');}});
let approval:MioRulesApproval|undefined;
if(approvalJson){
 const value:unknown=JSON.parse(approvalJson);
 if(value===null||typeof value!=='object'||!('runId'in value)||typeof value.runId!=='string'||!('stepId'in value)||typeof value.stepId!=='string'||!('approvalReceiptId'in value)||typeof value.approvalReceiptId!=='string'||!('proposalDigest'in value)||typeof value.proposalDigest!=='string')throw Error('Invalid approval fixture');
 const journal=createMioProjectJournal(store,application.agentPolicy),runId=value.runId,stepId=value.stepId;
 approval={runId,stepId,approvalReceiptId:value.approvalReceiptId,proposalDigest:value.proposalDigest,recordInside:result=>journal.completeStepInside(runId,stepId,{result,changes:[]})};
}
rules.save({requestId,expectedHash:null,text:approval?'Mio approved rules':'after\r\n'},approval);
throw Error('Crash phase was not reached');
