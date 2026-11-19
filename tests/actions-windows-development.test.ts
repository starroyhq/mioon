import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = (file: string): Promise<string> => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('Windows development packaging remains separate from the thirteen required checks and release workflow', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /pull_request:\s*\n\s*paths:/);
  for (const path of ["apps/desktop/**", "packages/node-host/**", ".github/workflows/windows-development.yml", ".github/scripts/windows-desktop-smoke.ts"]) {
    assert.ok(source.includes(`- '${path}'`), path);
  }
  assert.doesNotMatch(source, /push:|pull_request_target:|branches:\s*\[main\]|tags:/);
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
  assert.match(source, /Test-Path -LiteralPath \$userData/);
  assert.match(source, /\$userData = Join-Path \$env:LOCALAPPDATA/);
  assert.match(source, /\$screenshots = Join-Path \$env:GITHUB_WORKSPACE 'artifacts\/windows-development\/screenshots'/);
  assert.match(source, /"--binary=\$binary" "--output=\$output" "--workspace=\$workspace" "--user-data=\$userData" "--screenshots=\$screenshots"/);
  assert.match(source, /Get-Command \(\$name \+ '\.exe'\)/);
  assert.match(source, /Get-FileHash -Algorithm SHA256/);
  assert.match(source, /MIOON_FFMPEG_PATH/);
  assert.match(source, /MIOON_FFPROBE_PATH/);
  const evidenceStart = source.indexOf('- name: Upload text-only smoke evidence');
  const screenshotsStart = source.indexOf('- name: Upload title bar screenshots');
  assert.ok(evidenceStart >= 0 && screenshotsStart > evidenceStart);
  const evidence = source.slice(evidenceStart, screenshotsStart);
  assert.match(evidence, /if: always\(\)/);
  assert.match(evidence, /artifacts\/windows-development\/smoke\.json/);
  assert.match(evidence, /artifacts\/windows-development\/media-tools\.json/);
  assert.doesNotMatch(evidence, /\.png|\.jpe?g|screens|user-data|\*\*|path:\s*\|\s*\n\s*artifacts\/windows-development\/\s*$/m);
  const screenshots = source.slice(screenshotsStart);
  assert.match(screenshots, /name: windows-titlebar-screenshots/);
  assert.match(screenshots, /artifacts\/windows-development\/screenshots\/\*\.png/);
  assert.match(screenshots, /artifacts\/windows-development\/screenshots\.json/);
  assert.match(screenshots, /retention-days: 7/);
  assert.doesNotMatch(source, /--no-sandbox|--remote-debugging|ELECTRON_RUN_AS_NODE/);
});

test('Windows title bar screenshots are fixed scenarios captured by the packaged app only', async () => {
  const driver = await read('.github/scripts/windows-desktop-smoke.ts');
  const scenarios = ['normal-light', 'normal-dark', 'maximized-light', 'maximized-dark', 'dpi-125', 'dpi-150',
    'workbench-light', 'workbench-dark', 'workbench-maximized-light', 'workbench-maximized-dark'];
  for (const name of scenarios) assert.ok(driver.includes(`name: '${name}'`), name);
  assert.match(driver, /theme: 'light'/);
  assert.match(driver, /theme: 'dark'/);
  assert.match(driver, /scale: 1\.25/);
  assert.match(driver, /scale: 1\.5/);
  assert.match(driver, /validateWindowsTitleBarScreenshot/);
  assert.match(driver, /WINDOWS_WINDOW_CHROME\.topbarHeight/);
  for (const variable of ['MIOON_DESKTOP_WINDOWS_SMOKE_SCREENSHOT', 'MIOON_DESKTOP_WINDOWS_SMOKE_SCENARIO',
    'MIOON_DESKTOP_WINDOWS_SMOKE_THEME', 'MIOON_DESKTOP_WINDOWS_SMOKE_MAXIMIZED', 'MIOON_DESKTOP_WINDOWS_SMOKE_SCALE']) {
    assert.ok(driver.includes(variable), variable);
  }
  const screenshot = await read('apps/desktop/src/windows-titlebar-screenshot.ts');
  assert.match(screenshot, /WINDOWS_TITLEBAR_SCENARIOS/);
  assert.match(screenshot, /desktopCapturer/);
  assert.match(screenshot, /WINDOWS_WINDOW_CHROME\.topbarHeight/);
  assert.doesNotMatch(screenshot, /exec\(|spawn\(|child_process/u);
  assert.match(screenshot, /openRegisteredProject/);
  assert.match(screenshot, /project\.template\.instantiate/);
  const projectOpen = await read('apps/desktop/src/windows-project-open.ts');
  assert.match(projectOpen, /project-home-open-/);
  assert.match(projectOpen, /launcher-help-refresh/);
  const main = await read('apps/desktop/src/main.ts');
  assert.match(main, /process\.env\.MIOON_DESKTOP_WINDOWS_SMOKE_SCREENSHOT/);
  assert.match(main, /backendUrl: ready\?\.url/);
  assert.match(main, /force-device-scale-factor/);
  assert.doesNotMatch(main, /nativeTheme\.themeSource\s*=/);
});

test('missing Windows tools require the pinned publisher archive before extraction and executable probes', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /if \(\$toolPaths.Count -ne 2\)/);
  assert.match(source, /https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/ffmpeg-8\.1\.2-essentials_build\.zip/);
  assert.match(source, /db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec/);
  const publisher = source.indexOf('$published -cne $expected');
  const download = source.indexOf('Get-PinnedMediaResponse $url $archive');
  assert.match(source, /function Get-PinnedMediaResponse\(\[string\]\$Uri, \[string\]\$OutFile = ''\)/);
  assert.match(source, /for \(\$attempt = 1; \$attempt -le 4; \$attempt\+\+\)/);
  assert.match(source, /Start-Sleep -Seconds \(5 \* \$attempt\)/);
  assert.match(source, /Get-PinnedMediaResponse \(\$url \+ '\.sha256'\)/);
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
