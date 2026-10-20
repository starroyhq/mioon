import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {schemas,operationEffect,WORKSPACE_BACKUP_FORMAT,WORKSPACE_BACKUP_LIMITS,workspaceBackupManifestSchema,workspaceBackupCompleteSchema,workspaceBackupInspectionSchema,isWorkspaceBackupPayloadPath} from '@mioon/contracts';
interface ManifestView {format: string; formatVersion: number; backupId: string; createdAt: string; applicationVersion: string; databaseSchemaVersion: number; scope: string; restore?: boolean;
 entries: Array<{path: string; role: string; bytes: number; sha256: string}>;
 inventory: {complete: boolean; totalIssues: number; issues: Array<{code: string; path?: string}>; truncated: boolean}}
const manifest=(): ManifestView => ({format:WORKSPACE_BACKUP_FORMAT,formatVersion:1,backupId:randomUUID(),createdAt:'2026-10-12T02:00:00.000Z',applicationVersion:'0.4.1',databaseSchemaVersion:24,scope:'whole_workspace',entries:[{path:'payload/workbench.sqlite',role:'database',bytes:4096,sha256:'a'.repeat(64)}],inventory:{complete:true,totalIssues:0,issues:[],truncated:false}});
test('strict no-path inspection stays read-only beside explicit managed backup actions',()=>{
 assert.deepEqual(schemas['workspace.backup.inspect'].parse({}),{});
 for(const input of [{source:'/private'},{destination:'/tmp/a'},{projectId:randomUUID()},{restore:true},{requestId:'request-key'}])assert.equal(schemas['workspace.backup.inspect'].safeParse(input).success,false);
 for(const op of ['workspace.backup.verify','workspace.backup.restore'])assert.equal(Object.hasOwn(schemas,op),false);
 const requestId=randomUUID(),backupId=randomUUID();
 assert.deepEqual(schemas['workspace.backup.create'].parse({requestId}),{requestId});
 assert.deepEqual(schemas['workspace.backup.restore.stage'].parse({requestId,backupId,confirmation:'RESTORE_BACKUP'}),{requestId,backupId,confirmation:'RESTORE_BACKUP'});
 for(const input of [{},{requestId,source:'/private'},{requestId,destination:'/tmp/a'},{requestId,path:'/tmp/a'},{requestId,backupId}])assert.equal(schemas['workspace.backup.create'].safeParse(input).success,false);
 for(const input of [{requestId,backupId},{requestId,backupId,confirmation:'RESTORE_BACKUP',source:'/private'},{requestId,backupId,confirmation:'RESTORE_BACKUP',destination:'/tmp/a'}])assert.equal(schemas['workspace.backup.restore.stage'].safeParse(input).success,false);
 for(const op of ['workspace.backup.create','workspace.backup.restore.stage']){const managed=operationEffect(op);assert.equal(managed.readOnly,false);assert.equal(managed.fileWrite,true);assert.equal(managed.idempotent,true);for(const key of ['databaseWrite','externalIO','localProcess','paidGeneration','openWorld'])assert.equal((managed as unknown as Record<string,boolean>)[key],false,key);}
 const effect=operationEffect('workspace.backup.inspect');assert.equal(effect.readOnly,true);assert.equal(effect.idempotent,true);
 for(const key of ['databaseWrite','fileWrite','externalIO','localProcess','paidGeneration','destructive','openWorld'])assert.equal((effect as unknown as Record<string, boolean>)[key],false,key);
});
test('manifest pins one raw database and rejects paths, duplicate entries, role changes and unbounded sizes',()=>{
 assert.equal(workspaceBackupManifestSchema.safeParse(manifest()).success,true);
 const id=randomUUID();for(const file of [`payload/media/${id}.png`,`payload/media/result-${id}.mp4.part.mp4`,`payload/media/export-${id}-${randomUUID()}.mp4`,`payload/frame-staging/${id}.json`])assert.equal(isWorkspaceBackupPayloadPath(file),true,file);
 for(const file of ['../workbench.sqlite','/payload/workbench.sqlite','payload/../access-token','payload/agent-settings/settings.json','payload/media/../../secret','payload\\workbench.sqlite','https://example.test/p.png','payload/media/no-id.png'])assert.equal(isWorkspaceBackupPayloadPath(file),false,file);
 for(const mutate of ([v=>v.entries.push({...v.entries[0]}),v=>{v.entries=[];},v=>{v.entries[0]!.role='asset';},v=>{v.entries[0]!.bytes=WORKSPACE_BACKUP_LIMITS.databaseBytes+1;},v=>{v.entries[0]!.sha256='A'.repeat(64);},v=>{v.scope='project';},v=>{v.restore=true;},v=>{v.databaseSchemaVersion=25;}] as Array<(v: ManifestView)=>void>)){const v=manifest();mutate(v);assert.equal(workspaceBackupManifestSchema.safeParse(v).success,false);}
});
test('missing or retained partial source evidence cannot masquerade as clean inventory',()=>{
 const v=manifest();v.inventory={complete:false,totalIssues:1,issues:[{code:'PARTIAL_RESULT_PRESERVED',path:`payload/image-staging/${randomUUID()}.png`}],truncated:false};assert.equal(workspaceBackupManifestSchema.safeParse(v).success,true);
 for(const patch of [{complete:true},{totalIssues:0},{truncated:true}])assert.equal(workspaceBackupManifestSchema.safeParse({...v,inventory:{...v.inventory,...patch}}).success,false);
 assert.equal(workspaceBackupManifestSchema.safeParse({...v,inventory:{complete:false,totalIssues:101,issues:[],truncated:true}}).success,true);
});
test('complete marker must contain exact binding fields and cannot grant restoration or credentials',()=>{
 const v={format:WORKSPACE_BACKUP_FORMAT,formatVersion:1,backupId:randomUUID(),manifestSha256:'b'.repeat(64),fileCount:1,payloadBytes:4096};assert.equal(workspaceBackupCompleteSchema.safeParse(v).success,true);
 for(const patch of [{fileCount:20001},{payloadBytes:WORKSPACE_BACKUP_LIMITS.totalBytes+1},{manifestSha256:'bad'},{restoration:'ready'},{apiKey:'synthetic'}])assert.equal(workspaceBackupCompleteSchema.safeParse({...v,...patch}).success,false);
});
test('inspection never claims a running backend is cold-ready and does not invent unknown counts',()=>{
 const counts={projects:0,assets:0,videoTasks:0,imageTasks:0,frameTasks:0,exports:0},unresolved={videoTasks:0,imageTasks:0,frameTasks:0,exports:0,agentRuns:0,agentProposals:0,editTasks:0};
 const v={formatVersion:1,scope:'whole_workspace',captureReady:false,reason:'BACKEND_RUNNING',databaseSchemaVersion:24,counts,unresolved,limits:{...WORKSPACE_BACKUP_LIMITS},inspectionComplete:true,issues:[]};assert.equal(workspaceBackupInspectionSchema.safeParse(v).success,true);
 assert.equal(workspaceBackupInspectionSchema.safeParse({...v,captureReady:true}).success,false);
 assert.equal(workspaceBackupInspectionSchema.safeParse({...v,counts:{...counts,assets:null}}).success,false);
 assert.equal(workspaceBackupInspectionSchema.safeParse({...v,inspectionComplete:false,counts:{...counts,assets:null},issues:['ROW_LIMIT']}).success,true);
 assert.equal(workspaceBackupInspectionSchema.safeParse({...v,source:'/private/path'}).success,false);
});
