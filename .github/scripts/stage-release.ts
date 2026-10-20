import {copyFile, lstat, mkdir, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {argument, hashFile, jsonFile, manifestName, object, releaseVersion, sourceSha, validateAsset} from './release-common.ts';
import type {ReleaseArch, ReleaseAsset, ReleasePlatform} from './release-common.ts';

export function validatePackageReport(value: unknown, expected: {platform: ReleasePlatform; arch: ReleaseArch}): void {
  const report = object(value);
  if (report.ok !== true || report.platform !== expected.platform || report.arch !== expected.arch) throw new Error('Package inspection and smoke reports must pass for this exact target');
}
export async function stageRelease(input: {platform: ReleasePlatform; arch: ReleaseArch; packageDirectory: string; output: string; sha: string; version: string; inspectionReport: unknown; smokeReport: unknown}): Promise<ReleaseAsset> {
  const sha = sourceSha(input.sha), version = releaseVersion(input.version);
  validatePackageReport(input.inspectionReport, input);
  validatePackageReport(input.smokeReport, input);
  if (input.platform === 'linux' && input.arch !== 'x64') throw new Error('Linux release only supports x64');
  const packageInfo = await lstat(input.packageDirectory);
  if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) throw new Error('Package directory must be a real directory');
  const suffix = `-${version}-${input.platform === 'darwin' ? 'mac' : 'linux'}-${input.arch}.${input.platform === 'darwin' ? 'dmg' : 'tar.gz'}`;
  const candidates = (await readdir(input.packageDirectory)).filter(name => name.endsWith(suffix));
  if (candidates.length !== 1) throw new Error('Expected exactly one package for the selected target and version');
  const name = candidates[0]!;
  const original = path.join(input.packageDirectory, name);
  const asset = validateAsset({sourceSha: sha, version, platform: input.platform, arch: input.arch, name, ...await hashFile(original)});
  await mkdir(input.output, {recursive: true});
  const outputInfo = await lstat(input.output);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error('Release staging directory must be a real directory');
  if ((await readdir(input.output)).length !== 0) throw new Error('Release staging directory must be empty');
  const target = path.join(input.output, name);
  await copyFile(original, target);
  const staged = await hashFile(target);
  if (staged.bytes !== asset.bytes || staged.sha256 !== asset.sha256) throw new Error('Package changed during release staging');
  await writeFile(path.join(input.output, manifestName(asset)), `${JSON.stringify(asset, null, 2)}\n`, {flag: 'wx'});
  return asset;
}
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const platform = argument('platform'), arch = argument('arch');
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) throw new Error('--platform=darwin|linux and --arch=arm64|x64 are required');
  if (!environment.MIOON_DESKTOP_INSPECTION_REPORT || !environment.MIOON_DESKTOP_SMOKE_REPORT) throw new Error('Package inspection and smoke reports are required');
  const asset = await stageRelease({platform, arch, packageDirectory: argument('package-dir') ?? 'release/desktop/production', output: argument('output') ?? `artifacts/release/${platform}-${arch}`, sha: environment.MIOON_RELEASE_SHA ?? '', version: String(object(await jsonFile('package.json')).version), inspectionReport: await jsonFile(environment.MIOON_DESKTOP_INSPECTION_REPORT), smokeReport: await jsonFile(environment.MIOON_DESKTOP_SMOKE_REPORT)});
  process.stdout.write(`Staged ${asset.name} (${asset.bytes} bytes, SHA256 ${asset.sha256})\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;});
}
