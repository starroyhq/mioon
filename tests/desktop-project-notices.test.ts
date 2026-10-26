import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir, lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PROJECT_NOTICES, stageProjectNotices} from '../apps/desktop/scripts/stage-project-notices.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-project-notices-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source'), destination = path.join(root, 'staging/licenses');
  await mkdir(source);
  for (const file of PROJECT_NOTICES) await writeFile(path.join(source, file.source), `Synthetic ${file.source}\r\n声明\n`);
  return {source, destination};
}

test('desktop staging retains project declarations byte-for-byte alongside existing third-party notices', async t => {
  const {source, destination} = await fixture(t);
  await mkdir(destination, {recursive: true});
  const thirdParty = path.join(destination, 'shadcn-ui-LICENSE.md');
  await writeFile(thirdParty, 'Existing third-party notice stays unchanged.');
  await stageProjectNotices(source, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['Mioon-LICENSE.txt', 'Mioon-NOTICE.txt', 'Mioon-THIRD-PARTY-NOTICES.md', 'shadcn-ui-LICENSE.md']);
  for (const file of PROJECT_NOTICES) assert.deepEqual(await readFile(path.join(destination, file.output)), await readFile(path.join(source, file.source)));
  assert.equal(await readFile(thirdParty, 'utf8'), 'Existing third-party notice stays unchanged.');
});

for (const file of PROJECT_NOTICES) for (const kind of ['missing', 'empty'] as const) test(`desktop staging rejects ${kind} ${file.source} before writing project notices`, async t => {
  const {source, destination} = await fixture(t);
  if (kind === 'missing') await rm(path.join(source, file.source));
  else await writeFile(path.join(source, file.source), '');
  await assert.rejects(stageProjectNotices(source, destination));
  await assert.rejects(lstat(destination), {code: 'ENOENT'});
});

test('desktop staging never overwrites a preexisting project notice', async t => {
  const {source, destination} = await fixture(t);
  await mkdir(destination, {recursive: true});
  const existing = path.join(destination, 'Mioon-LICENSE.txt');
  await writeFile(existing, 'Preserve existing bytes.');
  await assert.rejects(stageProjectNotices(source, destination), {code: 'EEXIST'});
  assert.equal(await readFile(existing, 'utf8'), 'Preserve existing bytes.');
});
