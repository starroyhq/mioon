import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openStore } from '@mioon/business';
import { migrateData } from '../apps/desktop/scripts/migrate-data.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-migration-test-'));
  const source = path.join(root, 'old');
  const store = openStore(source);
  store.put('projects', { id: '12345678-1234-4234-8234-123456789abc', name: 'Original', revision: 1 });
  store.close();
  await writeFile(path.join(source, 'media/example.bin'), 'source fixture bytes');
  await writeFile(path.join(source, 'access-token'), 'credential-must-not-copy');
  return { root, source, destination: path.join(root, 'desktop/workspace') };
}
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('migration copies closed data, leaves original bytes unchanged, excludes credentials', async () => {
  const { root, source, destination } = await fixture();
  try {
    const before = await hash(path.join(source, 'workbench.sqlite'));
    const result = await migrateData(source, destination);
    assert.equal(result.ok, true); assert.equal(result.projects, 1);
    assert.equal(await hash(path.join(source, 'workbench.sqlite')), before);
    assert.equal(await readFile(path.join(source, 'media/example.bin'), 'utf8'), 'source fixture bytes');
    assert.equal(await readFile(path.join(destination, 'media/example.bin'), 'utf8'), 'source fixture bytes');
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    await assert.rejects(readFile(path.join(destination, 'access-token')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(destination, 'server.lock')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration refuses a locked source or uncheckpointed WAL before creating destination', async () => {
  const { root, source, destination } = await fixture();
  try {
    await writeFile(path.join(source, 'server.lock'), String(process.pid));
    await assert.rejects(migrateData(source, destination), /server.lock/);
    await rm(path.join(source, 'server.lock'));
    await writeFile(path.join(source, 'workbench.sqlite-wal'), 'pending');
    await assert.rejects(migrateData(source, destination), /WAL/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration rejects destination ancestor aliases into source without mutating original', async () => {
  const { root, source } = await fixture();
  try {
    const before = await hash(path.join(source, 'workbench.sqlite'));
    const originalMedia = await readdir(path.join(source, 'media'));
    const alias = path.join(root, 'media-alias');
    await symlink(path.join(source, 'media'), alias);
    await assert.rejects(migrateData(source, path.join(alias, 'copied')), /symlinks/);
    assert.deepEqual(await readdir(path.join(source, 'media')), originalMedia);
    assert.equal(await hash(path.join(source, 'workbench.sqlite')), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration rejects source parent aliases and all existing destinations', async () => {
  const { root, source, destination } = await fixture();
  try {
    const alias = path.join(root, 'alias');
    await symlink(root, alias);
    await assert.rejects(migrateData(path.join(alias, 'old'), destination), /symlinks/);
    await mkdir(destination, { recursive: true });
    await assert.rejects(migrateData(source, destination), /already exists/);
    await assert.rejects(migrateData(source, path.join(source, 'new')), /non-nested/);
    assert.deepEqual(await readdir(destination), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
