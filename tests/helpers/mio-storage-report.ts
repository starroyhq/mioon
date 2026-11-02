import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {mock} from 'node:test';
import {assembleRequest} from '../../packages/business/src/agent/mio-assembly.ts';
import {createMioAssembly} from '../../packages/business/src/agent/mio-assembly.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../../packages/business/src/agent/mio-storage.ts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {registerProjectTransactionObserver} from '../../packages/business/src/project-file/store.ts';
import {openStore} from '../../packages/business/src/project-file/index.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import type {MioStorageSnapshot} from '../../packages/contracts/src/mio-storage.ts';
import {advanceStreamingClock, contextReportScenario, modelOutput} from './agent-task-context-report.ts';
import {authorizeTestScope} from './agent-authorizations.ts';
import {createMioTestFixture} from './mio-runtime-fixture.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const number = (value: unknown): number => {assert.equal(typeof value, 'number'); assert.ok(Number.isSafeInteger(value)); return value as number;};
function object(value: unknown): Record<string, unknown> {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}
const sourceFiles = ['pnpm-lock.yaml', 'tests/helpers/agent-task-context-report.ts', 'tests/helpers/mio-storage-report.ts', 'tests/helpers/mio-storage-report-recovery.ts', 'tests/helpers/mio-runtime-fixture.ts', 'packages/business/src/agent/mio-records.ts', 'packages/business/src/agent/mio-journal.ts', 'packages/business/src/agent/mio-assembly.ts', 'packages/business/src/agent/mio-storage.ts', 'packages/business/src/agent/mio-run-usage.ts', 'packages/business/src/agent/mio-runtime.ts', 'packages/business/src/agent/task-runtime-v2.ts', 'packages/business/src/agent/task-gateway-v2.ts', 'packages/business/src/agent/task-context-v2.ts', 'packages/business/src/project-file/schema/domains/mio.ts', 'packages/contracts/src/mio-storage.ts'];
export function mioMeasurementSources() {return Object.fromEntries(sourceFiles.map(file => [file, sha256(readFileSync(resolve(file), 'utf8'))]));}
export interface MioStorageReportOptions {protocols?: readonly AgentProtocol[]; deltaIntervalMs?: number; tailPauseMs?: number; rounds?: number; officialPresets?: boolean; independentProject?: boolean}
interface Flush {atMs: number; deltaBytes: number; partialBytes: number; rewrittenColumnsBytes: number}
interface PhysicalSample {databaseBytes: number; journalBytes: number; pages: number; freePages: number; pageBytes: number; indexBytes: number | null}

/** SQL and stat are the only observations while the kernel owns the files.
 * In particular, never open/read a held SQLite file through fs. */
export function createPhysicalSampler(store: ProjectStore) {
  const files = store.db.prepare('PRAGMA database_list').all().filter(row => row.name !== 'temp').map(row => ({name: String(row.name), path: String(row.file)}));
  const fileBytes = (path: string): number => {try {return statSync(path).size;} catch (error) {if (object(error).code === 'ENOENT') return 0; throw error;}};
  let indexSupport: 'unknown' | 'available' | 'unavailable' = 'unknown';
  let samples = 0;
  const peak: PhysicalSample = {databaseBytes: 0, journalBytes: 0, pages: 0, freePages: 0, pageBytes: 0, indexBytes: null};
  function sample(): PhysicalSample {
    const value: PhysicalSample = {databaseBytes: 0, journalBytes: 0, pages: 0, freePages: 0, pageBytes: 0, indexBytes: indexSupport === 'unavailable' ? null : 0};
    for (const file of files) {
      assert.match(file.name, /^(main|project|cache)$/u);
      const pages = number(store.db.prepare(`PRAGMA ${file.name}.page_count`).get()!.page_count);
      const pageSize = number(store.db.prepare(`PRAGMA ${file.name}.page_size`).get()!.page_size);
      value.pages += pages; value.pageBytes += pages * pageSize;
      value.freePages += number(store.db.prepare(`PRAGMA ${file.name}.freelist_count`).get()!.freelist_count);
      value.databaseBytes += fileBytes(file.path);
      value.journalBytes += fileBytes(file.path + '-journal') + fileBytes(file.path + '-wal') + fileBytes(file.path + '-shm');
      if (indexSupport !== 'unavailable') try {
        const indexes = store.db.prepare(`SELECT COALESCE(sum(pgsize),0) AS bytes FROM dbstat(?) WHERE name IN (SELECT name FROM ${file.name}.sqlite_schema WHERE type='index')`).get(file.name);
        value.indexBytes! += number(indexes!.bytes); indexSupport = 'available';
      } catch (error) {
        if (!String(error).includes('no such table: dbstat')) throw error;
        indexSupport = 'unavailable'; value.indexBytes = null;
      }
    }
    samples++;
    for (const field of ['databaseBytes', 'journalBytes', 'pages', 'freePages', 'pageBytes'] as const) peak[field] = Math.max(peak[field], value[field]);
    if (value.indexBytes !== null) peak.indexBytes = Math.max(peak.indexBytes ?? 0, value.indexBytes);
    return value;
  }
  return {sample, report: () => ({samples, peak: {...peak}, indexSupport, files: files.map(file => ({schema: file.name, name: file.path.split('/').at(-1)!}))})};
}

function growth(before: MioStorageSnapshot, after: MioStorageSnapshot) {
  return {bytes: after.usage.bytes - before.usage.bytes, rows: after.usage.rows - before.usage.rows,
    tables: after.tables.map((table, index) => ({...table, bytes: table.bytes - before.tables[index]!.bytes, rows: table.rows - before.tables[index]!.rows}))};
}

async function projectReport(protocol: AgentProtocol, options: MioStorageReportOptions, projectOrdinal: number) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-mio-storage-report-'));
  const scenario = contextReportScenario({stress30Steps: true, officialPresets: options.officialPresets !== false, deltaIntervalMs: options.deltaIntervalMs ?? 0, tailPauseMs: options.tailPauseMs ?? 0});
  let fixture: Awaited<ReturnType<typeof createMioTestFixture>> | undefined;
  let sample = (): unknown => undefined;
  let removeObserver: (() => void) | undefined;
  const requests: Array<{index: number; round: number; bytes: number; sha256: string; tools: number}> = [];
  const flushes = new Map<string, Flush[]>(), beforeDone = new Map<number, {partialBytes: number; checkpoints: number}>();
  let round = 0, roundStart = 0, requestStarted = 0;
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.();
    assert.ok(fixture);
    const body = object(JSON.parse(request.body)), index = requests.length - roundStart + 1;
    if (process.env.MIO_REPORT_PROGRESS === '1') process.stderr.write(`${protocol} project${projectOrdinal} round${round} model${index}\n`);
    requestStarted = Date.now();
    requests.push({index, round, bytes: Buffer.byteLength(request.body), sha256: sha256(request.body), tools: Array.isArray(body.tools) ? body.tools.length : 0});
    sample();
    const text = 'x'.repeat(scenario.replyBytes);
    for (let offset = 0; offset < text.length; offset += scenario.deltaBytes) {
      advanceStreamingClock(scenario.deltaIntervalMs!);
      yield {type: 'delta', text: text.slice(offset, offset + scenario.deltaBytes)};
      sample();
    }
    advanceStreamingClock(scenario.tailPauseMs!);
    const saved = fixture.store.db.prepare("SELECT id,partialText FROM mio_steps WHERE kind='model' ORDER BY rowid DESC LIMIT 1").get()!;
    const partial = saved.partialText === null ? '' : JSON.parse(String(saved.partialText));
    beforeDone.set(requests.length, {partialBytes: Buffer.byteLength(partial), checkpoints: flushes.get(String(saved.id))?.length ?? 0});
    const count = index <= 14 ? index === 1 ? 2 : 1 : 0;
    const calls: AgentTaskToolCall[] = Array.from({length: count}, (_value, callIndex) => ({id: `synthetic_read_${String(index).padStart(3, '0')}_${callIndex + 1}`, name: 'mioon_project_inspect', arguments: {}}));
    yield {type: 'done', output: modelOutput(protocol, text, calls, index)};
    sample();
  };
  try {
    fixture = await createMioTestFixture(root, gateway, journal => {
      const append = journal.appendText;
      journal.appendText = (runId, stepId, text) => {
        append(runId, stepId, text);
        const row = fixture!.store.db.prepare('SELECT partialText,length(CAST(partialText AS BLOB))+length(CAST(data AS BLOB))+length(CAST(updatedAt AS BLOB))+length(CAST(status AS BLOB)) AS bytes FROM mio_steps WHERE id=?').get(stepId)!;
        const values = flushes.get(stepId) ?? [];
        values.push({atMs: Date.now() - requestStarted, deltaBytes: Buffer.byteLength(text), partialBytes: Buffer.byteLength(JSON.parse(String(row.partialText))), rewrittenColumnsBytes: number(row.bytes)});
        flushes.set(stepId, values); sample();
      };
      return journal;
    }, protocol);
    const f = fixture;
    if (options.officialPresets !== false) {
      const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic')!.platforms.find(platform => platform.id === 'global')!;
      const configuration = protocol === 'anthropic_messages' ? {presetId: 'anthropic', platformId: anthropic.id, baseUrl: anthropic.baseUrl, model: anthropic.model, protocol} : {...DEFAULT_AGENT_CONFIGURATION, protocol};
      await f.settings.put({expectedRevision: (await f.settings.get()).revision, configuration, secret: {action: 'replace', storage: 'session', value: randomUUID()}});
      await authorizeTestScope(f.authorizations, 'project_agent');
    }
    const execute = f.tools.execute;
    f.tools.execute = async (prepared, context) => {
      const outcome = await execute(prepared, context);
      assert.equal(prepared.operation, 'project.inspect');
      const result = {...object(outcome.result), syntheticContextPayload: ''};
      result.syntheticContextPayload = 'x'.repeat(20 * 1024 - Buffer.byteLength(JSON.stringify(result)));
      assert.equal(Buffer.byteLength(JSON.stringify(result)), 20 * 1024);
      return {...outcome, result};
    };
    const physical = createPhysicalSampler(f.store); sample = physical.sample;
    removeObserver = registerProjectTransactionObserver(f.store.db, () => sample());
    sample();
    const cold = readMioStorage(f.store.db), rounds = [], completedRunIds: string[] = [];
    let conversationId: string | undefined;
    for (round = 1; round <= (options.rounds ?? 2); round++) {
      roundStart = requests.length;
      const before = readMioStorage(f.store.db), physicalBefore = physical.sample();
      const sent = await f.runtime.send(f.store.projectId, {requestId: randomUUID(), ...(conversationId ? {conversationId} : {}), expectedSettingsRevision: (await f.settings.get()).revision, locale: 'en', text: 'Inspect the current project repeatedly, then report completion. Synthetic offline context measurement.'});
      conversationId = sent.run.conversationId;
      await f.runtime.drain(); sample();
      completedRunIds.push(sent.run.id);
      const snapshot = f.runtime.journal.snapshot(sent.run.id), steps = f.records.steps(sent.run.id);
      const vectors = requests.slice(roundStart), after = readMioStorage(f.store.db);
      const changesBeforeReplay = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
      const models = steps.filter(step => step.kind === 'model').map((step, index) => {
        assert.ok(step.currentRequestId);
        const request = f.records.request(step.currentRequestId), vector = vectors[index]!;
        const rebuilt = assembleRequest(request.assemblerVersion, f.assembly.collect(request.inputManifest));
        assert.equal(rebuilt.bodySha256, vector.sha256); assert.equal(rebuilt.bodyBytes, vector.bytes);
        assert.equal(request.originalBody, null, 'Completed requests must not retain the wire body');
        assert.equal(step.partialText, null, 'Completed models must not retain a checkpoint');
        assert.equal(Object.hasOwn(object(step.data), 'request'), false);
        const result = f.runtime.journal.step(step.id).result;
        assert.equal(object(result).text?.toString().length, scenario.replyBytes);
        const values = flushes.get(step.id) ?? [];
        const sharedBlobReferences = [...new Set([request.inputManifest.configurationBlobHash, request.inputManifest.toolsBlobHash, request.inputManifest.systemBlobHash, request.inputManifest.baselineBlobHash])].map(hash => ({sha256: hash, contentBytes: Buffer.byteLength(f.records.blob(hash)), logicalBlobRowBytes: Buffer.byteLength(f.records.blob(hash)) + 88}));
        return {index: index + 1, status: step.status, requestBytes: request.bodyBytes, requestSha256: request.bodySha256, manifestBytes: Buffer.byteLength(JSON.stringify(request.inputManifest)), outputEntryId: step.resultEntryId, sharedBlobReferences, flushes: values, beforeDone: beforeDone.get(roundStart + index + 1)!};
      });
      assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, changesBeforeReplay, 'Reassembly must be read only');
      const tools = steps.filter(step => step.kind === 'tool').map(step => {
        assert.ok(step.resultEntryId);
        const result = f.records.payload(f.records.entry(step.resultEntryId));
        return {status: step.status, resultBytes: Buffer.byteLength(JSON.stringify(result))};
      });
      // A failed workload must fail the measurement, never masquerade as savings.
      assert.equal(snapshot.run.status, 'completed', `${protocol}: ${snapshot.run.pauseReason}`);
      assert.equal(snapshot.run.stepsUsed, 30); assert.equal(models.length, 15); assert.equal(tools.length, 15);
      for (const tool of tools) {assert.equal(tool.status, 'completed'); assert.equal(tool.resultBytes, 20480);}
      const byBytes = Math.floor(after.remaining.bytes / Math.max(1, after.usage.bytes - before.usage.bytes));
      const byRows = Math.floor(after.remaining.rows / Math.max(1, after.usage.rows - before.usage.rows));
      rounds.push({round, sameConversationContinuation: round > 1, status: snapshot.run.status, stepsUsed: snapshot.run.stepsUsed, models, tools, requests: vectors,
        networkRequestBytes: vectors.reduce((total, vector) => total + vector.bytes, 0), retained: growth(before, after), after,
        streaming: {appendCalls: models.reduce((n, model) => n + model.flushes.length, 0), checkpointRewrittenColumnsBytes: models.reduce((n, model) => n + model.flushes.reduce((sum, flush) => sum + flush.rewrittenColumnsBytes, 0), 0)},
        physicalBefore, physicalAfter: physical.sample(), capacitySampleOnly: {byBytes, byRows, minimum: Math.min(byBytes, byRows)}});
    }
    const physicalReport = physical.report();
    removeObserver(); removeObserver = undefined;
    await f.close(); fixture = undefined;
    const reopened = openStore(root);
    let reconstructedAfterReopen = 0;
    try {
      const records = createMioRecords(reopened), assembly = createMioAssembly(records);
      const beforeReads = reopened.db.prepare('SELECT total_changes() AS n').get()!.n;
      for (const [roundIndex, runId] of completedRunIds.entries()) for (const [index, step] of records.steps(runId).filter(step => step.kind === 'model').entries()) {
        const request = records.request(step.currentRequestId!), rebuilt = assembleRequest(request.assemblerVersion, assembly.collect(request.inputManifest));
        const captured: {sha256: string; bytes: number} = rounds[roundIndex]!.requests[index]!;
        assert.equal(request.originalBody, null); assert.equal(rebuilt.bodySha256, captured.sha256); assert.equal(rebuilt.bodyBytes, captured.bytes); reconstructedAfterReopen++;
      }
      assert.equal(reopened.db.prepare('SELECT total_changes() AS n').get()!.n, beforeReads);
    } finally {reopened.close();}
    return {protocol, projectOrdinal, cold, rounds, physical: physicalReport, afterReopen: {reconstructedRequests: reconstructedAfterReopen, writes: 0}};
  } finally {
    removeObserver?.();
    if (fixture) await fixture.close();
    rmSync(root, {recursive: true, force: true});
  }
}

export async function collectMioStorageReport(options: MioStorageReportOptions = {}) {
  const sourcesBefore = mioMeasurementSources(), gitHead = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const gitDiffSha256 = sha256(execFileSync('git', ['-C', process.cwd(), 'diff', '--no-ext-diff'], {encoding: 'utf8'}));
  // Validate all fixed-workload and clock options before enabling MockTimers.
  contextReportScenario({stress30Steps: true, deltaIntervalMs: options.deltaIntervalMs ?? 0, tailPauseMs: options.tailPauseMs ?? 0});
  assert.ok(Number.isSafeInteger(options.rounds ?? 2) && (options.rounds ?? 2) >= 1 && (options.rounds ?? 2) <= 3);
  const selected = options.protocols ?? protocols;
  assert.ok(selected.length && selected.every(protocol => protocols.includes(protocol)));
  mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1)});
  try {
    const projects = [];
    for (const protocol of selected) {
      projects.push(await projectReport(protocol, options, 1));
      if (options.independentProject !== false) projects.push(await projectReport(protocol, {...options, rounds: 1}, 2));
    }
    const sourcesAfter = mioMeasurementSources(); assert.deepEqual(sourcesAfter, sourcesBefore, 'Measurement source files changed during the run');
    return {version: 2, runtime: 'K1/createMioRuntime', provenance: {gitHead, gitDiffSha256, nodeVersion: process.version, command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], sourcesBefore, sourcesAfter}, scenario: contextReportScenario({stress30Steps: true, officialPresets: options.officialPresets !== false, deltaIntervalMs: options.deltaIntervalMs ?? 0, tailPauseMs: options.tailPauseMs ?? 0}),
      measurement: {logical: 'Production readMioStorage: every one of 18 Mio tables; unique blobs counted once. No persistent request/history copies.', physical: 'SQL page counters and stat only while held; sampled before commit, after checkpoints, and at gateway boundaries. Peaks are observed, not an OS write-byte trace. dbstat indexes are null when unavailable; rollback journal excludes super-journals.', rewrite: 'Sum of actual partialText/data/updatedAt/status column bytes rewritten by real appendText. Excludes unchanged columns, other SQL updates, indexes, and physical write amplification.', network: 'UTF-8 body bytes and full SHA256 at the offline gateway boundary; never authorization headers, no network socket.', capacity: 'Individual samples are measurements, not arbitrary-workload guarantees. Derive N100 from maximum completed increment plus cold/shared and measured recovery allowance.'}, projects};
  } finally {mock.timers.reset();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {protocol: {type: 'string', default: 'all'}, 'delta-interval-ms': {type: 'string', default: '0'}, 'tail-pause-ms': {type: 'string', default: '0'}, rounds: {type: 'string', default: '2'}, 'single-project': {type: 'boolean', default: false}, output: {type: 'string'}}});
  const selected = values.protocol === 'all' ? protocols : protocols.filter(protocol => protocol === values.protocol);
  const report = await collectMioStorageReport({protocols: selected, deltaIntervalMs: Number(values['delta-interval-ms']), tailPauseMs: Number(values['tail-pause-ms']), rounds: Number(values.rounds), independentProject: !values['single-project']});
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) writeFileSync(resolve(values.output), json); else process.stdout.write(json);
}
