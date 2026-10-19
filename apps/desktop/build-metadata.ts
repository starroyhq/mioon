import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const exactVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export type Manifest = Record<string, unknown>;

function isManifest(value: unknown): value is Manifest {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireExactVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || !exactVersion.test(value)) {
    throw new Error(`${label} must be an exact semantic version (for example, 1.2.3); ranges and tags are not supported`);
  }
  return value;
}

export interface BuildMetadata {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly desktopPackage: Manifest;
}

export interface StagedIdentity {
  readonly channel: string;
  readonly appId: string;
  readonly productName: string;
  readonly executableName: string;
}

// The root application version is authoritative. Validate, never repair manifests.
export function validateBuildMetadata(rootPackage: unknown, desktopPackage: unknown): Readonly<BuildMetadata> {
  if (!isManifest(rootPackage)) throw new Error('Root package.json must contain a JSON object');
  if (!isManifest(desktopPackage)) throw new Error('Desktop package.json must contain a JSON object');
  const appVersion = requireExactVersion(rootPackage.version, 'Root package.json version');
  const desktopVersion = requireExactVersion(desktopPackage.version, 'Desktop package.json version');
  if (desktopVersion !== appVersion) {
    throw new Error(`Desktop package.json version ${desktopVersion} does not match root package.json version ${appVersion}; update the desktop manifest before building`);
  }
  const devDependencies = isManifest(rootPackage.devDependencies) ? rootPackage.devDependencies : {};
  const electronVersion = requireExactVersion(devDependencies.electron, 'Root package.json devDependencies.electron');
  return Object.freeze({appVersion, electronVersion, desktopPackage});
}

function readManifest(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw new Error(`Cannot read desktop build metadata from ${file}`, {cause}); }
}

// Synchronous so the same validation can be used by electron-builder's CJS config
// and other local tooling, without importing or running the staging build.
export function readBuildMetadata(rootDir: string = repositoryRoot): Readonly<BuildMetadata> {
  return validateBuildMetadata(readManifest(path.join(rootDir, 'package.json')),
    readManifest(path.join(rootDir, 'apps/desktop/package.json')));
}

export function validateStagedMetadata(stagedPackage: unknown, {appVersion, identity}: {appVersion: string; identity: StagedIdentity}): void {
  if (!isManifest(stagedPackage)) throw new Error(`Desktop staging identity mismatch; rebuild with --channel=${identity.channel}`);
  const stagedIdentity = isManifest(stagedPackage.mioonDesktop) ? stagedPackage.mioonDesktop : {};
  if (!['channel', 'appId', 'productName', 'executableName']
    .every(key => stagedIdentity[key] === identity[key as keyof StagedIdentity])) {
    throw new Error(`Desktop staging identity mismatch; rebuild with --channel=${identity.channel}`);
  }
  if (stagedPackage.version !== appVersion) {
    throw new Error(`Desktop staging version mismatch; rebuild version ${appVersion} with --channel=${identity.channel}`);
  }
  const dependencies = stagedPackage.dependencies;
  if (stagedPackage.name !== 'mioon-desktop' || stagedPackage.main !== 'main.cjs' || stagedPackage.private !== true ||
    stagedPackage.desktopName !== `${identity.appId}.desktop` || !isManifest(dependencies) ||
    Object.keys(dependencies).length !== 0) {
    throw new Error(`Desktop staging package metadata mismatch; rebuild with --channel=${identity.channel}`);
  }
}

const buildMetadata = Object.freeze({readBuildMetadata, validateBuildMetadata, validateStagedMetadata, requireExactVersion});
export default buildMetadata;
