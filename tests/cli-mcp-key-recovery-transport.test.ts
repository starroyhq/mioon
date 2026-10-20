import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {canonicalImageInput, IMAGE_FIXED_OPTIONS, IMAGE_MODELS, DEFAULT_IMAGE_CONFIGURATION} from '@mioon/contracts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const hash = (value: unknown): string => createHash('sha256').update(canonicalImageInput(value)).digest('hex');
const copy = <T>(value: T): T => structuredClone(value);
const childEnv = (extra: Record<string, string>): Record<string, string> => ({...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']
  .filter((key): key is string => process.env[key] !== undefined).map(key => [key, process.env[key] as string])), MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra});

type FaultMode = {status?: number; body?: unknown; fault?: 'drop' | 'truncate' | 'bad-review'} | null;
interface WireRecord {operation?: string; inputHash: string; status?: number; body?: unknown}
interface CallEnvelope {ok?: boolean; error?: {code?: string; retryable?: boolean; message?: string; details?: Record<string, unknown>}; [key: string]: unknown}
interface FixtureReport {label: string; cases: Array<Record<string, unknown>>; cleanup: {mcpClosed?: boolean; mcpCloseEvent?: boolean; proxyClosed?: boolean; backendClosed?: boolean; cliChildren?: Array<{pid?: number | null; reaped: boolean}>; allCliReaped?: boolean; ownedWorkspaceRemoved?: boolean}; providerNetworkCalls?: number}
interface FixtureCall { (kind: string, operation: string, input: Record<string, unknown>, expectedExit: number): Promise<CallEnvelope> }
interface FixtureRaw { (route: string, input?: unknown, method?: string): Promise<Record<string, unknown>> }
interface Fixture {token: string; requests: unknown[]; wire: WireRecord[]; report: FixtureReport; syntheticSecret: () => string; set: (value: FaultMode) => void; call: FixtureCall; raw: FixtureRaw; rpc: (operation: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>}

async function fixture(t: TestContext, label: string, {business = false}: {business?: boolean} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-key-transport-'));
  const token = randomBytes(32).toString('hex');
  const sensitive: string[] = [token];
  const requests: unknown[] = [], wire: WireRecord[] = [], children: ChildProcess[] = [];
  const report: FixtureReport = {label, cases: [], cleanup: {}};
  let backend: Awaited<ReturnType<typeof startServer>> | undefined, proxy: http.Server | undefined, mcp: Client | undefined, transport: StdioClientTransport | undefined;
  let mode: FaultMode, networkCalls = 0, mcpClosed: Promise<void> = Promise.resolve();
  t.after(async () => {
    let cleanupResults: PromiseSettledResult<unknown>[] | undefined;
    try {
      cleanupResults = await Promise.allSettled([
        (async () => {
          await mcp?.close();
          // SDK close clears pid before process exit; await its actual close event.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {await Promise.race([mcpClosed, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('MCP close event timed out')), 3000);})]);}
          finally {clearTimeout(timer);}
          report.cleanup.mcpClosed = !mcp || report.cleanup.mcpCloseEvent === true;
        })(),
        (async () => {if (proxy) {proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve()));} report.cleanup.proxyClosed = !proxy?.listening;})(),
        (async () => {await backend?.close(); report.cleanup.backendClosed = true;})(),
      ]);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await once(child, 'close');
      }
      report.cleanup.cliChildren = children.map(child => ({pid: child.pid, reaped: child.exitCode !== null || child.signalCode !== null}));
      report.cleanup.allCliReaped = report.cleanup.cliChildren.every(child => child.reaped);
      report.providerNetworkCalls = networkCalls;
      if (report.cleanup.backendClosed) {await rm(root, {recursive: true, force: true}); report.cleanup.ownedWorkspaceRemoved = true;}
      if (process.env.MIOON_TRANSPORT_EVIDENCE_DIR) await writeFile(path.join(process.env.MIOON_TRANSPORT_EVIDENCE_DIR, `${label}.json`), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    }
    assert.ok(cleanupResults.every(result => result.status === 'fulfilled'), 'all fixture cleanup operations completed');
    assert.equal(report.cleanup.mcpClosed, true);
    assert.equal(report.cleanup.allCliReaped, true);
    assert.equal(networkCalls, 0, 'review preparation never reaches a provider');
  });
  if (business) backend = await startServer({dataDir: path.join(root, 'workspace'), port: 0, token,
    imageNetwork: {lookup() {networkCalls++; throw Error('Unexpected synthetic provider lookup');}, httpsRequest() {networkCalls++; throw Error('Unexpected synthetic provider request');}} as never});
  proxy = http.createServer(async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      assert.equal(request.url, '/api/rpc');
      assert.equal(request.method, 'POST');
      assert.ok(request.headers.authorization === `Bearer ${token}`, 'fixture auth matches');
      let raw = '';
      for await (const chunk of request) {raw += chunk; if (raw.length > 65536) throw Error('Fixture request cap');}
      const body = JSON.parse(raw) as {operation: string; input: unknown};
      requests.push(body);
      let status = mode?.status ?? 200, value = mode?.body;
      if (backend && !mode?.body) {
        const upstream = await fetch(`${backend.url}/api/rpc`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: raw, signal: AbortSignal.timeout(5000)});
        status = upstream.status; value = await upstream.json();
      }
      wire.push({operation: body.operation, inputHash: hash(body.input), status, body: value});
      if (mode?.fault === 'drop') {response.destroy(); return;}
      if (mode?.fault === 'truncate') {
        // A complete HTTP body containing incomplete JSON distinguishes the
        // response-body parse failure from a socket reset before response headers.
        response.writeHead(200, {'content-type': 'application/json'});
        response.end('{"ok":true,"data":'); return;
      }
      response.writeHead(status, {'content-type': 'application/json'});
      response.end(JSON.stringify(mode?.fault === 'bad-review' ? {ok: true, data: {}} : value));
    } catch {response.destroy();}
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const proxyAddress = proxy.address(); if (!proxyAddress || typeof proxyAddress === 'string') throw Error('Expected a bound TCP address');
  const env = childEnv({MIOON_BASE_URL: `http://127.0.0.1:${proxyAddress.port}`, MIOON_TOKEN: token, TMPDIR: root, TMP: root, TEMP: root});
  mcp = new Client({name: 'key-recovery-wire-acceptance', version: '1.0.0'}, {capabilities: {}});
  mcpClosed = new Promise(resolve => {mcp!.onclose = () => {report.cleanup.mcpCloseEvent = true; resolve();};});
  transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env, stderr: 'pipe'});
  let mcpStderr = '';
  (transport.stderr as unknown as {setEncoding(encoding: string): {on(event: string, listener: (chunk: string) => void): void}} | null)?.setEncoding('utf8').on('data', (chunk: string) => {mcpStderr += chunk;});
  await mcp.connect(transport);
  async function call(kind: string, operation: string, input: Record<string, unknown>, expectedExit: number): Promise<CallEnvelope> {
    const before = requests.length;
    let envelope: CallEnvelope, output: string, exit: number | null | undefined;
    if (kind === 'CLI') {
      const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)], {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
      children.push(child);
      let stdout = '', stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {stdout += chunk; if (stdout.length > 1048576) child.kill('SIGKILL');});
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {stderr += chunk; if (stderr.length > 1048576) child.kill('SIGKILL');});
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      let signal: NodeJS.Signals | null;
      try {[exit, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];} finally {clearTimeout(timer);}
      assert.equal(signal, null, 'CLI closes without forced termination');
      const lines = stdout.trim().split('\n');
      assert.equal(lines.length, 1, 'one CLI JSON envelope');
      envelope = JSON.parse(lines[0]) as CallEnvelope; output = stdout + stderr;
      assert.equal(exit, expectedExit);
      if (!envelope.ok) assert.ok(stderr.length > 0);
    } else {
      const result = await mcp!.callTool({name: operation.replaceAll('.', '_'), arguments: input});
      const content = result.content as Array<{type: string; text: string}>;
      envelope = JSON.parse(content.find(item => item.type === 'text')!.text) as CallEnvelope;
      assert.deepEqual(result.structuredContent, envelope);
      assert.equal(Boolean(result.isError), !envelope.ok);
      output = JSON.stringify(result) + mcpStderr;
    }
    const leaked = sensitive.some(value => output.includes(value));
    report.cases.push({transport: kind, operation, inputHash: hash(input), wireStatus: wire.at(-1)?.status,
      fault: mode?.fault ?? null, ok: envelope.ok, code: typeof envelope.error?.code === 'string' && !sensitive.some(value => (envelope.error!.code as string).includes(value)) ? envelope.error.code : null,
      exit, requestCount: requests.length - before, hasSubmissionOutcome: Object.hasOwn(envelope.error?.details ?? {}, 'submissionMayHaveSucceeded'),
      submissionMayHaveSucceeded: envelope.error?.details?.submissionMayHaveSucceeded, hasMutationProof: Object.hasOwn(envelope.error?.details ?? {}, 'mutationOutcome'),
      hasObservationProof: Object.hasOwn(envelope.error?.details ?? {}, 'observation'), containsFixtureCredential: leaked});
    assert.equal(leaked, false, `${kind} must not expose the generated fixture credential`);
    assert.deepEqual(requests.slice(before), [{operation, input}], 'exact input, one HTTP call and no automatic retry');
    if (!envelope.ok) assert.equal(envelope.error?.retryable, false);
    return envelope;
  }
  async function raw(route: string, input?: unknown, method = 'POST'): Promise<Record<string, unknown>> {
    const response = await fetch(backend!.url + route, {method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, ...(input === undefined ? {} : {body: JSON.stringify(input)}), signal: AbortSignal.timeout(5000)});
    const value = await response.json() as {ok?: boolean; data?: Record<string, unknown>}; assert.equal(value.ok, true); return value.data as Record<string, unknown>;
  }
  return {token, requests, wire, report, syntheticSecret() {const value = `synthetic-session-${randomBytes(32).toString('hex')}`; sensitive.push(value); return value;}, set(value: FaultMode) {mode = value;}, call, raw,
    rpc: (operation: string, input: Record<string, unknown> = {}) => raw('/api/rpc', {operation, input})};
}

function uncertain(envelope: CallEnvelope, operation: string, requestId: string): void {
  assert.equal(envelope.ok, false);
  const details = envelope.error?.details ?? {};
  assert.equal(details.operation, operation);
  assert.equal(details.requestId, requestId);
  assert.equal(details.submissionMayHaveSucceeded, true);
  assert.equal(Object.hasOwn(details, 'mutationOutcome'), false);
  assert.equal(Object.hasOwn(details, 'observation'), false);
  assert.match(details.recovery as string, /exact original input.*same requestId/);
}

test('real CLI and MCP preserve proof-specific rejection and HTTP status semantics', {timeout: 60000}, async (t: TestContext) => {
  const f = await fixture(t, 'proof-classification');
  const projectId = randomUUID(), requestId = randomUUID();
  const timeline = {projectId, requestId, expectedRevision: 1};
  const reference: Record<string, unknown> = {...timeline, edgeId: randomUUID(), expectedShotRevision: 1}; delete (reference as {expectedRevision?: number}).expectedRevision;
  const subject = {...timeline, subjectId: randomUUID(), assetId: randomUUID()};
  const comfy = {...timeline, taskId: randomUUID()};
  const proof = (operation: string) => ({mutationOutcome: 'not_applied', operation, projectId, requestId});
  const observation = {outcome: 'not_accepted', operation: 'image.task.observeRemote', projectId, taskId: comfy.taskId, requestId, inputHash: hash(comfy)};
  const cases: Array<[string, string, Record<string, unknown>, number, string, Record<string, unknown>, boolean, number]> = [
    ['timeline legacy proof', 'timeline.undo', timeline, 409, 'NOTHING_TO_UNDO', {mutationOutcome: 'not_applied', requestId}, true, 3],
    ['timeline wrong key', 'timeline.undo', timeline, 409, 'NOTHING_TO_UNDO', {mutationOutcome: 'not_applied', requestId: randomUUID()}, false, 3],
    ['timeline wrong operation', 'timeline.undo', timeline, 409, 'NOTHING_TO_UNDO', proof('timeline.redo'), false, 3],
    ['reference exact proof', 'reference.detach', reference, 409, 'REVISION_CONFLICT', proof('reference.detach'), true, 3],
    ['reference missing project', 'reference.detach', reference, 409, 'REVISION_CONFLICT', {mutationOutcome: 'not_applied', operation: 'reference.detach', requestId}, false, 3],
    ['reference wrong operation', 'reference.detach', reference, 409, 'REVISION_CONFLICT', proof('reference.attach'), false, 3],
    ['reference no proof', 'reference.detach', reference, 409, 'REVISION_CONFLICT', {submissionMayHaveSucceeded: false}, false, 3],
    ['subject exact proof', 'subject.version.add', subject, 409, 'SUBJECT_NO_CHANGE', proof('subject.version.add'), true, 3],
    ['subject wrong code domain', 'subject.version.add', subject, 409, 'REFERENCE_CONNECTED', proof('subject.version.add'), false, 3],
    ['subject wrong HTTP status', 'subject.version.add', subject, 500, 'SUBJECT_NO_CHANGE', proof('subject.version.add'), false, 6],
    ['Comfy exact proof', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_REVISION_CONFLICT', {observation}, true, 3],
    ['Comfy capacity 507', 'image.task.observeRemote', comfy, 507, 'COMFY_REMOTE_CAPACITY', {observation}, true, 6],
    ['Comfy wrong input hash', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_REVISION_CONFLICT', {observation: {...observation, inputHash: hash({...comfy, expectedRevision: 2})}}, false, 3],
    ['Comfy wrong operation', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_REVISION_CONFLICT', {observation: {...observation, operation: 'image.generate'}}, false, 3],
    ['Comfy wrong key', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_REVISION_CONFLICT', {observation: {...observation, requestId: randomUUID()}}, false, 3],
    ['Comfy wrong status', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_CAPACITY', {observation}, false, 3],
    ['Comfy absent proof', 'image.task.observeRemote', comfy, 409, 'COMFY_REMOTE_REVISION_CONFLICT', {submissionMayHaveSucceeded: false}, false, 3],
  ];
  for (const [name, operation, input, status, code, details, proven, exit] of cases) for (const kind of ['CLI', 'MCP']) await t.test(`${kind}: ${name}`, async () => {
    f.set({status, body: {ok: false, error: {code, message: 'Synthetic rejection', details: copy(details), status: 409, definitive: true, retryable: true}}});
    const result = await f.call(kind, operation, input, exit);
    assert.equal(result.error?.code, code);
    if (!proven) uncertain(result, operation, requestId);
    else {
      assert.equal(result.error?.details?.operation, operation);
      assert.equal(result.error?.details?.requestId, requestId);
      assert.equal(result.error?.details?.submissionMayHaveSucceeded, false);
      assert.equal(Object.hasOwn(result.error?.details ?? {}, 'recovery'), false);
      if (operation === 'image.task.observeRemote') assert.deepEqual(result.error?.details?.observation, observation);
      else assert.equal(result.error?.details?.mutationOutcome, 'not_applied');
    }
  });
});

test('nested review commits survive real wire loss and exact cross-client replay without approval', {timeout: 60000}, async (t: TestContext) => {
  const f = await fixture(t, 'nested-review-replay', {business: true});
  const project = await f.rpc('project.create', {name: 'Synthetic review transport acceptance'});
  // Live review preparation now requires the persisted workspace opt-in. This
  // fixture still rejects every provider I/O and never approves a paid review.
  const workspace = await f.rpc('workspace.settings.get');
  await f.rpc('workspace.settings.set', {expectedRevision: workspace.revision, liveGeneration: true});
  // The existing preparation guard requires a configured slot. This generated
  // fake value stays in this backend session; network adapters reject all I/O.
  const settings = await f.raw('/api/images/settings', {expectedRevision: 0, configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'session', value: f.syntheticSecret()}}, 'PUT');
  assert.equal((settings.secret as {storage?: string}).storage, 'session');
  let expectedReviews = 0;
  for (const kind of ['CLI', 'MCP']) for (const fault of ['drop', 'truncate', 'bad-review']) await t.test(`${kind}: committed review then ${fault}`, async () => {
    const input = {input: {projectId: project.id, requestId: randomUUID(), name: `Synthetic ${kind} ${fault}`, prompt: 'Only local immutable review metadata', providerId: 'openai', model: IMAGE_MODELS.openai, options: {...IMAGE_FIXED_OPTIONS}}, settingsRevision: settings.revision};
    const originalInput = copy(input);
    f.set({fault: fault as 'drop' | 'truncate' | 'bad-review'});
    const result = await f.call(kind, 'image.review.prepare', input, 4);
    assert.equal(result.error?.code, fault === 'drop' ? 'BACKEND_UNAVAILABLE' : 'BACKEND_PROTOCOL_ERROR');
    uncertain(result, 'image.review.prepare', input.input.requestId);
    assert.equal(JSON.stringify(result).includes(input.input.prompt), false, 'error does not echo full input');
    const committed = f.wire.at(-1)!.body as {ok?: boolean; data?: {state?: string; postAttempts?: number; taskId?: unknown}};
    assert.equal(committed.ok, true); assert.equal(committed.data?.state, 'pending');
    assert.equal(committed.data?.postAttempts, 0); assert.equal(committed.data?.taskId, null);
    const before = await f.rpc('image.review.list', {projectId: project.id, limit: 50});
    assert.equal((before.items as unknown[]).length, ++expectedReviews);
    f.set(null);
    const replay = await f.call(kind === 'CLI' ? 'MCP' : 'CLI', 'image.review.prepare', originalInput, 0);
    assert.deepEqual(replay, committed);
    assert.deepEqual(await f.rpc('image.review.list', {projectId: project.id, limit: 50}), before);
    assert.equal(((await f.rpc('image.task.list', {projectId: project.id})).items as unknown[]).length, 0);
    assert.equal(((await f.rpc('job.list', {projectId: project.id})) as unknown as unknown[]).length, 0);
  });
});

test('read errors keep exit classifications and sanitization across real CLI and MCP', {timeout: 30000}, async (t: TestContext) => {
  const f = await fixture(t, 'read-errors-and-sanitization');
  const privatePath = '/private/synthetic-credentials/access-token';
  for (const kind of ['CLI', 'MCP']) {
    const readStatuses: Array<[number, string, number]> = [[500, 'INTERNAL_ERROR', 1], [401, 'UNAUTHORIZED', 4], [503, 'BACKEND_UNAVAILABLE', 4], [409, 'REVISION_CONFLICT', 3]];
    for (const [status, code, exit] of readStatuses) await t.test(`${kind}: read HTTP ${status}`, async () => {
      f.set({status, body: {ok: false, error: {code, message: `Synthetic Bearer ${f.token}; raw ${f.token}`, details: {safe: 'retained', tokenFile: privatePath, connectionFile: privatePath, nested: {secret: f.token, reason: f.token}}}}});
      const value = await f.call(kind, 'project.list', {}, exit);
      assert.equal(value.error?.code, code);
      assert.equal(value.error?.details?.safe, 'retained');
      assert.equal(Object.hasOwn(value.error?.details ?? {}, 'submissionMayHaveSucceeded'), false);
      assert.equal(Object.hasOwn(value.error?.details ?? {}, 'recovery'), false);
      assert.equal(JSON.stringify(value).includes(privatePath), false);
    });
    for (const operation of ['project.list', 'image.request.get']) for (const fault of ['drop', 'truncate']) await t.test(`${kind}: ${operation} ${fault}`, async () => {
      const input = operation === 'project.list' ? {} : {projectId: randomUUID(), requestId: randomUUID()};
      f.set({fault: fault as 'drop' | 'truncate', body: {ok: true, data: null}});
      const value = await f.call(kind, operation, input, 4);
      assert.equal(value.error?.code, fault === 'drop' ? 'BACKEND_UNAVAILABLE' : 'BACKEND_PROTOCOL_ERROR');
      assert.deepEqual(value.error?.details, {operation});
    });
  }
});

test('backend-controlled error code and detail keys cannot expose the connection credential', {timeout: 15000}, async (t: TestContext) => {
  const f = await fixture(t, 'error-field-credential-redaction');
  for (const kind of ['CLI', 'MCP']) for (const field of ['code', 'detail-key']) await t.test(`${kind}: credential in ${field}`, async () => {
    const error = field === 'code' ? {code: `SYNTHETIC_${f.token}`, message: 'Synthetic failure', details: {}}
      : {code: 'INTERNAL_ERROR', message: 'Synthetic failure', details: {[`diagnostic-${f.token}`]: 'private field', safe: 'retained'}};
    f.set({status: 500, body: {ok: false, error}});
    const value = await f.call(kind, 'project.list', {}, field === 'code' ? 6 : 1);
    assert.equal(Object.hasOwn(value.error?.details ?? {}, 'submissionMayHaveSucceeded'), false);
    if (field === 'detail-key') assert.equal(value.error?.details?.safe, 'retained');
  });
});
