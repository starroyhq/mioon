import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startOwnedServer} from './helpers/owned-test-server.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const testsDirectory = path.join(root, 'tests');

test('concurrent owned fixtures each answer only their own server', {timeout: 90_000}, async t => {
  const directories = await Promise.all([1, 2, 3].map(() => mkdtemp(path.join(tmpdir(), 'mioon-owned-server-'))));
  const tokens = ['owned-fixture-token-000000000001', 'owned-fixture-token-000000000002', 'owned-fixture-token-000000000003'];
  const servers = await Promise.all(tokens.map((token, index) => startOwnedServer({repo: root, root: directories[index]!, token})));
  t.after(async () => {
    await Promise.all(servers.map(server => server.stop()));
    await Promise.all(directories.map(directory => rm(directory, {recursive: true, force: true})));
  });
  assert.equal(new Set(servers.map(server => server.port)).size, servers.length, 'each fixture must own a distinct port');
  assert.equal(new Set(servers.map(server => server.url)).size, servers.length, 'each fixture must report a distinct URL');
  for (const [index, server] of servers.entries()) {
    assert.equal(server.child.exitCode, null, `fixture ${index} stayed alive`);
    const own = await fetch(server.url + '/api/ui-preferences', {headers: {authorization: `Bearer ${tokens[index]}`}});
    assert.equal(own.status, 200, `fixture ${index} accepts its own token`);
    for (const [other, token] of tokens.entries()) {
      if (other === index) continue;
      const foreign = await fetch(server.url + '/api/ui-preferences', {headers: {authorization: `Bearer ${token}`}});
      assert.equal(foreign.status, 401, `fixture ${index} rejects fixture ${other}'s token instead of answering as it`);
      assert.equal(foreign.status, 401, `fixture ${index} rejects a foreign instance`);
    }
  }
});

test('no test reserves a free port before handing it to a child process', async () => {
  const files = (await readdir(testsDirectory, {recursive: true}))
    .map(file => path.join(testsDirectory, file))
    .filter(file => file.endsWith('.test.ts') || file.endsWith('.test.mjs'));
  const forbidden = new RegExp('free' + 'Port' + '\\s*\\(');
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, forbidden, `${path.relative(root, file)} must let the server child bind PORT=0 and report its own port`);
  }
});
