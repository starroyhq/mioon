import {execFile} from 'node:child_process';
import {lstat, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {operationDefinition, schemas} from '@mioon/client';
import {macCliLauncherBundleEntry, macCliLauncherIdentifier, verifyMacCliLauncherFile} from '../../apps/desktop/cli-launcher-binary.ts';
import {identityForChannel} from '../../apps/desktop/identity.ts';
import {isMcpOperationAllowed} from '../../apps/mcp/src/tool-policy.ts';
import {runAppleStapler} from './apple-notarization.ts';
import {CheckFailure, command, fail} from './media-environment.ts';

export const firstLaunchBudgetMs = 1000;
const commandTimeoutMs = 20_000;
const warmSamples = 5;
const identity = identityForChannel('production');
const unavailable = 'CLI_RUNTIME_UNAVAILABLE' as const;
const stoppedMessage = 'Mioon 没在运行，请先打开 Mioon。';
const policyProcesses = ['syspolicyd', 'amfid', 'taskgated', 'trustd', 'CoreServicesUIAgent'] as const;
type PolicyProcess = typeof policyProcesses[number];
type JsonObject = Record<string, unknown>;

interface Duration {
  durationMs: number;
  spawnMs: number | null;
  firstOutputMs: number | null;
}
interface Stopped extends Duration {exitCode: 4; errorCode: typeof unavailable}
interface PolicyEvents {
  systemLog: 'matched' | 'no-launch-specific-events' | 'unavailable';
  policyEvents: Partial<Record<PolicyProcess, number>>;
  ticketOrNotarizationEvents: number;
  cacheEvents: number;
}
export interface ReleaseCliSmokeEvidence {
  schemaVersion: 1;
  channel: 'production';
  version: string;
  installLayout: 'copied-from-final-dmg';
  latencyBudgetMs: typeof firstLaunchBudgetMs;
  quarantine?: {sourceApp: boolean; installedApp: boolean; launcher: boolean};
  firstStopped?: Stopped & {withinBudget: boolean};
  warmStoppedMs?: number[];
  running?: {versionMs: number; doctorMs: number; projectListMs: number;
    mcpInitializeMs: number; mcpToolsListMs: number; mcpToolCount: number};
  stoppedAfterQuit?: Stopped;
  slowFirstLaunch?: PolicyEvents;
}

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function jsonLine(stdout: Buffer, code: string): JsonObject {
  try {
    const line = new TextDecoder('utf-8', {fatal: true}).decode(stdout);
    if (!/^\{[^\r\n]+\}\n$/.test(line)) fail(code);
    return object(JSON.parse(line));
  } catch { fail(code); }
}

async function quarantine(file: string): Promise<boolean> {
  return (await command('/usr/bin/xattr', [file], 'CLI_SMOKE_XATTR_UNAVAILABLE')).split(/\r?\n/).includes('com.apple.quarantine');
}

export async function installReleaseApp(source: string, root: string): Promise<string> {
  const installation = path.join(root, 'Applications');
  await mkdir(installation, {mode: 0o700});
  const app = path.join(installation, path.basename(source));
  await command('/usr/bin/ditto', ['--rsrc', '--extattr', '--qtn', source, app], 'CLI_SMOKE_APP_COPY_FAILED', {timeout: 120_000});
  return app;
}

function developerIdRequirement(identifier: string): string {
  return [
    `identifier "${identifier}"`,
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    'certificate leaf[subject.OU] = "A7C3K354YP"',
  ].join(' and ');
}

export function launcherSmokeEnvironment(home: string, tmp: string, emptyPath: string, userData: string) {
  return {HOME: home, CFFIXED_USER_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PATH: emptyPath,
    LC_ALL: 'zh_CN.UTF-8', MIOON_CLI_USER_DATA: userData};
}

interface NativeResult extends Duration {code: number; stdout: Buffer; stderr: Buffer}
function executeLauncher(launcher: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let spawnMs: number | null = null, firstOutputMs: number | null = null;
    const child = execFile(launcher, args, {cwd, env, encoding: 'buffer', timeout: commandTimeoutMs,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024}, (error, stdout, stderr) => {
      const code = error ? typeof error.code === 'number' && !error.signal ? error.code : null : 0;
      if (code === null) {reject(new CheckFailure('CLI_LAUNCHER_EXECUTION_FAILED')); return;}
      resolve({code, stdout, stderr, spawnMs, firstOutputMs, durationMs: performance.now() - started});
    });
    child.once('spawn', () => {spawnMs = performance.now() - started;});
    const markOutput = () => {firstOutputMs ??= performance.now() - started;};
    child.stdout?.once('data', markOutput);
    child.stderr?.once('data', markOutput);
    child.stdin?.end();
  });
}

function logTime(ms: number): string {
  const date = new Date(ms);
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Record counts tied to this launch; raw unified-log messages never leave the runner. */
export function summarizeLaunchPolicyLog(stdout: string, startedAt: number, endedAt: number, launcher: string): PolicyEvents {
  const result: PolicyEvents = {systemLog: 'no-launch-specific-events', policyEvents: {}, ticketOrNotarizationEvents: 0, cacheEvents: 0};
  let entries: unknown;
  try { entries = JSON.parse(stdout); } catch { return {...result, systemLog: 'unavailable'}; }
  if (!Array.isArray(entries)) return {...result, systemLog: 'unavailable'};
  const identifier = macCliLauncherIdentifier(identity);
  for (const entry of entries) {
    const row = object(entry);
    if (typeof row.eventMessage !== 'string' || typeof row.processImagePath !== 'string' || typeof row.timestamp !== 'string') continue;
    const timestamp = Date.parse(row.timestamp.replace(' ', 'T'));
    if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > endedAt) continue;
    if (!row.eventMessage.includes(launcher) && !row.eventMessage.includes(identifier)) continue;
    const processName = policyProcesses.find(name => name === path.basename(String(row.processImagePath)));
    if (!processName) continue;
    result.systemLog = 'matched';
    result.policyEvents[processName] = (result.policyEvents[processName] ?? 0) + 1;
    if (/ticket|notari/i.test(row.eventMessage)) result.ticketOrNotarizationEvents++;
    if (/\bcache\b/i.test(row.eventMessage)) result.cacheEvents++;
  }
  return result;
}

async function launchPolicyLog(startedAt: number, endedAt: number, launcher: string): Promise<PolicyEvents> {
  const processes = policyProcesses.map(name => JSON.stringify(name)).join(', ');
  const matches = [launcher, macCliLauncherIdentifier(identity)].map(value => `eventMessage CONTAINS ${JSON.stringify(value)}`).join(' OR ');
  try {
    const stdout = await command('/usr/bin/log', ['show', '--style', 'json', '--info', '--debug',
      '--start', logTime(startedAt), '--end', logTime(endedAt + 1000), '--predicate', `process IN {${processes}} AND (${matches})`],
    'CLI_SMOKE_POLICY_LOG_UNAVAILABLE', {timeout: 15_000});
    return summarizeLaunchPolicyLog(stdout, startedAt, endedAt, launcher);
  } catch { return {systemLog: 'unavailable', policyEvents: {}, ticketOrNotarizationEvents: 0, cacheEvents: 0}; }
}

export function createReleaseCliSmoke(input: {
  sourceApp: string; installedApp: string; root: string; version: string; env: ReturnType<typeof launcherSmokeEnvironment>;
}) {
  const {sourceApp, installedApp, root, version, env} = input;
  const launcher = path.join(installedApp, macCliLauncherBundleEntry(identity));
  const evidence: ReleaseCliSmokeEvidence = {schemaVersion: 1, channel: 'production', version,
    installLayout: 'copied-from-final-dmg', latencyBudgetMs: firstLaunchBudgetMs};

  async function assertStopped(): Promise<Stopped> {
    const {code, stdout, stderr, ...timing} = await executeLauncher(launcher, ['doctor'], root, env);
    const result = jsonLine(stdout, 'CLI_STOPPED_INVALID_REPLY'), error = object(result.error);
    if (code !== 4 || result.ok !== false || error.code !== unavailable || error.message !== stoppedMessage ||
        !stderr.equals(Buffer.from(`mioon: ${unavailable}: ${stoppedMessage}\n`))) fail('CLI_STOPPED_DIAGNOSTIC_MISMATCH');
    return {...timing, exitCode: 4, errorCode: unavailable};
  }

  async function assertNoDiscovery(): Promise<void> {
    const descriptorExists = await lstat(path.join(env.MIOON_CLI_USER_DATA, 'mcp-connection.json')).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    });
    if (descriptorExists) fail('CLI_SMOKE_DISCOVERY_STILL_PRESENT');
  }

  async function beforeAppStarts(): Promise<void> {
    // Strict verification reads the signed bytes. No Gatekeeper assessment or
    // earlier invocation of the launcher is performed in this smoke harness.
    await verifyMacCliLauncherFile(launcher).catch(() => fail('CLI_SMOKE_LAUNCHER_INVALID'));
    await command('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures',
      `-R=${developerIdRequirement(identity.appId)}`, installedApp], 'CLI_SMOKE_APP_SIGNATURE_INVALID');
    await command('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures',
      `-R=${developerIdRequirement(macCliLauncherIdentifier(identity))}`, launcher], 'CLI_SMOKE_LAUNCHER_SIGNATURE_INVALID');
    evidence.quarantine = {sourceApp: await quarantine(sourceApp), installedApp: await quarantine(installedApp), launcher: await quarantine(launcher)};
    await assertNoDiscovery();
    const startedAt = Date.now();
    const stopped = await assertStopped();
    const endedAt = Date.now();
    evidence.firstStopped = {...stopped, withinBudget: stopped.durationMs <= firstLaunchBudgetMs};
    if (!evidence.firstStopped.withinBudget) evidence.slowFirstLaunch = await launchPolicyLog(startedAt, endedAt, launcher);
    evidence.warmStoppedMs = [];
    for (let i = 0; i < warmSamples; i++) evidence.warmStoppedMs.push((await assertStopped()).durationMs);
    // A valid ticket on the copied app binds the samples to the already
    // notarized artifact. Looking up the ticket here leaves the first run cold.
    await runAppleStapler('validate', installedApp);
  }

  async function duringApp(): Promise<void> {
    async function run(args: string[], code: string): Promise<{durationMs: number; data: unknown}> {
      const reply = await executeLauncher(launcher, args, root, env);
      const body = jsonLine(reply.stdout, code);
      if (reply.code !== 0 || body.ok !== true) fail(code);
      return {durationMs: reply.durationMs, data: body.data};
    }
    const localVersion = await run(['--version'], 'CLI_VERSION_COMMAND_FAILED'), payload = object(localVersion.data);
    if (payload.name !== 'mioon' || payload.version !== version) fail('CLI_VERSION_MISMATCH');
    const doctor = await run(['doctor'], 'CLI_DOCTOR_FAILED');
    if (object(doctor.data).ready !== true) fail('CLI_RUNTIME_NOT_READY');
    const projects = await run(['project', 'list'], 'CLI_PROJECT_LIST_FAILED');
    if (!Array.isArray(projects.data)) fail('CLI_PROJECT_LIST_INVALID');
    const expected = [...Object.keys(schemas).filter(isMcpOperationAllowed).map(name => operationDefinition(name).toolName),
      'mioon_doctor', 'mioon_capabilities', 'mioon_schema'].sort();
    const client = new Client({name: 'mioon-release-cli-smoke', version: '1'});
    try {
      const start = performance.now();
      await client.connect(new StdioClientTransport({command: launcher, args: ['mcp'], cwd: root, env, stderr: 'ignore'}),
        {timeout: commandTimeoutMs});
      const mcpInitializeMs = performance.now() - start;
      if (client.getServerVersion()?.name !== 'mioon') fail('CLI_MCP_IDENTITY_MISMATCH');
      const listStart = performance.now();
      const {tools} = await client.listTools(undefined, {timeout: commandTimeoutMs});
      const mcpToolsListMs = performance.now() - listStart;
      const actual = tools.map(({name}) => name).sort();
      if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail('CLI_MCP_TOOLS_MISMATCH');
      evidence.running = {versionMs: localVersion.durationMs, doctorMs: doctor.durationMs, projectListMs: projects.durationMs,
        mcpInitializeMs, mcpToolsListMs, mcpToolCount: tools.length};
    } catch (error) {
      if (error instanceof CheckFailure) throw error;
      fail('CLI_MCP_PROTOCOL_FAILED');
    } finally {
      await client.close().catch(() => {});
    }
  }

  async function afterAppStops(): Promise<void> {
    await assertNoDiscovery();
    evidence.stoppedAfterQuit = await assertStopped();
  }

  return {evidence, beforeAppStarts, duringApp, afterAppStops};
}
