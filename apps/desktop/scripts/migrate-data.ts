import { cp, mkdir, readdir, lstat, stat, realpath, open } from 'node:fs/promises';
import type {Stats} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '@mioon/business';
import { withOrdinaryMigrationSource } from './migration-restore-guard.ts';

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function errorMessage(error: unknown): string {
  const message = error !== null && typeof error === 'object' && 'message' in error ? error.message : error;
  return typeof message === 'string' ? message : 'Unknown migration error';
}
async function optionalStat(file: string): Promise<Stats | null> { try { return await stat(file); } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; } }
async function checkAncestors(file: string, { allowMissing = false }: {allowMissing?: boolean} = {}): Promise<void> {
  const root = path.parse(file).root;
  let current = root, missing = false;
  for (const component of file.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (missing) continue;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Migration paths and their parent directories must not contain symlinks');
    } catch (error) {
      if (allowMissing && errorCode(error) === 'ENOENT') { missing = true; continue; }
      throw error;
    }
  }
}
async function canonicalDestination(file: string): Promise<string> {
  const tail = [];
  let ancestor = file;
  while (!(await optionalStat(ancestor))) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(await realpath(ancestor), ...tail);
}
async function checkTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Source media contains a symlink; resolve the migration source explicitly before copying');
    if (entry.isDirectory()) await checkTree(file);
    else if (!entry.isFile()) throw new Error('Source contains a special file; only regular managed media can be migrated');
  }
}
export interface MigratedWorkspace {
  readonly ok: true;
  readonly projects: number;
  readonly assets: number;
  readonly destination: string;
  readonly sourceUnchanged: true;
  readonly copiedCredentials: false;
}

/** Copy into a new destination. Never mutate or delete the original data directory. */
export async function migrateData(source: string | undefined, destination: string | undefined): Promise<MigratedWorkspace> {
  if (typeof source !== 'string' || typeof destination !== 'string' || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('Source and destination must be explicit absolute paths');
  let sourcePath = path.resolve(source), destinationPath = path.resolve(destination);
  // Reject aliases before creating any directory. A destination parent symlink
  // into source/media would otherwise mutate the original during a failed copy.
  await checkAncestors(sourcePath);
  await checkAncestors(destinationPath, { allowMissing: true });
  sourcePath = await realpath(sourcePath);
  destinationPath = await canonicalDestination(destinationPath);
  if (sourcePath === destinationPath || destinationPath.startsWith(sourcePath + path.sep) || sourcePath.startsWith(destinationPath + path.sep)) throw new Error('Source and destination must be separate, non-nested directories');
  if ((await lstat(sourcePath)).isSymbolicLink()) throw new Error('Source must be a real directory, not a symlink');
  if (await optionalStat(path.join(sourcePath, 'server.lock'))) throw new Error('Source has server.lock; close its backend normally before migrating');
  if ((await optionalStat(path.join(sourcePath, 'workbench.sqlite-wal')))?.size) throw new Error('Source has uncheckpointed WAL data; close its backend normally before migrating');
  if (!(await lstat(path.join(sourcePath, 'workbench.sqlite'))).isFile()) throw new Error('Source database is not a regular file');
  if ((await lstat(path.join(sourcePath, 'media'))).isSymbolicLink()) throw new Error('Source media must not be a symlink');
  if (await optionalStat(destinationPath)) throw new Error('Destination already exists; choose a new empty destination path');
  await checkTree(path.join(sourcePath, 'media'));
  const dbFile = await open(path.join(sourcePath, 'workbench.sqlite'), 'r');
  const buffer = Buffer.alloc(16);
  try { await dbFile.read(buffer, 0, buffer.length, 0); } finally { await dbFile.close(); }
  const header = buffer.toString();
  if (header !== 'SQLite format 3\0') throw new Error('Source does not contain a SQLite database');
  // A valid/partial restored profile must not be cloned with the same origin.
  // Inspect only a private disposable copy before creating the destination.
  return withOrdinaryMigrationSource(path.join(sourcePath, 'workbench.sqlite'), async checked => {
  checked.check();
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await mkdir(destinationPath, { mode: 0o700 });
  checked.check();
  await cp(checked.file, path.join(destinationPath, 'workbench.sqlite'), { errorOnExist: true, force: false });
  await cp(path.join(sourcePath, 'media'), path.join(destinationPath, 'media'), { recursive: true, errorOnExist: true, force: false });
  checked.check();
  // Apply the exact same additive migrations to the copy, then close normally.
  const store = openStore(destinationPath);
  try {
    const integrity = (store.db.prepare('PRAGMA integrity_check').get() as {integrity_check?: unknown}).integrity_check;
    if (integrity !== 'ok') throw new Error('Copied database failed integrity_check; source remains unchanged');
    return { ok: true, projects: store.list('projects').length, assets: store.list('assets').length,
      destination: destinationPath, sourceUnchanged: true, copiedCredentials: false };
  } finally { store.close(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv.find(value => value.startsWith('--source='))?.slice(9);
  const destination = process.argv.find(value => value.startsWith('--destination='))?.slice(14);
  try { console.log(JSON.stringify(await migrateData(source, destination), null, 2)); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
