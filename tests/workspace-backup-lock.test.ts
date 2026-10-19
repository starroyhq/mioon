import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate as pause} from 'node:timers/promises';
import {openStore,ownsStoreLock} from '../packages/business/src/db.ts';
import {acquireWorkspaceLock} from '../packages/business/src/workspace-lock.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import type {TestContext} from 'node:test';
function fixture(t: TestContext){const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-backup-lock-')),source=path.join(base,'source'),destination=path.join(base,'backup');const store=openStore(source);store.close();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,source,destination};}
for(const value of [String(process.pid),'2147483647','invalid-lock-token',''])test(`backup refuses existing lock ${JSON.stringify(value)} without takeover`,async t=>{
 const f=fixture(t),lock=path.join(f.source,'server.lock');fs.writeFileSync(lock,value,{mode:0o600});const before=fs.statSync(lock);
 await assert.rejects(createWorkspaceBackup(f),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_LOCKED');assert.equal(fs.readFileSync(lock,'utf8'),value);assert.equal(fs.statSync(lock).ino,before.ino);assert.equal(fs.existsSync(f.destination),false);
});
test('backend retains established stale-lock takeover and opaque db-bound ownership',t=>{
 const f=fixture(t),lock=path.join(f.source,'server.lock');fs.writeFileSync(lock,'invalid stale token',{mode:0o600});const store=openStore(f.source);t.after(()=>store.close());
 assert.equal(ownsStoreLock(store),true);assert.equal(ownsStoreLock({...store,db:{isOpen:true}} as unknown as Parameters<typeof ownsStoreLock>[0]),false);assert.equal(ownsStoreLock({...store,root:f.base}),false);
 const observer=openStore(f.source,{lock:false});assert.equal(ownsStoreLock(observer),false);observer.close();assert.equal(ownsStoreLock(store),true);
});
test('replaced or altered leases are permanently revoked and never delete replacement locks',t=>{
 const f=fixture(t),lock=path.join(f.source,'server.lock'),lease=acquireWorkspaceLock(f.source);assert.equal(lease.isOwned(),true);
 fs.renameSync(lock,`${lock}.old`);fs.writeFileSync(lock,String(process.pid),{mode:0o600});assert.equal(lease.isOwned(),false);lease.release();assert.equal(fs.existsSync(lock),true);
 fs.unlinkSync(lock);fs.renameSync(`${lock}.old`,lock);assert.equal(lease.isOwned(),false);lease.release();assert.equal(fs.existsSync(lock),true);
});
test('backup lease excludes backend startup and a concurrent backup',async t=>{
 const f=fixture(t),operation=createWorkspaceBackup(f);await pause();assert.throws(()=>openStore(f.source),/running backend/);
 await assert.rejects(createWorkspaceBackup({...f,destination:path.join(f.base,'second')}),(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_LOCKED');await operation;
 assert.equal(fs.existsSync(path.join(f.source,'server.lock')),false);
});
test('backup refuses publication after replacement of its lock and preserves that replacement',async t=>{
 const f=fixture(t),operation=createWorkspaceBackup(f);await pause();const lock=path.join(f.source,'server.lock');fs.renameSync(lock,`${lock}.old`);fs.writeFileSync(lock,'replacement',{mode:0o600});
 await assert.rejects(operation,(error: unknown)=>(error as {code?: string}).code==='WORKSPACE_BACKUP_LOCK_LOST');assert.equal(fs.readFileSync(lock,'utf8'),'replacement');assert.equal(fs.existsSync(path.join(f.destination,'COMPLETE.json')),false);
});
