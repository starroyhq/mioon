import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOpacityRestoredApplicationInspection as create, isOpacityRestoredApplicationInspection as valid,
 OPACITY_RESTORED_APPLICATION_LOCAL_OPERATIONS} from '../packages/contracts/src/opacity-restored-application.ts';
import {isWorkspaceRestoreInspection} from '../packages/contracts/src/workspace-restore.ts';

const metadata=()=>({schemaVersion:43,sourceSchema:42,profile:'restored-local-v10',workspaceOrigin:randomUUID(),restorationId:randomUUID(),
 sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-16T00:00:00.000Z',heldCounts:{edit_tasks:1,exports:2}});
test('restored application disclosure has one exact pair, provenance, original permissions and explicit excluded drafts',()=>{
 const info=metadata(),view=create(info);
 assert.equal(valid(view),true);assert.equal(isWorkspaceRestoreInspection(view),false,'historical profile grammar stays closed');
 assert.equal(view.draftPolicy,'excluded');assert.equal(view.workspaceOrigin,info.workspaceOrigin);assert.equal(view.source.backupId,info.sourceBackupId);
 assert.deepEqual(OPACITY_RESTORED_APPLICATION_LOCAL_OPERATIONS,['timeline.clip.update','timeline.undo','timeline.redo','timeline.render']);
 for(const operation of ['project.create','asset.import','timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.remove','workspace.preferences.put','generation.submit'])
  assert.equal(view.operationPolicy.find(row=>row.operation===operation).available,false);
});
test('wrong pair, incomplete provenance, duplicated evidence and forged operation availability fail closed',()=>{
 const view=create(metadata());
 for(const patch of [{schemaVersion:41},{profile:'restored-local-v9'},{source:{...view.source,schemaVersion:40}},{workspaceOrigin:'bad'},
  {draftPolicy:'restored'},{draftPolicy:undefined},{audioRoleCapability:{editable:true}},{extra:true},
  {heldCounts:[...view.heldCounts,view.heldCounts[0]]},{heldCounts:[{kind:'edit_tasks',count:20001}]},
  {heldCounts:[{kind:'edit_tasks',count:12000},{kind:'exports',count:12000}]},
  {operationPolicy:view.operationPolicy.slice(1)},
  {operationPolicy:view.operationPolicy.map(row=>row.operation==='project.create'?{...row,available:true,reason:'AVAILABLE'}:row)},
  {operationPolicy:view.operationPolicy.map(row=>row.operation==='project.create'?{...row,operation:'unknown.write'}:row)}])
  assert.equal(valid({...view,...patch}),false,JSON.stringify(patch));
 for(const patch of [{schemaVersion:41},{sourceSchema:40},{profile:'restored-local-v9'},{heldCounts:{edit_tasks:-1}},{extra:true}])
  assert.throws(()=>create({...metadata(),...patch}));
});
