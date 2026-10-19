import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {opacityWorkspaceBackupManifestSchema as manifestSchema, opacityWorkspaceBackupResultSchema as backupSchema,
 opacityWorkspaceRestoreResultSchema as restoreSchema, opacityWorkspaceRestoreStatusSchema as statusSchema} from '../packages/contracts/src/opacity-candidate-backup.ts';
import {workspaceBackupManifestSchema, workspaceBackupResultSchema} from '../packages/contracts/src/workspace-backup.mjs';
import {workspaceRestoreOfflineResultSchema} from '../packages/contracts/src/workspace-restore-offline.mjs';

const hash='a'.repeat(64),stamp='2026-10-16T00:00:00.000Z';
const inventory={complete:true,totalIssues:0,issues:[],truncated:false};
const entry={path:'payload/workbench.sqlite',role:'database',bytes:1,sha256:hash};
const manifest=()=>({format:'mioon-workspace-backup',formatVersion:1,backupId:randomUUID(),createdAt:stamp,applicationVersion:'0.4.1',
 databaseSchemaVersion:42,scope:'whole_workspace',entries:[entry],inventory,draftPolicy:'excluded'});
const backup=()=>({format:'mioon-workspace-backup',formatVersion:1,backupId:randomUUID(),integrity:'verified',restoration:'not_tested',
 databaseSchemaVersion:42,fileCount:1,payloadBytes:1,inventory,draftPolicy:'excluded'});
const binding=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:hash,sourceDbHash:hash,
 profile:'restored-local-v10',sourceSchema:42,databaseSchemaVersion:43,createdAt:stamp,heldCounts:{edit_tasks:0},draftPolicy:'excluded'});

test('fixed42 archive DTO inherits format1 paths, roles, inventory and strict fields without widening old schemas',()=>{
 assert.equal(manifestSchema.safeParse(manifest()).success,true);
 assert.equal(backupSchema.safeParse(backup()).success,true);
 assert.equal(workspaceBackupManifestSchema.safeParse(manifest()).success,false);
 assert.equal(workspaceBackupResultSchema.safeParse(backup()).success,false);
 for(const change of [{databaseSchemaVersion:40},{databaseSchemaVersion:43},{formatVersion:2},{draftPolicy:'restored'},{draftPolicy:undefined},{extra:true},
  {inventory:{...inventory,totalIssues:1}},{entries:[{...entry,path:'payload/../workbench.sqlite'}]},
  {entries:[{...entry,path:'payload/media/unknown.txt'}]},{entries:[{...entry,role:'asset'}]}])
  assert.equal(manifestSchema.safeParse({...manifest(),...change}).success,false,JSON.stringify(change));
});

test('fixed42 manifest retains unique sorted paths, one database and aggregate payload bound',()=>{
 const media=index=>({path:`payload/media/00000000-0000-4000-8000-${String(index).padStart(12,'0')}.png`,role:'asset',bytes:1,sha256:hash});
 const sorted=[media(1),media(2),entry];
 assert.equal(manifestSchema.safeParse({...manifest(),entries:sorted}).success,true);
 for(const entries of [[entry,entry],sorted.toReversed(),[media(1),media(1),entry],[media(1)],
  [...Array.from({length:9},(_,index)=>({...media(index),bytes:8*1024*1024*1024})),entry]])
  assert.equal(manifestSchema.safeParse({...manifest(),entries}).success,false);
});

test('fixed43 offline results require exact42/43 pair and explicit exclusion with original publication semantics',()=>{
 const restore={...binding(),publication:'confirmed',fileCount:1,payloadBytes:1,databaseBytes:1,additionalDiskBytesEstimate:1,inventory};
 const status={...binding(),publication:'observed_guarded',durability:'not_reconfirmed'};
 assert.equal(restoreSchema.safeParse(restore).success,true);assert.equal(statusSchema.safeParse(status).success,true);
 assert.equal(workspaceRestoreOfflineResultSchema.safeParse(restore).success,false);
 for(const patch of [{sourceSchema:40},{databaseSchemaVersion:41},{profile:'restored-local-v9'},{draftPolicy:'included'},{draftPolicy:undefined},{extra:true}]){
  assert.equal(restoreSchema.safeParse({...restore,...patch}).success,false);
  assert.equal(statusSchema.safeParse({...status,...patch}).success,false);
 }
 assert.equal(statusSchema.safeParse({...status,durability:'confirmed'}).success,false);
 assert.equal(restoreSchema.safeParse({...restore,publication:'observed_guarded'}).success,false);
});
