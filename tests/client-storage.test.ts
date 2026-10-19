import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, chown, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createClient} from '@mioon/client';
import {ConnectionError, connectionSource, resolveConnection, validateLocalUrl} from '@mioon/client/connection';

const TOKEN = 'synthetic-client-storage-token-only';
const posix: {skip: string | false} = {skip:process.platform === 'win32' ? 'POSIX permission fixture; native Windows fails closed below' : false};

interface Descriptor {version: number; url: string; tokenFile: string; pid: number}
async function fixture(t: TestContext): Promise<{root: string; tokenFile: string; connectionFile: string; descriptor: Descriptor}> {
  // Canonicalize only the synthetic fixture location, not user-supplied paths.
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'wb-client-storage-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const tokenFile = path.join(root, 'mcp-token');
  const connectionFile = path.join(root, 'mcp-connection.json');
  await writeFile(tokenFile, TOKEN + '\n', {mode:0o600});
  const descriptor: Descriptor = {version:1, url:'http://127.0.0.1:4318', tokenFile, pid:process.pid};
  await writeFile(connectionFile, JSON.stringify(descriptor), {mode:0o600});
  return {root, tokenFile, connectionFile, descriptor};
}

function safeError(...privateValues: string[]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.code, 'CONNECTION_CONFIG_ERROR');
    const diagnostic = `${error.message}\n${JSON.stringify(error)}`;
    for (const value of [TOKEN, ...privateValues]) assert.equal(diagnostic.includes(value), false, 'connection diagnostics must redact private values');
    assert.equal(error.cause, undefined, 'raw filesystem failures must not escape through a cause');
    return true;
  };
}

test('environment credentials keep current names, source reporting and loopback-origin validation', async () => {
  const env = {MIOON_TOKEN:TOKEN, MIOON_BASE_URL:'http://localhost:4321'};
  assert.deepEqual(await resolveConnection(env), {base:'http://localhost:4321', token:TOKEN});
  assert.deepEqual(await resolveConnection({...env, MIOON_CONNECTION_FILE:'unused-environment-mode-file'}), {base:'http://localhost:4321', token:TOKEN});
  assert.equal(connectionSource(env), 'environment-token');
  assert.equal(connectionSource({MIOON_TOKEN_FILE:'synthetic'}), 'private-token-file');
  assert.equal(connectionSource({MIOON_CONNECTION_FILE:'synthetic'}), 'desktop-descriptor');
  assert.equal(connectionSource({WORKBENCH_TOKEN:TOKEN}), 'unconfigured');
  await assert.rejects(resolveConnection({WORKBENCH_TOKEN:TOKEN}), safeError());
  for (const base of ['https://localhost:4318', 'http://remote.invalid', 'http://user:pass@localhost:4318', 'http://localhost/path', 'http://localhost/?secret=value', 'http://localhost/#fragment']) {
    assert.throws(() => validateLocalUrl(base), safeError());
  }
  for (const token of ['short', 'x'.repeat(4097), TOKEN + '\nembedded', TOKEN + '\0']) {
    await assert.rejects(resolveConnection({MIOON_TOKEN:token}), safeError(token));
  }
  assert.equal((await resolveConnection({MIOON_TOKEN:'x'.repeat(4096)})).token.length, 4096);
});

test('private file and descriptor modes preserve rotation on every request without a live backend', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile, descriptor} = await fixture(t);
  let expected = TOKEN, expectedBase = descriptor.url;
  const authorizations: string[] = [];
  const client = createClient({env:{MIOON_CONNECTION_FILE:connectionFile}, fetchImpl:(async (url: string, options: {headers: Record<string, string>}) => {
    assert.equal(url, expectedBase + '/api/rpc');
    authorizations.push(options.headers.authorization!);
    assert.equal(options.headers.authorization, `Bearer ${expected}`);
    return {ok:true, status:200, json:async () => ({ok:true, data:[]})};
  }) as never});
  assert.deepEqual(await resolveConnection({MIOON_TOKEN_FILE:tokenFile}), {base:descriptor.url, token:TOKEN});
  assert.deepEqual(await client.rpc('project.list'), []);
  expected = TOKEN + '-rotated';
  const replacement = path.join(root, '.mcp-token.synthetic.tmp');
  await writeFile(replacement, expected, {mode:0o600});
  await rename(replacement, tokenFile);
  assert.deepEqual(await client.rpc('project.list'), []);
  expectedBase = 'http://localhost:45123';
  const nextDescriptor = path.join(root, '.mcp-connection.json.synthetic.tmp');
  await writeFile(nextDescriptor, JSON.stringify({...descriptor, url:expectedBase}), {mode:0o600});
  await rename(nextDescriptor, connectionFile);
  assert.deepEqual(await client.rpc('project.list'), []);
  assert.equal(authorizations.length, 3);
  await chmod(tokenFile, 0o644);
  await assert.rejects(client.rpc('project.list'), {code:'CONNECTION_CONFIG_ERROR'});
  assert.equal(authorizations.length, 3, 'unsafe rotated credentials must fail before any request');
});

test('descriptor shape, sibling token binding, process liveness and mixed modes stay enforced', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile, descriptor} = await fixture(t);
  for (const malformed of [null, [], {...descriptor, version:2}, {...descriptor, pid:0}, {...descriptor, pid:1.5}, {...descriptor, tokenFile:'relative-token'}]) {
    await writeFile(connectionFile, JSON.stringify(malformed));
    await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
  }
  await writeFile(connectionFile, JSON.stringify({...descriptor, tokenFile:path.join(root, 'nested', 'mcp-token')}));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), /beside/);
  await writeFile(connectionFile, JSON.stringify({...descriptor, pid:2147483647}));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), /not running/);
  await writeFile(connectionFile, JSON.stringify({...descriptor, url:'http://remote.invalid'}));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
  await writeFile(connectionFile, JSON.stringify(descriptor));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile, MIOON_BASE_URL:descriptor.url}), /mix/);
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile, MIOON_TOKEN_FILE:tokenFile}), /mix/);
  await assert.rejects(resolveConnection({MIOON_TOKEN:TOKEN, MIOON_TOKEN_FILE:tokenFile}), /not both/);
});

test('missing and malformed private files return sanitized connection errors', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:path.join(root, 'missing-token')}), safeError(root));
  await writeFile(connectionFile, `invalid-json-${TOKEN}`);
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
  await writeFile(tokenFile, 'short');
  await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:tokenFile}), safeError(root));
});

test('token and descriptor reads retain byte caps, including trailing whitespace', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile, descriptor} = await fixture(t);
  await writeFile(tokenFile, 'x'.repeat(4096));
  assert.equal((await resolveConnection({MIOON_TOKEN_FILE:tokenFile})).token.length, 4096);
  const descriptorText = JSON.stringify(descriptor);
  await writeFile(connectionFile, descriptorText.padEnd(8192, ' '));
  assert.equal((await resolveConnection({MIOON_CONNECTION_FILE:connectionFile})).token.length, 4096);
  await writeFile(connectionFile, descriptorText.padEnd(8193, ' '));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
  await writeFile(tokenFile, TOKEN.padEnd(8193, ' '));
  await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:tokenFile}), safeError(root));
});

for (const mode of [0o640, 0o604, 0o666]) {
  test(`client refuses broad credential permission mode ${mode.toString(8)} without repair`, posix, async (t: TestContext) => {
    const {root, tokenFile, connectionFile} = await fixture(t);
    for (const file of [tokenFile, connectionFile]) {
      await chmod(file, mode);
      await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
      assert.equal((await lstat(file)).mode & 0o777, mode);
      await chmod(file, 0o600);
    }
  });
}

for (const mode of [0o755, 0o777]) {
  test(`client refuses non-private parent mode ${mode.toString(8)} without repair`, posix, async (t: TestContext) => {
    const {root, tokenFile, connectionFile} = await fixture(t);
    await chmod(root, mode);
    await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:tokenFile}), safeError(root));
    await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
    assert.equal((await lstat(root)).mode & 0o777, mode);
    assert.equal(await readFile(tokenFile, 'utf8'), TOKEN + '\n');
  });
}

test('client refuses token/descriptor symbolic links and multiply linked files', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  for (const [file, variable] of [[tokenFile, 'MIOON_TOKEN_FILE'], [connectionFile, 'MIOON_CONNECTION_FILE']]) {
    const alias = file + '.alias';
    await symlink(file, alias);
    await assert.rejects(resolveConnection({[variable]:alias}), safeError(root));
    await rm(alias);
    await link(file, alias);
    await assert.rejects(resolveConnection({[variable]:file}), safeError(root));
    await rm(alias);
  }
});

test('client refuses non-regular credential entries', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  for (const [file, variable] of [[tokenFile, 'MIOON_TOKEN_FILE'], [connectionFile, 'MIOON_CONNECTION_FILE']]) {
    await rm(file);
    await mkdir(file, {mode:0o700});
    await assert.rejects(resolveConnection({[variable]:file}), safeError(root));
  }
});

test('client refuses symbolic-link ancestors even when final credentials are private', posix, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  const alias = path.join(root, 'linked-parent');
  await symlink(root, alias, 'dir');
  await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:path.join(alias, path.basename(tokenFile))}), safeError(root));
  await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:path.join(alias, path.basename(connectionFile))}), safeError(root));
});

test('client refuses a non-sticky writable ancestor of a private parent', posix, async (t: TestContext) => {
  const {root} = await fixture(t);
  const writable = path.join(root, 'writable'), privateRoot = path.join(writable, 'private');
  await mkdir(writable, {mode:0o700});
  await mkdir(privateRoot, {mode:0o700});
  const tokenFile = path.join(privateRoot, 'mcp-token');
  await writeFile(tokenFile, TOKEN, {mode:0o600});
  await chmod(writable, 0o777);
  await assert.rejects(resolveConnection({MIOON_TOKEN_FILE:tokenFile}), safeError(root));
  assert.equal((await lstat(writable)).mode & 0o777, 0o777);
});

test('client refuses foreign-owner credentials and parents where ownership changes are available', {
  skip:process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'Requires POSIX ownership-change capability' : false,
}, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  for (const target of [tokenFile, connectionFile, root]) {
    const original = await lstat(target);
    try {
      await chown(target, original.uid + 1, original.gid);
      await assert.rejects(resolveConnection({MIOON_CONNECTION_FILE:connectionFile}), safeError(root));
    } finally { await chown(target, original.uid, original.gid); }
  }
});

test('native Windows file credentials fail closed while environment-token mode remains available', {
  skip:process.platform !== 'win32' ? 'Must execute on native Windows; a fake platform is not ACL evidence' : false,
}, async (t: TestContext) => {
  const {root, tokenFile, connectionFile} = await fixture(t);
  for (const env of [{MIOON_TOKEN_FILE:tokenFile}, {MIOON_CONNECTION_FILE:connectionFile}]) {
    await assert.rejects(resolveConnection(env), (error: unknown) => {
      safeError(root)(error);
      assert.match((error as Error).message, /operating-system access controls/);
      return true;
    });
  }
  assert.equal((await resolveConnection({MIOON_TOKEN:TOKEN})).token, TOKEN);
});
