import { cp, mkdir, readdir, lstat, stat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '@mioon/business';
import { withOrdinaryMigrationSource } from './migration-restore-guard.mjs';

async function optionalStat(file) { try { return await stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function checkAncestors(file, { allowMissing = false } = {}) {
  const root = path.parse(file).root;
  let current = root, missing = false;
  for (const component of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (missing) continue;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Migration paths and their parent directories must not contain symlinks');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') { missing = true; continue; }
      throw error;
    }
  }
}
async function canonicalDestination(file) {
  const tail = [];
  let ancestor = file;
  while (!(await optionalStat(ancestor))) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(await realpath(ancestor), ...tail);
}
async function checkTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source media contains a symlink; resolve the migration source explicitly before copying');
    if (entry.isDirectory()) await checkTree(file);
    else if (!entry.isFile()) throw new Error('Source contains a special file; only regular managed media can be migrated');
  }
}

/** Copy into a new destination. Never mutate or delete the original data directory. */
export async function migrateData(source, destination) {
  if (!path.isAbsolute(source || '') || !path.isAbsolute(destination || '')) throw new Error('Source and destination must be explicit absolute paths');
  source = path.resolve(source); destination = path.resolve(destination);
  // Reject aliases before creating any directory. A destination parent symlink
  // into source/media would otherwise mutate the original during a failed copy.
  await checkAncestors(source);
  await checkAncestors(destination, { allowMissing: true });
  source = await realpath(source);
  destination = await canonicalDestination(destination);
  if (source === destination || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) throw new Error('Source and destination must be separate, non-nested directories');
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Source must be a real directory, not a symlink');
  if (await optionalStat(path.join(source, 'server.lock'))) throw new Error('Source has server.lock; close its backend normally before migrating');
  if ((await optionalStat(path.join(source, 'workbench.sqlite-wal')))?.size) throw new Error('Source has uncheckpointed WAL data; close its backend normally before migrating');
  if (!(await lstat(path.join(source, 'workbench.sqlite'))).isFile()) throw new Error('Source database is not a regular file');
  if ((await lstat(path.join(source, 'media'))).isSymbolicLink()) throw new Error('Source media must not be a symlink');
  if (await optionalStat(destination)) throw new Error('Destination already exists; choose a new empty destination path');
  await checkTree(path.join(source, 'media'));
  const dbFile = await open(path.join(source, 'workbench.sqlite'), 'r');
  const buffer = Buffer.alloc(16);
  try { await dbFile.read(buffer, 0, buffer.length, 0); } finally { await dbFile.close(); }
  const header = buffer.toString();
  if (header !== 'SQLite format 3\0') throw new Error('Source does not contain a SQLite database');
  // A valid/partial restored profile must not be cloned with the same origin.
  // Inspect only a private disposable copy before creating the destination.
  return withOrdinaryMigrationSource(path.join(source, 'workbench.sqlite'), async checked => {
  checked.check();
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  checked.check();
  await cp(checked.file, path.join(destination, 'workbench.sqlite'), { errorOnExist: true, force: false });
  await cp(path.join(source, 'media'), path.join(destination, 'media'), { recursive: true, errorOnExist: true, force: false });
  checked.check();
  // Apply the exact same additive migrations to the copy, then close normally.
  const store = openStore(destination);
  try {
    const integrity = store.db.prepare('PRAGMA integrity_check').get().integrity_check;
    if (integrity !== 'ok') throw new Error('Copied database failed integrity_check; source remains unchanged');
    return { ok: true, projects: store.list('projects').length, assets: store.list('assets').length,
      destination, sourceUnchanged: true, copiedCredentials: false };
  } finally { store.close(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv.find(value => value.startsWith('--source='))?.slice(9);
  const destination = process.argv.find(value => value.startsWith('--destination='))?.slice(14);
  try { console.log(JSON.stringify(await migrateData(source, destination), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
