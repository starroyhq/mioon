import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = (file: string): Promise<string> => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('Windows development packaging remains separate from the thirteen required checks and release workflow', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /push:\s*\n\s*branches: \[howard\/windows-desktop-bringup\]/);
  assert.doesNotMatch(source, /pull_request(?:_target)?:|branches:\s*\[main\]|tags:/);
  assert.match(source, /runs-on: windows-2025/);
  assert.match(source, /contents: read/);
  assert.doesNotMatch(source, /contents: write|secrets\.|--publish always|--channel=production|package:win:production/);
  for (const file of ['ci.yml', 'checks.yml', 'release-desktop.yml']) {
    assert.doesNotMatch(await read(`.github/workflows/${file}`), /windows-development\.yml|Windows development package and smoke/);
  }
});

test('Windows package smoke starts the delivered x64 executable in a new isolated workspace and retains only text evidence', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /node-version: 24\.21\.0/);
  assert.match(source, /architecture: x64/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  const packaging = source.indexOf('pnpm --filter @mioon/desktop package:win:dev');
  const smoke = source.indexOf('node .github/scripts/windows-desktop-smoke.ts');
  assert.ok(packaging >= 0 && smoke > packaging);
  assert.match(source, /release\/desktop\/development\/win-unpacked\/mioon-dev\.exe/);
  assert.match(source, /Test-Path -LiteralPath \$workspace/);
  assert.match(source, /"--binary=\$binary" "--output=\$output" "--workspace=\$workspace"/);
  assert.match(source, /Get-Command \(\$name \+ '\.exe'\)/);
  assert.match(source, /Get-FileHash -Algorithm SHA256/);
  assert.match(source, /MIOON_FFMPEG_PATH/);
  assert.match(source, /MIOON_FFPROBE_PATH/);
  const evidence = source.slice(source.indexOf('- name: Upload text-only smoke evidence'));
  assert.match(evidence, /if: always\(\)/);
  assert.match(evidence, /artifacts\/windows-development\/smoke\.json/);
  assert.match(evidence, /artifacts\/windows-development\/media-tools\.json/);
  assert.doesNotMatch(evidence, /\.png|\.jpe?g|screens|user-data|\*\*|path:\s*\|\s*\n\s*artifacts\/windows-development\/\s*$/m);
  assert.doesNotMatch(source, /--no-sandbox|--remote-debugging|ELECTRON_RUN_AS_NODE/);
});

test('missing Windows tools require the pinned publisher archive before extraction and executable probes', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /if \(\$toolPaths.Count -ne 2\)/);
  assert.match(source, /https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/ffmpeg-8\.1\.2-essentials_build\.zip/);
  assert.match(source, /db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec/);
  const publisher = source.indexOf('$published -cne $expected');
  const download = source.indexOf('Invoke-WebRequest -Uri $url -OutFile $archive');
  const archiveHash = source.indexOf('if ($actual -cne $expected)');
  const inspect = source.indexOf('[IO.Compression.ZipFile]::OpenRead($archive)');
  const extract = source.indexOf('[IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)');
  const pe = source.indexOf("'Windows media executable must be x64 PE.'");
  const version = source.indexOf("'Windows media executable version differs from the archive pin.'");
  assert.ok(publisher >= 0 && download > publisher && archiveHash > download && inspect > archiveHash && extract > inspect && pe > extract && version > pe);
  for (const rejection of ['Unsafe Windows media archive entry.', 'Ambiguous Windows media archive entry.',
    'Windows media archive exceeds extraction bounds.', 'Windows media archive has no unique expected executable.',
    'Both Windows media tools are required for startup.']) assert.ok(source.includes(`throw '${rejection}'`), rejection);
  for (const capability of ['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128', 'libx264', 'aac']) assert.ok(source.includes(`'${capability}'`), capability);
  assert.match(source, /missingCapabilities = \$missing/);
  assert.match(source, /source = \$source/);
  assert.doesNotMatch(source, /choco install ffmpeg|winget install|ffmpeg-release-essentials\.zip['"]/);
});
