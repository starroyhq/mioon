import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateMacUpdateFeed} from './mac-update-feed.ts';
import {argument, hashFile, jsonFile, macArtifactNames, manifestName, object, releaseAssetNames, releaseVersion, RELEASE_TARGET, sourceSha} from './release-common.ts';
import type {ReleaseArch, ReleaseAsset, ReleasePlatform} from './release-common.ts';

export function validatePackageReport(value: unknown, expected: {arch: ReleaseArch | 'arm64' | 'x64'; package: Pick<ReleaseAsset, 'name' | 'sha256'>}): void {
  const report = object(value);
  if (report.ok !== true || report.platform !== 'darwin' || report.arch !== expected.arch) {
    throw new Error(`Package inspection and smoke reports must pass for this exact target: darwin-${expected.arch}`);
  }
  const artifact = object(report.package);
  if (artifact.name !== expected.package.name || artifact.sha256 !== expected.package.sha256) {
    throw new Error(`Package inspection and smoke reports must verify this exact DMG: darwin-${expected.arch}`);
  }
}
export async function stageRelease(input: {
  platform: ReleasePlatform;
  arch: ReleaseArch;
  packageDirectory: string;
  output: string;
  sha: string;
  version: string;
  inspectionReport: unknown;
  smokeReport: unknown;
  intelSmokeReport: unknown;
}): Promise<ReleaseAsset[]> {
  const sha = sourceSha(input.sha), version = releaseVersion(input.version);
  if (input.platform !== 'darwin') throw new Error('Only macOS release packages are supported');
  if (input.arch !== 'universal') throw new Error('Invalid package architecture: expected universal');
  const packageInfo = await lstat(input.packageDirectory);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error('Package directory must be a real directory');
  const available = new Set(await readdir(input.packageDirectory));
  const names = releaseAssetNames(version, available);
  for (const name of available) {
    if (/\.(?:dmg|zip|blockmap)$|^latest.*\.ya?ml$/i.test(name) && !names.includes(name)) {
      throw new Error(`Unexpected packaged release asset: ${name}`);
    }
  }
  const {dmg} = macArtifactNames(version);
  const artifact = {name: dmg, ...await hashFile(path.join(input.packageDirectory, dmg))};
  validatePackageReport(input.inspectionReport, {arch: 'universal', package: artifact});
  validatePackageReport(input.smokeReport, {arch: 'arm64', package: artifact});
  validatePackageReport(input.intelSmokeReport, {arch: 'x64', package: artifact});

  await mkdir(input.output, {recursive: true});
  const outputInfo = await lstat(input.output);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('Release staging directory must be a real directory');
  if ((await readdir(input.output)).length !== 0) throw new Error('Release staging directory must be empty');

  const assets: ReleaseAsset[] = [];
  for (const name of names) {
    const original = path.join(input.packageDirectory, name), target = path.join(input.output, name);
    const expected = name === dmg ? artifact : await hashFile(original);
    await copyFile(original, target, constants.COPYFILE_EXCL);
    const staged = await hashFile(target);
    if (staged.bytes !== expected.bytes || staged.sha256 !== expected.sha256) throw new Error(`Package changed during release staging: ${name}`);
    assets.push({sourceSha: sha, version, platform: input.platform, arch: input.arch, name, ...staged});
  }
  await validateMacUpdateFeed(input.output, version);
  for (const asset of assets) {
    await writeFile(path.join(input.output, manifestName(asset.name)), `${JSON.stringify(asset, null, 2)}\n`, {flag: 'wx'});
  }
  return assets;
}
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const platform = argument('platform'), arch = argument('arch');
  if (platform !== 'darwin' || arch !== 'universal') throw new Error('--platform=darwin and --arch=universal are required');
  const {MIOON_DESKTOP_INSPECTION_REPORT, MIOON_DESKTOP_SMOKE_REPORT, MIOON_DESKTOP_INTEL_SMOKE_REPORT} = environment;
  if (!MIOON_DESKTOP_INSPECTION_REPORT || !MIOON_DESKTOP_SMOKE_REPORT || !MIOON_DESKTOP_INTEL_SMOKE_REPORT) {
    throw new Error('Package inspection and both native smoke reports are required');
  }
  const assets = await stageRelease({
    platform,
    arch,
    packageDirectory: argument('package-dir') ?? 'release/desktop/production',
    output: argument('output') ?? `artifacts/release/${RELEASE_TARGET}`,
    sha: environment.MIOON_RELEASE_SHA ?? '',
    version: releaseVersion(environment.MIOON_RELEASE_VERSION ?? object(await jsonFile('package.json')).version),
    inspectionReport: await jsonFile(MIOON_DESKTOP_INSPECTION_REPORT),
    smokeReport: await jsonFile(MIOON_DESKTOP_SMOKE_REPORT),
    intelSmokeReport: await jsonFile(MIOON_DESKTOP_INTEL_SMOKE_REPORT),
  });
  for (const asset of assets) process.stdout.write(`Staged ${asset.name} (${asset.bytes} bytes, SHA256 ${asset.sha256})\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;});
}
