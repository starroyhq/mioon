/** Actual CLI reads against the isolated desktop fixture, never UI hooks.
 * Live byte proof and the later --cold logical result are separate phases. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {auditColdNativeQa,nativeQaOwners,readNativeQaJson,verifyNativeQaCliInspections,writeNativeQaJson} from './helpers/native-qa-audit.mjs';

if(process.platform!=='linux')throw Error('This acceptance fixture verifies Linux only');
const root=path.resolve('evidence/agent-inspection/native-runtime'),cold=process.argv.includes('--cold');
const layout=readNativeQaJson(path.join(root,'native-audit-layout.json')),owners=nativeQaOwners(root,{cold}),{launch}=owners;
if(!launch.sandboxUnchanged||launch.remoteDebugging||launch.smokeHooks||!Number.isSafeInteger(launch.pid)||launch.pid<=1||!Number.isSafeInteger(owners.utilityPid)||owners.utilityPid<=1)throw Error('Invalid fixture identity');
if(!cold){
 const processStatus=await readFile('/proc/'+owners.utilityPid+'/status','utf8');
 if(Number(/^PPid:\s+(\d+)$/m.exec(processStatus)?.[1])!==launch.pid)throw Error('The connection is not owned by the launched fixture');
 const verified=await verifyNativeQaCliInspections(layout,{connectionFile:path.join(root,'user-data/mcp-connection.json'),ownerPids:owners.ownerPids});
 assert.deepEqual(verified.results.map(result=>result.operation),['project.inspect','asset.inspect','shot.inspect','timeline.inspect']);
 for(const{operation,result}of verified.results)assert.equal(result.ok,true,operation);
 assert.deepEqual(verified.physicalAfter,verified.physicalBefore,'Inspection changed stored database bytes or the full file inventory');
 assert.equal(verified.physicalAfter.sha256,verified.physicalBefore.sha256,'A persistent database change occurred during inspection');
 const report={at:new Date().toISOString(),baseline:'54bdda3a',phase:'live-cli-physical',runtime:'Ordinary sandboxed Linux Electron, actual CLI HTTP calls',
  mainPid:launch.pid,utilityPid:owners.utilityPid,allTablesUnchanged:true,coldVerificationPending:true,noModelToolExecution:true,...verified};
 writeNativeQaJson(path.join(root,'inspection-report.live.json'),report);
 writeNativeQaJson(path.join(root,'inspection-report.json'),report);
 console.log(JSON.stringify({passed:true,phase:report.phase,operations:verified.results.length,allTablesUnchanged:true,databaseHash:verified.physicalAfter.sha256,coldVerificationPending:true}));
}else{
 const live=readNativeQaJson(path.join(root,'inspection-report.live.json'));
 assert.equal(live.mainPid,owners.mainPid,'Cold evidence must belong to the same observed launch');
 assert.equal(live.utilityPid,owners.utilityPid,'Cold evidence must belong to the same observed utility');
 const logical=await auditColdNativeQa(layout,{ownerPids:owners.ownerPids});
 const report={...live,at:new Date().toISOString(),phase:'cold-result',coldVerificationPending:false,logical,
  changeProof:'The warmed four-CLI window has identical complete physical database/sidecar evidence; cold SQL records all schemas/rows after both owners exited. Cold data_version is not used as a commit counter.'};
 writeNativeQaJson(path.join(root,'inspection-report.json'),report);
 console.log(JSON.stringify({passed:true,phase:report.phase,operations:live.results.length,allTablesUnchanged:true,databaseHash:live.physicalAfter.sha256}));
}
