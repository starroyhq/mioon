// Retained self-owned qualification: seed <record>, actual offline CLI in a
// separate process, then audit <record> <cli-result>. No GUI or media decoding.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {mock} from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {opacityUpgradeFixture} from '../../../tests/helpers/opacity-upgrade-fixture.mjs';
import {tree} from '../../../tests/helpers/opacity-backup-fixture.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup,withDisposableDatabase} from '../../../packages/business/src/workspace-backup.mjs';
import {captureOrdinaryUpgradePreservation} from '../../../packages/business/src/opacity-upgrade-database.ts';
import {reopenOpacityCandidateApplicationStore} from '../../../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../../../packages/business/src/opacity-candidate-services.ts';
import {calculateWorkspaceScope} from '../../../packages/contracts/src/workspace-scope.ts';
import {opacityWorkspaceUpgradeResultSchema} from '../../../packages/contracts/src/opacity-upgrade.ts';
import {onMediaProcess} from '../../../packages/business/src/media-processes.mjs';

const [phase,recordFile,resultFile]=process.argv.slice(2);assert.ok(['seed','audit'].includes(phase));assert.ok(recordFile);
let forbiddenAttempts=0;
const forbidden=()=>{forbiddenAttempts++;throw Error('No listener, native child or external fetch is permitted.');};
mock.method(http.Server.prototype,'listen',forbidden);
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])mock.method(cp,name,forbidden);
mock.method(globalThis,'fetch',forbidden);syncBuiltinESMExports();
const media=[],off=onMediaProcess(event=>media.push(event));
const hash=value=>createHash('sha256').update(value).digest('hex'),fileHash=file=>hash(fs.readFileSync(file));
const evidence=db=>Object.fromEntries(captureOrdinaryUpgradePreservation(db,phase==='audit'));
let store,services;
try {
  if(phase==='seed') {
    assert.equal(fs.existsSync(recordFile),false);
    // Deliberately retain this newly allocated fixture after the process ends.
    // The script owns it; no prior directory is selected or overwritten.
    const f=await opacityUpgradeFixture({after(){}});
    console.log(JSON.stringify({phase:'allocated-owned-fixture',base:f.base,source:f.source,backup:f.backup,destination:f.destination}));
    const database=path.join(f.source,'workbench.sqlite'),scope=calculateWorkspaceScope({channel:'web',root:f.source,
      directory:fs.lstatSync(f.source),db:fs.lstatSync(database)});
    const lastProject={version:1,workspaceScope:scope,revision:7,projectId:f.projectId,updatedAt:'2026-10-16T00:00:00.000Z'};
    fs.writeFileSync(path.join(f.source,'last-project-v1.json'),JSON.stringify(lastProject)+'\n',{mode:0o600});
    fs.writeFileSync(path.join(f.source,'local-drafts-v1.json'),JSON.stringify({version:2,workspaceScope:scope,
      entries:[{projectId:f.projectId,timelineId:f.timelineId,clipId:f.clipId,revision:2,draft:null}]})+'\n',{mode:0o600});
    const sourceDbHash=fileHash(database);
    const preservation=await withDisposableDatabase({database,databaseRoot:f.source,temporaryParent:f.base,databasePrivate:false,check(){}},evidence);
    const backup=await createWorkspaceBackup({source:f.source,destination:f.backup}),verified=await verifyWorkspaceBackup({directory:f.backup});
    assert.equal(verified.databaseSchemaVersion,40);assert.equal(verified.inventory.complete,true);assert.equal(fileHash(database),sourceDbHash);
    assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
    const record={base:f.base,source:f.source,backup:f.backup,destination:f.destination,projectId:f.projectId,clipId:f.clipId,
      relativePath:f.relativePath,mediaSha256:hash(f.mediaBytes),sourceDbHash,preservation,lastProject,backupResult:backup,
      sourceTree:tree(f.source),backupTree:tree(f.backup),seed:{pid:process.pid,passed:true,sourceClosed:true}};
    fs.writeFileSync(recordFile,JSON.stringify(record,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({phase,pid:process.pid,source:f.source,backup:f.backup,destination:f.destination,passed:true}));
  } else {
    const record=JSON.parse(fs.readFileSync(recordFile,'utf8')),wire=JSON.parse(fs.readFileSync(resultFile,'utf8'));
    assert.equal(wire.ok,true);const result=opacityWorkspaceUpgradeResultSchema.parse(wire.data);
    assert.equal(result.sourceBackupId,record.backupResult.backupId);assert.equal(result.sourceDbHash,record.sourceDbHash);
    assert.equal(result.targetDbHash,fileHash(path.join(record.destination,'workbench.sqlite')));
    assert.equal(fileHash(path.join(record.destination,record.relativePath)),record.mediaSha256);
    assert.deepEqual(tree(record.source),record.sourceTree);assert.deepEqual(tree(record.backup),record.backupTree);
    assert.equal(fs.existsSync(path.join(record.destination,'local-drafts-v1.json')),false);
    const metadata=JSON.parse(fs.readFileSync(path.join(record.destination,'UPGRADE.json'),'utf8'));
    assert.equal(metadata.record,'prepared-provenance');assert.equal(Object.hasOwn(metadata,'publication'),false);
    assert.deepEqual(metadata.excludedEmptyCompanions,['local-drafts-v1.json']);
    const lastProject=JSON.parse(fs.readFileSync(path.join(record.destination,'last-project-v1.json'),'utf8'));
    assert.deepEqual({...lastProject,workspaceScope:record.lastProject.workspaceScope},record.lastProject);
    assert.notEqual(lastProject.workspaceScope,record.lastProject.workspaceScope);
    assert.equal(lastProject.workspaceScope,calculateWorkspaceScope({channel:'web',root:record.destination,
      directory:fs.lstatSync(record.destination),db:fs.lstatSync(path.join(record.destination,'workbench.sqlite'))}));
    store=reopenOpacityCandidateApplicationStore(record.destination);services=createOpacityCandidateApplicationServices(store);
    assert.deepEqual(evidence(store.db),record.preservation);
    const page=await services.call('project.get',{projectId:record.projectId});
    assert.equal(page.project.id,record.projectId);assert.equal(page.timeline.clips[0].id,record.clipId);
    assert.equal(page.timeline.clips[0].name,'Acknowledged 界');
    await services.drain();services=undefined;store.close();store=undefined;
    assert.equal(fs.existsSync(path.join(record.destination,'server.lock')),false);
    assert.deepEqual(tree(record.source),record.sourceTree);assert.deepEqual(tree(record.backup),record.backupTree);
    assert.equal(forbiddenAttempts,0);assert.deepEqual(media,[]);
    record.audit={pid:process.pid,passed:true,normal42ReopenAndClose:true,projectGet:true,allRawRowsPreserved:true,
      sourceAndBackupUnchanged:true,lastProjectValuesPreservedAndScopeRebound:true,emptyDraftExplicitlyExcluded:true,
      noListenNativeExternalAttempts:forbiddenAttempts,mediaProcesses:media.length,result};
    fs.writeFileSync(recordFile,JSON.stringify(record,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(record.audit));
  }
} finally {await services?.drain();store?.close();off();mock.restoreAll();syncBuiltinESMExports();}
