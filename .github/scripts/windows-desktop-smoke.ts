import {spawn, execFile} from 'node:child_process';
import type {ChildProcess, SpawnOptions} from 'node:child_process';
import {lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {argumentsFor, isMain} from './media-environment.ts';
import {WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE, WINDOWS_WINDOW_CHROME} from '../../packages/contracts/src/desktop-window-chrome.ts';

const paths = path.win32;
export const WINDOWS_SMOKE_TIMEOUT_MS = 180000;
const maximumReportBytes = 32768;
const requiredChecks = [
  'packaged-development-identity', 'bundled-utility-node-sqlite', 'renderer-sandbox-and-origin',
  'secure-memory-cookie', 'loopback-rpc-and-anonymous-denial', 'renderer-network-window-permission-fences',
  'private-discovery-acl', 'configured-windows-media-tools', 'dpapi-app-scoped-roundtrip',
  'packaged-example-resources', 'launcher-ui-ready', 'native-project-location', 'native-project-core-flows',
] as const;
const blockedCodes: Readonly<Record<string, readonly string[]>> = {
  'live-mio-and-generation': ['LIVE_CREDENTIALS_NOT_CONFIGURED'],
};
const failureCodes = [
  'WINDOWS_SMOKE_REQUIRES_WIN32_X64', 'WINDOWS_SMOKE_INVALID_ARGUMENTS', 'WINDOWS_SMOKE_BINARY_INVALID',
  'WINDOWS_SMOKE_MEDIA_TOOLS_REQUIRED', 'WINDOWS_SMOKE_WORKSPACE_UNAVAILABLE', 'WINDOWS_SMOKE_REPORT_INVALID', 'WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID',
  'WINDOWS_SMOKE_APP_SPAWN_FAILED', 'WINDOWS_SMOKE_APP_EXIT_FAILED', 'WINDOWS_SMOKE_APP_TIMEOUT', 'WINDOWS_SMOKE_APP_QUIT_TIMEOUT',
  'WINDOWS_SMOKE_CHECK_FAILED', 'WINDOWS_SMOKE_STARTUP_FAILED', 'WINDOWS_SMOKE_APP_STARTUP_ERROR', 'WINDOWS_SMOKE_REPORT_MISSING',
  'WINDOWS_SMOKE_SCREENSHOT_FAILED', 'WINDOWS_SMOKE_SCREENSHOT_INVALID',
  'WINDOWS_SMOKE_APP_STOP_UNCONFIRMED', 'WINDOWS_SMOKE_OUTPUT_FAILED', 'WINDOWS_SMOKE_FAILED',
] as const;
type FailureCode = typeof failureCodes[number];
class SmokeFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {super(code); this.code = code;}
}
function fail(code: FailureCode): never {throw new SmokeFailure(code);}
export function smokeFailureCode(error: unknown): FailureCode {
  return error instanceof SmokeFailure && failureCodes.includes(error.code) ? error.code : 'WINDOWS_SMOKE_FAILED';
}
interface SmokeArguments {binary: string; output: string; workspace: string; userData: string; screenshots?: string}
interface SmokeCheck {name: string; status: 'passed' | 'blocked'; code?: string}
export interface WindowsLaunchReport {
  schemaVersion: 1; scope: 'windows-development-launch'; ok: true; channel: 'development'; platform: 'win32'; arch: 'x64';
  isPackaged: true; appVersion: string; runtime: {node: string; electron: string}; checks: SmokeCheck[];
}
interface FailureReport {schemaVersion: 1; scope: 'windows-development-launch'; ok: false; code: FailureCode; phase?: string; check?: string; reason?: string}
/** Fixed progress markers the packaged app writes beside its report. */
export const WINDOWS_SMOKE_PHASES: readonly string[] = Object.freeze(['startup', 'smoke', 'packaged-development-identity',
  'bundled-utility-node-sqlite', 'launcher-ui-ready', 'renderer-sandbox-and-origin', 'secure-memory-cookie',
  'loopback-rpc-and-anonymous-denial', 'renderer-network-window-permission-fences', 'private-discovery-acl',
  'configured-windows-media-tools', 'dpapi-app-scoped-roundtrip', 'packaged-example-resources', 'native-project-location',
  'native-project-core-flows', 'write-report']);
const fixedName = (value: unknown, keys: readonly string[]): string | undefined => {
  if (!record(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || value.scope !== 'windows-development-launch') return undefined;
  const name = value[keys[keys.length - 1]!];
  return typeof name === 'string' && WINDOWS_SMOKE_PHASES.includes(name) ? name : undefined;
};
export const appCheckFailureName = (value: unknown): string | undefined =>
  record(value) && value.ok === false && value.code === 'WINDOWS_SMOKE_CHECK_FAILED' ? fixedName(value, ['schemaVersion', 'scope', 'ok', 'code', 'check']) : undefined;
export const phaseMarkerName = (value: unknown): string | undefined => fixedName(value, ['schemaVersion', 'scope', 'phase']);
const safeReason = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/u.test(value) ? value : undefined;
/** Early storage/helper failures are fixed codes written instead of a dialog. */
/** The app's own fatal path writes this fixed two-field shape (no details kept). */
export const appStartupErrorShape = (value: unknown): boolean =>
  record(value) && exactKeys(value, ['ok', 'error']) && value.ok === false && typeof value.error === 'string';
export const startupFailureReason = (value: unknown): string | undefined => {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'scope', 'ok', 'code', 'reason']) || value.schemaVersion !== 1 ||
      value.scope !== 'windows-development-launch' || value.ok !== false || value.code !== 'WINDOWS_SMOKE_STARTUP_FAILED') return undefined;
  return safeReason(value.reason);
};
interface ExpectedPackage {appVersion: string; electron: string; license: string; description: string}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const version = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) && value.length <= 64;
function absoluteLocalPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) && !/[\0\r\n]/.test(value) && paths.isAbsolute(value);
}
function inside(parent: string, child: string): boolean {
  const relative = paths.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith('..\\') && !paths.isAbsolute(relative);
}
export function parseWindowsSmokeArguments(args: readonly string[]): SmokeArguments {
  let values: Record<string, string>;
  try {values = argumentsFor(args, ['binary', 'output', 'workspace', 'user-data'], ['screenshots']);} catch {fail('WINDOWS_SMOKE_INVALID_ARGUMENTS');}
  const {binary, output, workspace} = values, userData = values['user-data']!, screenshots = values.screenshots;
  if (![binary, output, workspace, userData].every(absoluteLocalPath) || paths.basename(binary) !== 'mioon-dev.exe' ||
      paths.basename(paths.dirname(binary)) !== 'win-unpacked' || paths.extname(output).toLowerCase() !== '.json' || inside(workspace, output) ||
      paths.normalize(userData) === paths.normalize(workspace) || inside(workspace, userData) ||
      (screenshots !== undefined && (!absoluteLocalPath(screenshots) || inside(workspace, screenshots)))) fail('WINDOWS_SMOKE_INVALID_ARGUMENTS');
  return {binary: paths.normalize(binary), output: paths.normalize(output), workspace: paths.normalize(workspace),
    userData: paths.normalize(userData), ...(screenshots === undefined ? {} : {screenshots: paths.normalize(screenshots)})};
}
/** The app receives only OS/session prerequisites and these fixed smoke inputs. */
export function windowsSmokeEnvironment(source: NodeJS.ProcessEnv, workspace: string, userData: string, ffmpeg: string, ffprobe: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'LANG', 'LC_ALL'];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const sourceKey = Object.keys(source).find(name => name.toUpperCase() === key.toUpperCase());
    if (sourceKey && source[sourceKey] !== undefined) result[key] = source[sourceKey];
  }
  return {...result, MIOON_DESKTOP_WINDOWS_SMOKE: '1', MIOON_DESKTOP_USER_DATA: userData,
    MIOON_DESKTOP_SMOKE_OUTPUT: paths.join(workspace, 'result.json'), MIOON_FFMPEG_PATH: ffmpeg, MIOON_FFPROBE_PATH: ffprobe};
}
export function validateWindowsLaunchReport(value: unknown, expected: {appVersion: string; electron: string}): WindowsLaunchReport {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'scope', 'ok', 'channel', 'platform', 'arch', 'isPackaged', 'appVersion', 'runtime', 'checks']) ||
      value.schemaVersion !== 1 || value.scope !== 'windows-development-launch' || value.ok !== true || value.channel !== 'development' ||
      value.platform !== 'win32' || value.arch !== 'x64' || value.isPackaged !== true || value.appVersion !== expected.appVersion || !version(value.appVersion) ||
      !record(value.runtime) || !exactKeys(value.runtime, ['node', 'electron']) || !version(value.runtime.node) || Number(value.runtime.node.split('.')[0]) < 24 ||
      value.runtime.electron !== expected.electron || !version(value.runtime.electron) || !Array.isArray(value.checks) || value.checks.length > 14) fail('WINDOWS_SMOKE_REPORT_INVALID');
  const seen = new Set<string>(), checks: SmokeCheck[] = [];
  for (const item of value.checks) {
    if (!record(item) || typeof item.name !== 'string' || seen.has(item.name)) fail('WINDOWS_SMOKE_REPORT_INVALID');
    const required = requiredChecks.some(name => name === item.name), optional = Object.hasOwn(blockedCodes, item.name);
    if (!required && !optional) fail('WINDOWS_SMOKE_REPORT_INVALID');
    if (item.status === 'passed' && required && exactKeys(item, ['name', 'status'])) checks.push({name: item.name, status: 'passed'});
    else if (item.status === 'blocked' && optional && exactKeys(item, ['name', 'status', 'code']) && typeof item.code === 'string' && blockedCodes[item.name].includes(item.code)) checks.push({name: item.name, status: 'blocked', code: item.code});
    else fail('WINDOWS_SMOKE_REPORT_INVALID');
    seen.add(item.name);
  }
  if ([...requiredChecks, ...Object.keys(blockedCodes)].some(name => !seen.has(name))) fail('WINDOWS_SMOKE_REPORT_INVALID');
  return {schemaVersion: 1, scope: 'windows-development-launch', ok: true, channel: 'development', platform: 'win32', arch: 'x64',
    isPackaged: true, appVersion: value.appVersion, runtime: {node: value.runtime.node, electron: value.runtime.electron}, checks};
}

/** The packaged manifest is staged from the desktop manifest, while version and
 * Electron are pinned by the repository root; both sources are fixed files. */
export function windowsDevelopmentPackageExpectation(root: unknown, desktop: unknown): ExpectedPackage {
  if (!record(root) || !record(root.devDependencies) || typeof root.version !== 'string' ||
      typeof root.devDependencies.electron !== 'string' || !record(desktop) ||
      typeof desktop.license !== 'string' || typeof desktop.description !== 'string') fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
  return {appVersion: root.version, electron: root.devDependencies.electron, license: desktop.license, description: desktop.description};
}

export function validateWindowsDevelopmentPackage(value: unknown, expected: ExpectedPackage): void {
  if (!record(value) || !exactKeys(value, ['name', 'version', 'private', 'license', 'desktopName', 'mioonDesktop', 'description', 'author', 'main', 'dependencies']) ||
      value.name !== 'mioon-desktop' || value.version !== expected.appVersion || !version(value.version) || value.private !== true || value.license !== expected.license ||
      value.desktopName !== 'app.starroy.mioon.dev.desktop' || value.description !== expected.description || value.author !== 'Mioon' || value.main !== 'main.cjs' ||
      !record(value.dependencies) || Object.keys(value.dependencies).length !== 0 || !record(value.mioonDesktop) ||
      !exactKeys(value.mioonDesktop, ['channel', 'appId', 'productName', 'executableName']) || value.mioonDesktop.channel !== 'development' ||
      value.mioonDesktop.appId !== 'app.starroy.mioon.dev' || value.mioonDesktop.productName !== 'Mioon Dev' || value.mioonDesktop.executableName !== 'mioon-dev') fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
}
interface AsarReader {
  statFile(file: string, entry: string, follow: false): {size?: number; link?: string; files?: unknown; unpacked?: boolean};
  extractFile(file: string, entry: string): Buffer;
}
function asarReader(): AsarReader {
  // Resolve the existing lockfile-pinned builder dependency, as inspect-desktop does.
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve('electron-builder'));
  return createRequire(builder.resolve('app-builder-lib'))('@electron/asar') as AsarReader;
}
export function readWindowsPackageMetadata(archive: string, reader: AsarReader = asarReader()): unknown {
  const info = reader.statFile(archive, 'package.json', false);
  if (Object.hasOwn(info, 'link') || info.files || info.unpacked || !Number.isSafeInteger(info.size) || !info.size || info.size < 1 || info.size > maximumReportBytes) fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
  const bytes = reader.extractFile(archive, 'package.json');
  if (bytes.length !== info.size || bytes.length > maximumReportBytes) fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown;
}

export interface WindowsTitleBarScreenshotScenario {
  readonly name: string; readonly theme: 'light' | 'dark'; readonly scale: number; readonly maximized: boolean;
}
export const WINDOWS_TITLEBAR_SCREENSHOT_PHASES: readonly string[] = Object.freeze(['launcher-ready', 'theme', 'appearance',
  'maximize', 'settle', 'facts', 'capture', 'verify-band', 'write']);
/** The packaged app writes this fixed failure shape when a screenshot step
 * assertion fails; only the shared phase name crosses the boundary. */
export function screenshotCheckFailureName(value: unknown): string | undefined {
  if (!record(value) || value.schemaVersion !== 1 || value.scope !== 'windows-titlebar-screenshot' || value.ok !== false ||
      value.code !== 'WINDOWS_SMOKE_SCREENSHOT_CHECK_FAILED' || typeof value.check !== 'string' ||
      !WINDOWS_TITLEBAR_SCREENSHOT_PHASES.includes(value.check)) return undefined;
  return value.check;
}
/** A bounded fixed diagnostic string (for example the measured pixel delta). */
export function screenshotCheckFailureDetail(value: unknown): string | undefined {
  if (!record(value) || typeof value.detail !== 'string' || value.detail.length > 120) return undefined;
  return /^[A-Za-z0-9#][A-Za-z0-9# =:._-]*$/u.test(value.detail) ? value.detail : undefined;
}
const sanitizedFailureMessage = (value: unknown): string | undefined => {
  if (!record(value) || !exactKeys(value, ['ok', 'error']) || value.ok !== false || typeof value.error !== 'string') return undefined;
  const text = value.error.replace(/[A-Za-z]:\\[^\s"']*/gu, '<path>').replace(/(?:\/Users\/|\/private\/)[^\s"']*/gu, '<path>');
  return text.slice(0, 300);
};
export const WINDOWS_TITLEBAR_SCENARIOS: readonly WindowsTitleBarScreenshotScenario[] = Object.freeze([
  Object.freeze({name: 'normal-light', theme: 'light', scale: 1, maximized: false}),
  Object.freeze({name: 'normal-dark', theme: 'dark', scale: 1, maximized: false}),
  Object.freeze({name: 'maximized-light', theme: 'light', scale: 1, maximized: true}),
  Object.freeze({name: 'maximized-dark', theme: 'dark', scale: 1, maximized: true}),
  Object.freeze({name: 'dpi-125', theme: 'light', scale: 1.25, maximized: false}),
  Object.freeze({name: 'dpi-150', theme: 'light', scale: 1.5, maximized: false}),
]);
export interface WindowsTitleBarScreenshot {readonly name: string; readonly theme: 'light' | 'dark'; readonly scale: number;
  readonly maximized: boolean; readonly frame: 'win-overlay'; readonly devicePixelRatio: number;
  readonly overlay: {readonly visible: true; readonly right: number}; readonly innerWidth: number;
  readonly barHeight: number; readonly trailing: number; readonly bandColorDelta: number;
  readonly screenshot: {readonly bytes: number; readonly sha256: string; readonly source: 'window' | 'content'}}
export interface WindowsTitleBarScreenshotsReport {schemaVersion: 1; scope: 'windows-titlebar-screenshots'; ok: boolean;
  scenarios: WindowsTitleBarScreenshot[]}
interface WindowsTitleBarScreenshotDiagnostic {schemaVersion: 1; scope: 'windows-titlebar-screenshots'; ok: false; scenario: string;
  check?: string; message?: string; detail?: string}
/** Validates the fixed app record for one title bar screenshot scenario and
 * returns a detached copy without raw paths. */
export function validateWindowsTitleBarScreenshot(value: unknown, scenario: WindowsTitleBarScreenshotScenario): WindowsTitleBarScreenshot {
  const keys = ['schemaVersion', 'scope', 'ok', 'scenario', 'platform', 'arch', 'isPackaged', 'theme', 'scale', 'maximized', 'frame',
    'devicePixelRatio', 'overlay', 'innerWidth', 'barHeight', 'trailing', 'bandColorDelta', 'screenshot'];
  if (!record(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || value.scope !== 'windows-titlebar-screenshot' ||
      value.ok !== true || value.scenario !== scenario.name || value.platform !== 'win32' || value.arch !== 'x64' || value.isPackaged !== true ||
      value.theme !== scenario.theme || value.scale !== scenario.scale || value.maximized !== scenario.maximized || value.frame !== 'win-overlay' ||
      typeof value.devicePixelRatio !== 'number' || Math.abs(value.devicePixelRatio - scenario.scale) > 0.02 ||
      !record(value.overlay) || !exactKeys(value.overlay, ['visible', 'right']) || value.overlay.visible !== true ||
      typeof value.overlay.right !== 'number' || !Number.isFinite(value.overlay.right) || value.overlay.right <= 0 ||
      typeof value.innerWidth !== 'number' || !Number.isFinite(value.innerWidth) || value.innerWidth <= value.overlay.right ||
      value.barHeight !== WINDOWS_WINDOW_CHROME.topbarHeight ||
      typeof value.trailing !== 'number' || Math.abs(value.trailing - (value.innerWidth - value.overlay.right)) > 1 ||
      typeof value.bandColorDelta !== 'number' || !Number.isSafeInteger(value.bandColorDelta) || value.bandColorDelta < 0 ||
      value.bandColorDelta > WINDOWS_TITLEBAR_BAND_COLOR_TOLERANCE ||
      !record(value.screenshot) || !exactKeys(value.screenshot, ['bytes', 'sha256', 'source']) ||
      !Number.isSafeInteger(value.screenshot.bytes) || (value.screenshot.bytes as number) < 20000 || (value.screenshot.bytes as number) > 64 * 1024 * 1024 ||
      typeof value.screenshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.screenshot.sha256) ||
      (value.screenshot.source !== 'window' && value.screenshot.source !== 'content')) fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');
  return {name: scenario.name, theme: scenario.theme, scale: scenario.scale, maximized: scenario.maximized, frame: 'win-overlay',
    devicePixelRatio: value.devicePixelRatio, overlay: {visible: true, right: value.overlay.right}, innerWidth: value.innerWidth,
    barHeight: value.barHeight, trailing: value.trailing, bandColorDelta: value.bandColorDelta as number,
    screenshot: {bytes: value.screenshot.bytes as number, sha256: value.screenshot.sha256 as string, source: value.screenshot.source}};
}
interface FileObservation {file: boolean; directory: boolean; link: boolean; size: number; canonical: string}
interface SmokeServices {
  platform: NodeJS.Platform; arch: string; environment: NodeJS.ProcessEnv;
  inspect(file: string): Promise<FileObservation>;
  mkdir(directory: string, recursive: boolean): Promise<void>;
  read(file: string): Promise<string>;
  write(file: string, value: WindowsLaunchReport | FailureReport | WindowsTitleBarScreenshotsReport | WindowsTitleBarScreenshotDiagnostic): Promise<void>;
  expected(): Promise<ExpectedPackage>;
  packagedMetadata(archive: string): Promise<unknown>;
  launch(binary: string, environment: NodeJS.ProcessEnv, workspace: string): Promise<void>;
}
interface LaunchTransport {
  spawn(file: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  schedule(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
  terminate(pid: number, environment: NodeJS.ProcessEnv): Promise<void>;
}
const exec = promisify(execFile);
interface TerminationOptions {env: NodeJS.ProcessEnv; windowsHide: true; timeout: 10000; shell: false}
export async function terminateOwnedWindowsTree(pid: number, environment: NodeJS.ProcessEnv,
  execute: (file: string, args: readonly string[], options: TerminationOptions) => Promise<void> = async (file, args, options) => {await exec(file, [...args], options);}): Promise<void> {
  const systemRoot = environment.SystemRoot;
  if (!Number.isSafeInteger(pid) || pid <= 1 || !systemRoot || !absoluteLocalPath(systemRoot)) fail('WINDOWS_SMOKE_APP_STOP_UNCONFIRMED');
  // A PID from this live ChildProcess is the only authority; never use /IM or enumerate other app instances.
  await execute(paths.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {env: environment, windowsHide: true, timeout: 10000, shell: false});
}
const defaultLaunchTransport: LaunchTransport = {
  spawn: (file, args, options) => spawn(file, [...args], options), schedule: setTimeout, cancel: clearTimeout,
  terminate: terminateOwnedWindowsTree,
};
export async function launchWindowsPackage(binary: string, environment: NodeJS.ProcessEnv, workspace: string, transport: LaunchTransport = defaultLaunchTransport): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {child = transport.spawn(binary, [], {env: environment, cwd: workspace, shell: false, windowsHide: false, stdio: 'ignore'});}
    catch {reject(new SmokeFailure('WINDOWS_SMOKE_APP_SPAWN_FAILED')); return;}
    let finished = false, exited = false, timedOut = false;
    const finish = (code?: FailureCode) => {
      if (finished) return;
      finished = true; transport.cancel(timer);
      if (code) reject(new SmokeFailure(code)); else resolve();
    };
    const timer = transport.schedule(() => {
      if (finished || exited || child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      if (!Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 1) {child.unref(); finish('WINDOWS_SMOKE_APP_STOP_UNCONFIRMED'); return;}
      void transport.terminate(child.pid, environment).then(() => {child.unref(); finish('WINDOWS_SMOKE_APP_TIMEOUT');}, () => {
        if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        child.unref(); finish('WINDOWS_SMOKE_APP_STOP_UNCONFIRMED');
      });
    }, WINDOWS_SMOKE_TIMEOUT_MS);
    child.once('exit', () => {exited = true;});
    child.once('error', () => finish('WINDOWS_SMOKE_APP_SPAWN_FAILED'));
    child.once('close', (code, signal) => finish(timedOut ? 'WINDOWS_SMOKE_APP_TIMEOUT' : code === 0 && signal === null ? undefined : 'WINDOWS_SMOKE_APP_EXIT_FAILED'));
  });
}
function defaultServices(): SmokeServices {
  return {
    platform: process.platform, arch: process.arch, environment: process.env,
    async inspect(file) {const info = await lstat(file); return {file: info.isFile(), directory: info.isDirectory(), link: info.isSymbolicLink(), size: info.size, canonical: await realpath(file)};},
    async mkdir(directory, recursive) {await mkdir(directory, {recursive});}, read: file => readFile(file, 'utf8'),
    async write(file, value) {await writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});},
    async expected() {
      return windowsDevelopmentPackageExpectation(
        JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')),
        JSON.parse(await readFile(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')));
    },
    async packagedMetadata(archive) {return readWindowsPackageMetadata(archive);},
    launch: launchWindowsPackage,
  };
}
function canonical(file: string, info: FileObservation): boolean {return !info.link && paths.normalize(info.canonical).toLowerCase() === paths.normalize(file).toLowerCase();}
async function runTitleBarScreenshots(options: SmokeArguments & {screenshots: string}, services: SmokeServices,
  environment: NodeJS.ProcessEnv): Promise<void> {
  const directory = options.screenshots;
  try {await services.mkdir(directory, true);} catch {fail('WINDOWS_SMOKE_SCREENSHOT_FAILED');}
  const evidenceFile = paths.join(paths.dirname(directory), 'screenshots.json');
  const scenarios: WindowsTitleBarScreenshot[] = [];
  const writeEvidence = async (ok: boolean) => {
    try {
      await services.mkdir(paths.dirname(evidenceFile), true);
      await services.write(evidenceFile, {schemaVersion: 1, scope: 'windows-titlebar-screenshots', ok, scenarios: [...scenarios]});
    } catch { /* The main smoke evidence still records the fixed failure code. */ }
  };
  try {
    for (const scenario of WINDOWS_TITLEBAR_SCENARIOS) {
      const resultFile = paths.join(options.workspace, `screenshot-${scenario.name}.json`);
      const pngFile = paths.join(directory, `${scenario.name}.png`);
      const scenarioEnvironment = {...environment, MIOON_DESKTOP_SMOKE_OUTPUT: resultFile,
        MIOON_DESKTOP_WINDOWS_SMOKE_SCREENSHOT: pngFile, MIOON_DESKTOP_WINDOWS_SMOKE_SCENARIO: scenario.name,
        MIOON_DESKTOP_WINDOWS_SMOKE_THEME: scenario.theme, MIOON_DESKTOP_WINDOWS_SMOKE_MAXIMIZED: scenario.maximized ? '1' : '0',
        MIOON_DESKTOP_WINDOWS_SMOKE_SCALE: String(scenario.scale)};
      try {await services.launch(options.binary, scenarioEnvironment, options.workspace);} catch {fail('WINDOWS_SMOKE_SCREENSHOT_FAILED');}
      let reportInfo: FileObservation;
      try {reportInfo = await services.inspect(resultFile);} catch {fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');}
      if (!reportInfo.file || !canonical(resultFile, reportInfo) || reportInfo.size < 1 || reportInfo.size > maximumReportBytes) fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');
      let report: unknown;
      let reportText: string | undefined;
      try {
        reportText = await services.read(resultFile);
        if (reportText.length > maximumReportBytes) reportText = undefined;
        report = reportText === undefined ? undefined : JSON.parse(reportText) as unknown;
      } catch {fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');}
      let validated: WindowsTitleBarScreenshot;
      try {validated = validateWindowsTitleBarScreenshot(report, scenario);} catch (error) {
        const check = screenshotCheckFailureName(report), message = sanitizedFailureMessage(report), detail = screenshotCheckFailureDetail(report);
        const diagnostic: WindowsTitleBarScreenshotDiagnostic = check !== undefined
          ? {schemaVersion: 1, scope: 'windows-titlebar-screenshots', ok: false, scenario: scenario.name, check, ...(detail === undefined ? {} : {detail})}
          : message !== undefined ? {schemaVersion: 1, scope: 'windows-titlebar-screenshots', ok: false, scenario: scenario.name, message}
          : {schemaVersion: 1, scope: 'windows-titlebar-screenshots', ok: false, scenario: scenario.name};
        try {await services.write(paths.join(directory, `${scenario.name}.invalid.json`), diagnostic);}
        catch { /* The main smoke evidence still records the fixed failure code. */ }
        if (check !== undefined) {
          const failure = new SmokeFailure('WINDOWS_SMOKE_SCREENSHOT_INVALID');
          throw Object.assign(failure, {check});
        }
        throw error;
      }
      let pngInfo: FileObservation;
      try {pngInfo = await services.inspect(pngFile);} catch {fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');}
      if (!pngInfo.file || !canonical(pngFile, pngInfo) || pngInfo.size !== validated.screenshot.bytes) fail('WINDOWS_SMOKE_SCREENSHOT_INVALID');
      scenarios.push(validated);
    }
    await writeEvidence(true);
  } catch (error) {
    await writeEvidence(false);
    throw error;
  }
}
export async function runWindowsDevelopmentSmoke(args: readonly string[], services: SmokeServices = defaultServices()): Promise<WindowsLaunchReport | FailureReport> {
  let options: SmokeArguments | undefined;
  let screenshotRun: {options: SmokeArguments & {screenshots: string}; environment: NodeJS.ProcessEnv} | undefined;
  let result: WindowsLaunchReport | FailureReport;
  const optionalText = async (file: string): Promise<string | undefined> => {
    try {const text = await services.read(file); return typeof text === 'string' && text.length > 0 ? text : undefined;}
    catch {return undefined;}
  };
  const parsed = (text: string | undefined): unknown => {
    if (text === undefined) return undefined;
    try {return JSON.parse(text) as unknown;} catch {return undefined;}
  };
  try {
    if (services.platform !== 'win32' || services.arch !== 'x64') fail('WINDOWS_SMOKE_REQUIRES_WIN32_X64');
    options = parseWindowsSmokeArguments(args);
    let binary: FileObservation;
    try {binary = await services.inspect(options.binary);} catch {fail('WINDOWS_SMOKE_BINARY_INVALID');}
    if (!binary.file || !canonical(options.binary, binary)) fail('WINDOWS_SMOKE_BINARY_INVALID');
    let expected: ExpectedPackage;
    try {
      expected = await services.expected();
      const archive = paths.join(paths.dirname(options.binary), 'resources', 'app.asar'), info = await services.inspect(archive);
      if (!info.file || !canonical(archive, info) || info.size < 1 || info.size > 512 * 1024 * 1024) fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');
      validateWindowsDevelopmentPackage(await services.packagedMetadata(archive), expected);
    } catch {fail('WINDOWS_SMOKE_PACKAGE_IDENTITY_INVALID');}
    const tools: string[] = [];
    for (const name of ['MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH']) {
      const file = services.environment[name];
      if (!file || !absoluteLocalPath(file) || paths.extname(file).toLowerCase() !== '.exe') fail('WINDOWS_SMOKE_MEDIA_TOOLS_REQUIRED');
      let info: FileObservation;
      try {info = await services.inspect(file);} catch {fail('WINDOWS_SMOKE_MEDIA_TOOLS_REQUIRED');}
      if (!info.file || !canonical(file, info)) fail('WINDOWS_SMOKE_MEDIA_TOOLS_REQUIRED');
      tools.push(file);
    }
    try {
      await services.mkdir(paths.dirname(options.workspace), true);
      const parent = await services.inspect(paths.dirname(options.workspace));
      if (!parent.directory || !canonical(paths.dirname(options.workspace), parent)) fail('WINDOWS_SMOKE_WORKSPACE_UNAVAILABLE');
      // No recursive mkdir here: existing workspaces/reports may belong to another run.
      await services.mkdir(options.workspace, false);
      // The app creates its own user data through the native ACL helper; the
      // driver only requires a fresh absolute path with an existing parent.
      try {await services.inspect(options.userData); fail('WINDOWS_SMOKE_WORKSPACE_UNAVAILABLE');}
      catch (error) {if (error instanceof SmokeFailure) throw error;}
      const userDataParent = await services.inspect(paths.dirname(options.userData));
      if (!userDataParent.directory || !canonical(paths.dirname(options.userData), userDataParent)) fail('WINDOWS_SMOKE_WORKSPACE_UNAVAILABLE');
    } catch (error) {if (error instanceof SmokeFailure) throw error; fail('WINDOWS_SMOKE_WORKSPACE_UNAVAILABLE');}
    const environment = windowsSmokeEnvironment(services.environment, options.workspace, options.userData, tools[0], tools[1]);
    const reportFile = paths.join(options.workspace, 'result.json');
    let launchError: unknown;
    try {await services.launch(options.binary, environment, options.workspace);} catch (error) {launchError = error;}
    if (launchError !== undefined) {
      const code = smokeFailureCode(launchError), report = parsed(await optionalText(reportFile));
      const reportedCheck = appCheckFailureName(report), startupReason = startupFailureReason(report);
      if (reportedCheck !== undefined) result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_CHECK_FAILED', check: reportedCheck};
      else if (startupReason !== undefined) result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_STARTUP_FAILED', reason: startupReason};
      else if (code === 'WINDOWS_SMOKE_APP_TIMEOUT' && (() => {
        try {validateWindowsLaunchReport(report, expected); return true;} catch {return false;}
      })()) result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_APP_QUIT_TIMEOUT'};
      else {
        const phase = phaseMarkerName(parsed(await optionalText(`${reportFile}.phase`)));
        result = phase === undefined ? {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code}
          : {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code, phase};
      }
    } else {
      let info: FileObservation;
      try {info = await services.inspect(reportFile);} catch {info = {file: false, directory: false, link: false, size: 0, canonical: ''};}
      if (!info.file) fail('WINDOWS_SMOKE_REPORT_MISSING');
      if (!canonical(reportFile, info) || info.size > maximumReportBytes) fail('WINDOWS_SMOKE_REPORT_INVALID');
      let value: unknown;
      try {
        const text = await services.read(reportFile);
        if (Buffer.byteLength(text) > maximumReportBytes || Buffer.byteLength(text) !== info.size) fail('WINDOWS_SMOKE_REPORT_INVALID');
        value = JSON.parse(text) as unknown;
      } catch (error) {if (error instanceof SmokeFailure) throw error; fail('WINDOWS_SMOKE_REPORT_INVALID');}
      const reportedCheck = appCheckFailureName(value), startupReason = startupFailureReason(value);
      if (reportedCheck !== undefined) result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_CHECK_FAILED', check: reportedCheck};
      else if (startupReason !== undefined) result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_STARTUP_FAILED', reason: startupReason};
      else if (appStartupErrorShape(value)) {
        const phase = phaseMarkerName(parsed(await optionalText(`${reportFile}.phase`)));
        result = phase === undefined ? {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_APP_STARTUP_ERROR'}
          : {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_APP_STARTUP_ERROR', phase};
      } else {
        result = validateWindowsLaunchReport(value, expected);
        if (options.screenshots !== undefined) screenshotRun = {options: {...options, screenshots: options.screenshots}, environment};
      }
    }
  } catch (error: unknown) {
    const check = error instanceof SmokeFailure && 'check' in error && typeof (error as {check?: unknown}).check === 'string' &&
      WINDOWS_TITLEBAR_SCREENSHOT_PHASES.includes((error as {check: string}).check) ? (error as {check: string}).check : undefined;
    result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: smokeFailureCode(error), ...(check === undefined ? {} : {check})};
  }
  if (options && result.ok && screenshotRun !== undefined) {
    try {await runTitleBarScreenshots(screenshotRun.options, services, screenshotRun.environment);}
    catch (error) {result = {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: smokeFailureCode(error)};}
  }
  if (options) {
    try {
      await services.mkdir(paths.dirname(options.output), true);
      await services.write(options.output, result);
    } catch {return {schemaVersion: 1, scope: 'windows-development-launch', ok: false, code: 'WINDOWS_SMOKE_OUTPUT_FAILED'};}
  }
  return result;
}
if (isMain(import.meta.url)) {
  const result = await runWindowsDevelopmentSmoke(process.argv.slice(2));
  if (result.ok) process.stdout.write('WINDOWS_DEVELOPMENT_SMOKE_PASSED\n');
  else {process.stderr.write(`${result.code}\n`); process.exitCode = 1;}
}
