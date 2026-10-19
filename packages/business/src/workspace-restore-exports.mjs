import {TIMELINE_RENDER_RESPONSE_BYTES} from '@mioon/contracts';
import {getWorkspaceRestoreContext,isRestoredRecordHeld} from './workspace-restore-schema.mjs';
import {restoreDigest,assertRestoreInvocation} from './workspace-restore-invocation.mjs';
import {ownsStoreLock} from './db.mjs';
import {workspaceRestoreError} from './workspace-restore-policy.mjs';

// Seal acceptance identity independently of mutable status/output fields. The
// original request hash separately binds optional caller fields absent here.
export function restoreExportIdentity(value){
 return restoreDigest(Object.fromEntries(['id','projectId','requestId','mode','purpose','timelineRevision','orderedVersionIds','snapshot','createdAt','outputGeometry'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])));
}
export function bindRestoredExport(store,operation,input,value,requestHash){
 const restored=getWorkspaceRestoreContext(store);if(!restored)return;
 assertRestoreInvocation(store,operation,input);
 const requestScope=operation==='export.create'?'export':operation==='timeline.render'?'timeline.render':null;
 if(Buffer.byteLength(JSON.stringify(value))>TIMELINE_RENDER_RESPONSE_BYTES||!requestScope||!store.db.isTransaction||value.status!=='queued'||value.assetId!==null||value.url!==null||value.projectId!==input.projectId||value.requestId!==input.requestId||requestHash!==restoreDigest(operation==='export.create'?input:{operation,input}))throw workspaceRestoreError();
 store.db.prepare('INSERT INTO workspace_restore_export_origins(exportId,projectId,workspaceOrigin,requestScope,requestId,requestHash,identityHash) VALUES(?,?,?,?,?,?,?)').run(value.id,value.projectId,restored.workspaceOrigin,requestScope,input.requestId,requestHash,restoreExportIdentity(value));
}
export function matchesRestoredExport(store,value){
 const restored=getWorkspaceRestoreContext(store);if(!restored)return true;
 if(!ownsStoreLock(store)||!value||isRestoredRecordHeld(store,'exports',value.id))return false;
 const origin=store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=? AND projectId=? AND workspaceOrigin=?').get(value.id,value.projectId,restored.workspaceOrigin);
 if(!origin||origin.requestId!==value.requestId||origin.identityHash!==restoreExportIdentity(value)||typeof origin.requestHash!=='string'||origin.requestHash.length!==64||!/^[a-f0-9]{64}$/u.test(origin.requestHash))return false;
 if(value.mode==='timeline'){
  if(origin.requestScope!=='timeline.render')return false;
  const receipt=store.db.prepare(`SELECT requestHash,CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${TIMELINE_RENDER_RESPONSE_BYTES} THEN response END AS response FROM timeline_requests WHERE requestId=?`).get(origin.requestId);
  if(!receipt||receipt.requestHash!==origin.requestHash||!receipt.response)return false;
  let saved;try{saved=JSON.parse(receipt.response);}catch{return false;}
  return saved.status==='queued'&&saved.assetId===null&&saved.url===null&&restoreExportIdentity(saved)===origin.identityHash;
 }
 if(origin.requestScope!=='export'||Object.hasOwn(value,'mode'))return false;
 const receipt=store.db.prepare("SELECT requestHash,resourceId FROM idempotency WHERE scope='export' AND requestId=?").get(origin.requestId);
 return receipt?.resourceId===value.id&&receipt.requestHash===origin.requestHash;
}
