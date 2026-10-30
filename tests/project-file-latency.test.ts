// Write latency of Mio streaming: one store transaction every 250 ms in the
// test layout, first writing only the local records (an agent_task_events_v2
// row in history.db, "single-file"), then the same event plus an UPDATE of a
// shot in the project file ("cross-file"). MIOON_K1_LATENCY_TICKS ticks per
// group (default 8). Only the effects on the two files are asserted; the
// timings go to t.diagnostic as JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/index.ts';
import type {ProjectStore} from '../packages/business/src/project-file/index.ts';

const TICKS = Number(process.env.MIOON_K1_LATENCY_TICKS ?? 8);
const TICK_MS = 250;

/** sha256 of a file, read by another process: reading a file this process
 * holds open would drop SQLite's POSIX locks on it. */
function digestElsewhere(file: string): string {
  const script = "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))";
  const result = spawnSync(process.execPath, ['-e', script, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const contentSequence = (db: DatabaseSync): number => Number(db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);
const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];

function summary(mode: string, samples: readonly number[]): Record<string, unknown> {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  const ms = (value: number): number => Math.round(value * 100) / 100;
  return {
    mode, ticks: samples.length, p50: ms(percentile(0.5)), p90: ms(percentile(0.9)), p99: ms(percentile(0.99)),
    max: ms(sorted[sorted.length - 1]!), mean: ms(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

/** Runs `write` in store.tx once per 250 ms tick and returns each transaction's duration in milliseconds. */
async function ticks(store: ProjectStore, write: (tick: number) => void, afterTick: (tick: number) => void = () => {}): Promise<number[]> {
  const durations: number[] = [];
  const start = performance.now();
  for (let tick = 1; tick <= TICKS; tick++) {
    const wait = start + (tick - 1) * TICK_MS - performance.now();
    if (wait > 0) await sleep(wait);
    const began = performance.now();
    store.tx(() => write(tick));
    durations.push(performance.now() - began);
    afterTick(tick);
  }
  return durations;
}

test(`a store transaction every ${TICK_MS} ms, local records only and then both files`, {timeout: 600_000}, async t => {
  assert.ok(Number.isInteger(TICKS) && TICKS > 0, 'MIOON_K1_LATENCY_TICKS must be a positive integer');
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-k1-latency-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const shotId = randomUUID(), runId = randomUUID();
  const created = openStore(root);
  try {
    created.tx(() => {
      const now = new Date().toISOString();
      created.put('projects', {id: created.projectId, name: 'K1 latency', description: '', revision: 1, createdAt: now, updatedAt: now});
      created.put('shots', {id: shotId, projectId: created.projectId, title: 'Shot', revision: 0});
      created.db.prepare('INSERT INTO agent_task_runs_v2(id,projectId,requestId,digest,status,revision,data) VALUES(?,?,?,?,?,?,?)').run(
        runId, created.projectId, randomUUID(), createHash('sha256').update(runId).digest('hex'), 'running', 0,
        JSON.stringify({conversationId: randomUUID(), notes: [], skippedTargets: []}));
    });
  } finally {
    created.close();
  }

  const opening = performance.now();
  const store = openStore(root);
  const openMs = performance.now() - opening;
  t.after(() => store.close());
  const {db, projectId} = store;
  t.diagnostic(JSON.stringify({
    openMs: Math.round(openMs * 100) / 100, node: process.version, sqlite: db.prepare('SELECT sqlite_version() AS v').get()?.v,
    journalMode: ['main', 'project', 'cache'].map(schema => pragma(db, `${schema}.journal_mode`)),
    synchronous: ['main', 'project', 'cache'].map(schema => pragma(db, `${schema}.synchronous`)),
    lockingMode: pragma(db, 'main.locking_mode'), fullfsync: pragma(db, 'fullfsync'),
  }));

  let sequence = 0;
  const insertEvent = db.prepare("INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,'text',?)");
  // A streamed text delta: about 900 bytes on odd ticks and 8 KiB on even ones.
  const addEvent = (tick: number): void => {
    sequence += 1;
    insertEvent.run(runId, projectId, sequence, JSON.stringify({text: (tick % 2 ? 'a' : 'b').repeat(tick % 2 ? 890 : 8180)}));
  };

  const fileBefore = digestElsewhere(store.projectFile), sequenceBefore = contentSequence(db);
  const single = await ticks(store, addEvent);
  assert.equal(contentSequence(db), sequenceBefore, 'a commit of local records only leaves the content sequence');
  assert.equal(digestElsewhere(store.projectFile), fileBefore, 'and the project file');

  const updateShot = db.prepare('UPDATE shots SET data=? WHERE id=?');
  let last = contentSequence(db);
  const cross = await ticks(store, tick => {
    addEvent(tick);
    updateShot.run(JSON.stringify({id: shotId, projectId, title: 'Shot', revision: tick}), shotId);
  }, tick => {
    const now = contentSequence(db);
    assert.ok(now >= last + 1, `tick ${tick}: the content sequence went from ${last} to ${now}`);
    last = now;
  });
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM agent_task_events_v2 WHERE runId=?').get(runId)?.n), 2 * TICKS);
  store.close();

  t.diagnostic(JSON.stringify(summary('single-file', single)));
  t.diagnostic(JSON.stringify(summary('cross-file', cross)));
});
