import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {evaluateSource} from './helpers/eval-source.ts';

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

async function projectOpenFixture({loseClickAcknowledgment = false} = {}) {
  const origin = 'http://127.0.0.1:4318', projectId = '11111111-1111-4111-8111-111111111111';
  const steps: string[] = [], attempts: string[] = [];
  let elapsed = 0, timer = 0, accepted = 0, editorPolls = 0;
  class Card extends EventTarget {
    readonly isConnected = true;
    readonly label: string;
    readonly disabled: boolean;
    constructor(label: string, disabled: boolean) {
      super();
      this.label = label;
      this.disabled = disabled;
    }
    matches(selector: string) { return selector.includes(':disabled') && this.disabled; }
    closest() { return null; }
    click() {
      attempts.push(this.label);
      if (!this.disabled) { accepted++; this.dispatchEvent(new Event('click')); }
    }
  }
  const ready = new Card('ready', false), disabled = new Card('disabled', true), current = new Card('current', false);
  let active = ready;
  const environment = {
    HTMLElement: Card,
    document: {
      querySelector(selector: string) {
        if (selector === '[data-testid="project-home"]') return {};
        assert.ok(selector.includes(`[data-testid="pf-card-open-${projectId}"]`));
        return active;
      },
    },
    window: {},
  };
  const launcherEvents = new EventEmitter();
  const launcherContents = Object.assign(launcherEvents, {
    async executeJavaScript(script: string): Promise<unknown> {
      const prior = accepted;
      const result: unknown = runInNewContext(script, environment);
      if (loseClickAcknowledgment && accepted > prior) throw new Error('Click result lost');
      return result;
    },
    reload() { launcherEvents.emit('did-finish-load'); },
  });
  const launcher = {isDestroyed: () => false, show() {}, focus() {}, webContents: launcherContents};
  const editor = {isDestroyed: () => false, webContents: {
    getURL: () => `${origin}/?project=${projectId}`,
    async executeJavaScript(script: string) {
      assert.match(script, /data-testid="workbench"/);
      return true;
    },
  }};
  const BrowserWindowRuntime = {getAllWindows() {
    if (!accepted || ++editorPolls < 3) return [];
    return [editor];
  }};
  const schedule = (callback: () => void, delay: number) => {
    if (delay === 100) {
      elapsed += delay;
      if (active === disabled) active = current;
      queueMicrotask(callback);
    }
    return ++timer;
  };
  const path = 'apps/desktop/src/windows-project-open.ts', source = await read(path);
  const start = source.indexOf('export const waitForWindowCondition');
  assert.ok(start >= 0);
  const open = evaluateSource<(window: typeof launcher, url: string, id: string, onStep: (step: string) => Promise<void>) => Promise<typeof editor>>(
    source.slice(start).replace(/^export /gmu, '') + '\nreturn openRegisteredProject;',
    ['assert', 'BrowserWindowRuntime', 'Date', 'setTimeout', 'clearTimeout'],
    [assert, BrowserWindowRuntime, {now: () => elapsed}, schedule, () => {}], {loader: 'ts'});
  const enter = () => open(launcher, origin, projectId, async step => {
    steps.push(step);
    if (step === 'list') active = loseClickAcknowledgment ? current : disabled;
  });
  return {enter, editor, attempts, steps, editorPolls: () => editorPolls};
}

test('Windows smoke waits for an enabled replacement and clicks once while native open is pending', async () => {
  const fixture = await projectOpenFixture();
  assert.equal(await fixture.enter(), fixture.editor);
  assert.deepEqual(fixture.attempts, ['current']);
  assert.deepEqual(fixture.steps.slice(-3), ['list', 'window', 'workbench']);
  assert.ok(fixture.editorPolls() >= 3, 'the accepted click stays in flight during the earlier empty polls');
});

test('Windows smoke does not click twice when the renderer loses the click result', async () => {
  const fixture = await projectOpenFixture({loseClickAcknowledgment: true});
  await assert.rejects(fixture.enter(), {code: 'PROJECT_OPEN_CLICK_UNCONFIRMED'});
  assert.deepEqual(fixture.attempts, ['current']);
});

test('missing Windows tools require the pinned publisher archive before extraction and executable probes', async () => {
  const source = await read('.github/workflows/windows-development.yml');
  assert.match(source, /if \(\$toolPaths.Count -ne 2\)/);
  assert.match(source, /https:\/\/github\.com\/GyanD\/codexffmpeg\/releases\/download\/8\.1\.2\/ffmpeg-8\.1\.2-essentials_build\.zip/);
  assert.match(source, /releases\/tags\/8\.1\.2/);
  assert.match(source, /db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec/);
  const publisher = source.indexOf("if ($published -notmatch '^sha256:([a-f0-9]{64})$'");
  const download = source.indexOf('Get-PinnedMediaResponse $url $archive');
  assert.match(source, /function Get-PinnedMediaResponse\(\[string\]\$Uri, \[string\]\$OutFile = ''\)/);
  assert.match(source, /for \(\$attempt = 1; \$attempt -le 4; \$attempt\+\+\)/);
  assert.match(source, /Start-Sleep -Seconds \(5 \* \$attempt\)/);
  assert.match(source, /Get-PinnedMediaJson \$releaseUrl/);
  assert.match(source, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
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
  assert.doesNotMatch(source, /choco install ffmpeg|winget install|ffmpeg-release-essentials\.zip['"]|gyan\.dev\/ffmpeg\/builds\/packages/);
});
