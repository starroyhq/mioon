







import test from 'node:test';
import assert from 'node:assert/strict';

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';


import {startServer} from '../apps/server/src/index.ts';
import type {InspectApplication} from '../apps/server/src/index.ts';

import {schemaObjects} from './helpers/project-database.ts';

import {createClient} from '@mioon/client';

type Loose = Record<string, unknown>;
interface CliEnvelope {code: number|null; signal: string|null; envelope: Loose}
const root=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-backup-inspection-token-only';
const bounded=async<T>(promise: Promise<T>,label: string,ms=10000): Promise<T>=>{let timer: ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{if(timer)clearTimeout(timer);}};



test('new application HTTP refuses historical workspace inspection without application writes',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'mioon-backup-inspect-unavailable-'));let inspect!:InspectApplication;
 const server=await startServer({dataDir:directory,port:0,token,inspectApplication:read=>{inspect=read;}});
 t.after(async()=>{await server.close();rmSync(directory,{recursive:true,force:true});});
 const capture=()=>inspect(db=>({objects:schemaObjects(db),rows:schemaObjects(db).filter(row=>row.type==='table').map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()]),changes:db.prepare('SELECT total_changes() AS n').get()!.n}));
 const before=capture(),response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation:'workspace.backup.inspect',input:{}})});
 assert.equal(response.status,404);assert.equal((await response.json()).error.code,'UNKNOWN_OPERATION');
 assert.deepEqual(capture(),before,'rejected inspection creates no app row, task, receipt, schema or change mark');
});
test('shared client rejects retired inspection before any fetch or discovery', async () => {
 let calls = 0;
 const client = createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:token}, fetchImpl:async()=>{calls++;return new Response('{}');}});
 for (const operation of ['workspace.backup.status','workspace.backup.list','workspace.backup.create','workspace.backup.restore.stage','workspace.backup.inspect','workspace.restore.inspect']) {
  await assert.rejects(client.rpc(operation, {}), (error: unknown) => {
   const view = error as {code?: string; details?: {submissionMayHaveSucceeded?: boolean}};
   assert.equal(view.code, 'UNKNOWN_OPERATION'); assert.equal(view.details?.submissionMayHaveSucceeded, undefined); return true;
  });
 }
 assert.equal(calls, 0);
});
