import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseBackupArguments} from '../apps/cli/src/backup.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('restore instructions use actual strict offline flags for known-ID and total-output-loss observation',()=>{
 const help=read('apps/cli/src/backup.mjs'),docs=read('docs/CLI.md');
 assert.deepEqual(parseBackupArguments(['restore-status','--directory','/original-backup','--destination','/new-workspace']),{command:'restore-status',directory:'/original-backup',destination:'/new-workspace'});
 const restorationId='10000000-0000-4000-8000-000000000001',sourceBackupId='20000000-0000-4000-8000-000000000001',manifestHash='a'.repeat(64),sourceDbHash='b'.repeat(64);
 const args=['restore-status','--destination','/new-workspace','--restoration-id',restorationId,'--backup-id',sourceBackupId,'--manifest-hash',manifestHash,'--source-db-hash',sourceDbHash];
 assert.deepEqual(parseBackupArguments(args),{command:'restore-status',destination:'/new-workspace',restorationId,sourceBackupId,manifestHash,sourceDbHash});
 assert.throws(()=>parseBackupArguments(args.map(value=>value===restorationId?'invalid':value)),{code:'VALIDATION_ERROR'});
 for(const flag of ['--workspace-origin','--directory','--destination','--restoration-id','--backup-id','--manifest-hash','--source-db-hash'])assert.ok(docs.includes(flag),flag);
 assert.ok(!docs.includes('--source-backup-id'));assert.match(help,/read-only guarded-schema and provenance observation/);assert.match(help,/does not repair locks or sidecars, resume work, or prove/);assert.match(docs,/observed_guarded/);assert.match(docs,/not_reconfirmed/);
});

test('restored guides preserve privacy, disabled execution, recursive-backup and provenance caveats',()=>{
 const contract=read('docs/WORKSPACE-RESTORE.md');
 for(const text of ['format1','source pathname','observed_guarded','not_reconfirmed','512 MiB','20,000','64 MiB','same-user/root','frozen-entrypoint','not execution of complete historical packaged binaries','restored schema25 backup.create is explicitly unavailable'])assert.ok(contract.includes(text),text);
 assert.match(contract,/No source SQL connection/);
 assert.match(read('docs/CLI.md'),/plain|plaintext/);
 const skill=read('skills/mioon/SKILL.md');assert.match(skill,/never infer or silently replace it after reconnect/);assert.match(skill,/does not restore inherited execution authority/);
});

test('restore documentation does not add an HTTP/MCP path executor or built-in Agent capability',()=>{
 for(const file of ['docs/API.md','docs/MCP.md']){
  const text=read(file);assert.match(text,/workspace[._]restore[._]inspect/);assert.match(text,/expectedWorkspaceOrigin|--workspace-origin/);assert.match(text,/no|No/);
 }
 assert.match(read('docs/API.md'),/No\s+HTTP endpoint receives restore filesystem paths/);
 assert.match(read('docs/MCP.md'),/no MCP filesystem executor/);
});

test('new restore guide local links resolve without relying on ignored evidence files',()=>{
 for(const file of ['docs/WORKSPACE-RESTORE.md','docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md'])for(const match of read(file).matchAll(/\]\(([^)]+)\)/g)){
  const target=match[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;
  assert.ok(!target.includes('evidence/'));assert.ok(fs.existsSync(path.resolve(root,path.dirname(file),target)),`${file}: ${target}`);
 }
});
