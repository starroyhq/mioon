import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {onMediaProcess, type MediaProcessEvent} from '../packages/business/src/media-processes.ts';

const snapshot = {prompt:'Synthetic ownership fixture',model:'mock-motion-v1',aspectRatio:'9:16',duration:2,
  parameters:{scenario:'success',delayMs:0},referenceAssets:[]};
const unverified = {code:'PROJECT_STORE_UNVERIFIED'};
const partialBytes = Buffer.from('Synthetic mock renderer output; not an actual video.');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function fixture(t: test.TestContext) {
  const directory = realpathSync(await mkdtemp(path.join(tmpdir(),'mioon-mock-owner-')));
  const root = path.join(directory,'kernel'), store = openStore(root);
  t.after(async () => {store.close();await rm(directory,{recursive:true,force:true});});
  return {directory,root,store,provider:createMockProvider({db:store.db,root})};
}

async function renderer(t: test.TestContext, directory: string) {
  const executable = path.join(directory,'synthetic-ffmpeg'), witness = path.join(directory,'render-witness.json');
  await writeFile(executable,`#!${process.execPath}
import {writeFileSync,readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
if(process.argv.includes('-filters'))process.stdout.write('Filters:\\n .. scale V->V Synthetic scale.\\n .. drawtext V->V Synthetic drawtext.\\n');
else {
  const file=process.argv.at(-1),bytes=Buffer.from(${JSON.stringify(partialBytes.toString('base64'))},'base64');
  writeFileSync(file,bytes,{flag:'wx'});
  writeFileSync(${JSON.stringify(witness)},JSON.stringify({file,bytes:statSync(file).size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}));
}
`,{mode:0o700,flag:'wx'});
  const previous = process.env.MIOON_FFMPEG_PATH;
  process.env.MIOON_FFMPEG_PATH = executable;
  t.after(() => {if(previous===undefined)delete process.env.MIOON_FFMPEG_PATH;else process.env.MIOON_FFMPEG_PATH=previous;});
  return {executable,witness};
}

function revokeOnStart(t: test.TestContext, store: ReturnType<typeof openStore>) {
  const events: MediaProcessEvent[] = [];
  let closed = false, closeError: unknown;
  const remove = onMediaProcess(event => {
    if(event.kind!=='ffmpeg')return;
    events.push(event);
    if(event.type==='started'&&!closed) {
      try {store.close();closed=true;} catch(error) {closeError=error;}
    }
  });
  t.after(() => {remove();});
  return {events,check:()=>{assert.equal(closeError,undefined);assert.equal(closed,true);
    assert.equal(events.filter(event=>event.type==='started').length,1);
    assert.equal(events.filter(event=>event.type==='exited').length,1);}};
}

test('mock submit cannot write its ledger after beforeSubmit closes the real owner',async t=>{
  const f = await fixture(t);
  await assert.rejects(f.provider.submit(snapshot,{requestId:randomUUID(),beforeSubmit:()=>f.store.close()}),unverified);
  const reopened = openStore(f.root);
  try {
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get()!.n,0);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM mock_provider_tasks').get()!.n,0);
  } finally {reopened.close();}
});

test('mock poll rejects owner loss during the actual renderer capability await',async t=>{
  const f = await fixture(t), tool = await renderer(t,f.directory);
  const accepted = await f.provider.submit(snapshot,{requestId:randomUUID()});
  const observed = revokeOnStart(t,f.store);
  await assert.rejects(f.provider.poll(accepted.providerJobId),unverified);
  observed.check();
  await assert.rejects(readFile(tool.witness),{code:'ENOENT'},'capability check must not render output');
  const reopened = openStore(f.root);
  try {
    const current = createMockProvider({db:reopened.db,root:f.root});
    assert.deepEqual(current.stats(),{submissionCount:1,taskCount:1,downloadAttempts:0,pollCount:1});
  } finally {reopened.close();}
});

test('mock renderer owner loss rejects after real partial bytes and never publishes the destination',async t=>{
  const f = await fixture(t), tool = await renderer(t,f.directory);
  const accepted = await f.provider.submit(snapshot,{requestId:randomUUID()});
  const destination = path.join(f.root,'media','never-published.mp4'), before = (await readdir(path.dirname(destination))).sort();
  const observed = revokeOnStart(t,f.store);
  await assert.rejects(f.provider.download(accepted.providerJobId,destination),unverified);
  observed.check();
  const witness: unknown = JSON.parse(await readFile(tool.witness,'utf8'));
  assert.ok(witness&&typeof witness==='object'&&'file' in witness&&typeof witness.file==='string');
  assert.equal(path.dirname(witness.file),path.dirname(destination));
  assert.match(path.basename(witness.file),/^never-published\.mp4\.[0-9a-f-]+\.partial\.mp4$/u);
  assert.deepEqual(witness,{file:witness.file,bytes:partialBytes.length,sha256:digest(partialBytes)});
  await assert.rejects(readFile(destination),{code:'ENOENT'});
  await assert.rejects(readFile(witness.file),{code:'ENOENT'},'owned partial is cleaned after the exact child closes');
  assert.deepEqual((await readdir(path.dirname(destination))).sort(),before);
});

test('mock managed destination rechecks the owner after realpath before mkdir or spawn',async t=>{
  const f = await fixture(t);
  await renderer(t,f.directory);
  const accepted = await f.provider.submit(snapshot,{requestId:randomUUID()});
  // Closing the actual SQLite owner may remove its exact rollback journal.
  // No other existing entry or newly created directory is exempted.
  const journal = path.basename(f.store.projectFile)+'-journal';
  const entries = async () => (await readdir(f.root)).filter(name=>name!==journal).sort();
  const destination = path.join(f.root,'must-not-create','output.mp4'), before = await entries();
  const events: MediaProcessEvent[] = [], remove = onMediaProcess(event=>events.push(event));
  t.after(() => {remove();});
  const pending = f.provider.download(accepted.providerJobId,destination);
  // realpath is an actual filesystem await; the queued revocation runs before
  // its continuation, without replacing fs methods or manufacturing a DB.
  let closed = false;
  queueMicrotask(()=>{f.store.close();closed=true;});
  await assert.rejects(pending,unverified);
  assert.equal(closed,true);
  assert.deepEqual(await entries(),before);
  await assert.rejects(readdir(path.dirname(destination)),{code:'ENOENT'});
  assert.deepEqual(events,[]);
});
