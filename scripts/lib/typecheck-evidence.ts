/** Short-lived evidence that the outer build already checked the same sources.
 *
 * `node scripts/tooling.ts build` runs the complete strict TypeScript check
 * before bundling; the desktop staging script normally repeats that check
 * because it can also be run on its own. After a successful outer check the
 * build creates a private temporary evidence file and passes its path to the
 * staging child only. The child skips its own check only while the evidence is
 * private, owned, correctly shaped and its source fingerprint still matches the
 * current sources; anything missing, foreign, malformed or changed falls back
 * to the real check.
 *
 * The fingerprint is an over-approximation of the local inputs of the three
 * checked TypeScript projects (foundation, browser, tests). It covers their
 * source roots, including the project and tsconfig JSON, while dependency and
 * generated output directories are excluded so bundling cannot invalidate it.
 * Source symlinks are rejected instead of guessed. Windows has no verified
 * private-file ACL check here, so no evidence is created and the staging check
 * still runs. Never imported by packaged application code. */
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const TYPECHECK_EVIDENCE_ENV = 'MIOON_DESKTOP_TYPECHECK_EVIDENCE';
const evidenceDirectoryPrefix = 'mioon-desktop-typecheck-';
const evidenceFileName = 'evidence.json';
const sourceRoots = ['apps', 'packages', 'tests', 'scripts', 'server', '.github/scripts'];
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const generatedDirectories = new Set(['node_modules', 'dist', 'build', '.generated', 'artifacts', 'release', 'coverage', '.cache', '.turbo']);

export interface TypecheckEvidenceRecord {
  readonly schema: 1;
  readonly fingerprint: string;
}

export interface OwnedTypecheckEvidence {
  readonly directory: string;
  readonly environment: Record<string, string>;
}

function privateOwned(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.uid === process.getuid?.() && (Number(info.mode) & 0o077) === 0;
}

async function fingerprintTree(directory: string, relative: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entries = (await readdir(directory, {withFileTypes: true})).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const next = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Typecheck evidence cannot fingerprint source symlinks.');
    if (entry.isDirectory()) {
      if (!generatedDirectories.has(entry.name)) await fingerprintTree(path.join(directory, entry.name), next, hash);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.some(extension => entry.name.endsWith(extension))) continue;
    const bytes = await readFile(path.join(directory, entry.name));
    hash.update(`file\0${next}\0${bytes.length}\0`);
    hash.update(bytes);
  }
}

/** Deterministic content hash of the local TypeScript project inputs. */
export async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const rootRelative of sourceRoots) {
    const directory = path.join(root, ...rootRelative.split('/'));
    const info = await lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Typecheck evidence source roots must be repository-local directories.');
    await fingerprintTree(directory, rootRelative, hash);
  }
  return hash.digest('hex');
}

/** Create the private evidence file that only the directly spawned staging
 * child receives through its explicitly allowlisted environment. */
export async function createTypecheckEvidence(root: string): Promise<OwnedTypecheckEvidence> {
  if (process.platform === 'win32') throw new Error('Private typecheck evidence ACL verification is not implemented on Windows.');
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), evidenceDirectoryPrefix));
  try {
    const owned = await lstat(directory);
    if (!owned.isDirectory() || owned.isSymbolicLink() || !privateOwned(owned)) throw new Error('Owned typecheck evidence directory is not private.');
    const record: TypecheckEvidenceRecord = {schema: 1, fingerprint: await sourceFingerprint(root)};
    const file = path.join(directory, evidenceFileName);
    await writeFile(file, JSON.stringify(record), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    return {directory, environment: {[TYPECHECK_EVIDENCE_ENV]: file}};
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

/** True only when a private, owned evidence file from this build still names the
 * current source fingerprint. Any failure means the child must check itself. */
export async function hasOuterTypecheckEvidence(root: string, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const candidate = environment[TYPECHECK_EVIDENCE_ENV];
  if (typeof candidate !== 'string' || candidate === '' || process.platform === 'win32') return false;
  try {
    const file = await realpath(candidate);
    if (file !== candidate) return false;
    const directory = path.dirname(file), temporary = await realpath(tmpdir());
    if (directory !== path.join(temporary, path.basename(directory)) || !path.basename(directory).startsWith(evidenceDirectoryPrefix)) return false;
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !privateOwned(directoryInfo)) return false;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !privateOwned(info)) return false;
    const record: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (record === null || typeof record !== 'object') return false;
    const {schema, fingerprint} = record as {schema?: unknown; fingerprint?: unknown};
    if (schema !== 1 || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return false;
    return await sourceFingerprint(root) === fingerprint;
  } catch {
    return false;
  }
}

export async function removeTypecheckEvidence(evidence: OwnedTypecheckEvidence): Promise<void> {
  await rm(evidence.directory, {recursive: true, force: true});
}
