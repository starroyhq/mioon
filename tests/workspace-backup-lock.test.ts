

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';

import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {acquireWorkspaceLock} from '../packages/business/src/workspace-lock.ts';

import type {TestContext} from 'node:test';
function fixture(t: TestContext){const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-backup-lock-')),source=path.join(base,'source'),destination=path.join(base,'backup');fs.mkdirSync(source,{mode:0o700});t.after(()=>fs.rmSync(base,{recursive:true,force:true}));return {base,source,destination};}

test('backend retains established stale-lock takeover and opaque db-bound ownership',t=>{
 const f=fixture(t),lock=path.join(f.source,'server.lock');fs.writeFileSync(lock,'invalid stale token',{mode:0o600});
 const lease=acquireWorkspaceLock(f.source),store=openStore(f.source);t.after(()=>{store.close();lease.release();});
 assert.equal(lease.isOwned(),true);assert.equal(ownsStoreLock(store),true);
 assert.equal(ownsStoreLock({...store,db:{isOpen:true}} as unknown as Parameters<typeof ownsStoreLock>[0]),false);
 assert.equal(ownsStoreLock({...store,root:f.base}),false);
 assert.throws(()=>openStore(f.source),{code:'PROJECT_LOCKED'});
 assert.equal(ownsStoreLock(store),true);

});
test('replaced or altered leases are permanently revoked and never delete replacement locks',t=>{
 const f=fixture(t),lock=path.join(f.source,'server.lock'),lease=acquireWorkspaceLock(f.source);assert.equal(lease.isOwned(),true);
 fs.renameSync(lock,`${lock}.old`);fs.writeFileSync(lock,String(process.pid),{mode:0o600});assert.equal(lease.isOwned(),false);lease.release();assert.equal(fs.existsSync(lock),true);
 fs.unlinkSync(lock);fs.renameSync(`${lock}.old`,lock);assert.equal(lease.isOwned(),false);lease.release();assert.equal(fs.existsSync(lock),true);
});
