import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {testEnv} from '../../helpers/test-env.ts';

const configurations = [
  {name: 'delete-full', sync: 'FULL'},
  {name: 'delete-normal', sync: 'NORMAL'},
  {name: 'delete-extra', sync: 'EXTRA'},
  {name: 'delete-full-project-only', sync: 'FULL', projectOnly: true},
  {name: 'delete-full-four-commits', sync: 'FULL', split: true},
  {name: 'delete-full-batched', sync: 'FULL'},
  {name: 'delete-full-fullfsync', sync: 'FULL', fullfsync: true},
  {name: 'wal-full', sync: 'FULL', history: 'WAL', project: 'WAL'},
  {name: 'wal-normal', sync: 'NORMAL', history: 'WAL', project: 'WAL'},
  {name: 'wal-full-checkpoint', sync: 'FULL', history: 'WAL', project: 'WAL', checkpoint: true},
  {name: 'history-wal-project-delete', sync: 'FULL', history: 'WAL'},
].filter(config => !config.fullfsync || os.platform() === 'darwin')
  .map(config => ({history: 'DELETE', project: 'DELETE', ...config}));

const names = {history: 'history.db', project: 'study.mioon', cache: 'cache.db'};
const one = (db, sql) => Object.values(db.prepare(sql).get())[0];
const attach = (db, directory) => {
  db.prepare('ATTACH DATABASE ? AS project').run(path.join(directory, names.project));
  db.prepare('ATTACH DATABASE ? AS cache').run(path.join(directory, names.cache));
};
const metadata = {platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.availableParallelism(),
  loadStart: os.loadavg().map(value => Number(value.toFixed(2))), node: process.version};
const original = new DatabaseSync(':memory:');
metadata.sqlite = one(original, 'SELECT sqlite_version()');
original.close();
const canonicalTemp = realpathSync(os.tmpdir());
const historyBytes = 229 * 1024;
const changedClips = 48;
const maxProbeLogBytes = 16 * 1024;

function seed(directory) {
  mkdirSync(directory);
  const db = new DatabaseSync(path.join(directory, names.history));
  try {
    attach(db, directory);
    for (const schema of ['main', 'project', 'cache']) {
      db.exec(`PRAGMA ${schema}.page_size=4096; PRAGMA ${schema}.journal_mode=DELETE; PRAGMA ${schema}.synchronous=FULL`);
      assert.equal(one(db, `PRAGMA ${schema}.page_size`), 4096);
    }
    db.exec(`
      CREATE TABLE main.history_state(id INTEGER PRIMARY KEY, seen INTEGER NOT NULL);
      INSERT INTO main.history_state VALUES(1,0);
      CREATE TABLE main.history_entries(generation INTEGER, step INTEGER, payload BLOB, PRIMARY KEY(generation, step)) STRICT;
      INSERT INTO main.history_entries VALUES(0,0,zeroblob(${historyBytes}));
      PRAGMA project.user_version=5;
      CREATE TABLE project.project_file(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
      INSERT INTO project.project_file VALUES(1,0);
      CREATE TABLE project.clips(id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, payload BLOB) STRICT;
      WITH RECURSIVE indices(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM indices WHERE n<1500)
        INSERT INTO project.clips SELECT n,0,zeroblob(623) FROM indices;
      CREATE TABLE cache.unmodified(id INTEGER PRIMARY KEY);
      INSERT INTO cache.unmodified VALUES(1);
    `);
  } finally { db.close(); }
}

function seededCopy(seedDir, directory) {
  mkdirSync(directory);
  for (const file of Object.values(names)) copyFileSync(path.join(seedDir, file), path.join(directory, file));
}

function openAttached(directory, config) {
  const db = new DatabaseSync(path.join(directory, names.history));
  try {
    attach(db, directory);
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    for (const [schema, mode] of [['main', config.history], ['project', config.project], ['cache', 'DELETE']]) {
      assert.equal(one(db, `PRAGMA ${schema}.journal_mode=${mode}`), mode.toLowerCase());
      db.exec(`PRAGMA ${schema}.synchronous=${config.sync}; PRAGMA ${schema}.journal_size_limit=0`);
      assert.equal(one(db, `PRAGMA ${schema}.synchronous`), {NORMAL: 1, FULL: 2, EXTRA: 3}[config.sync]);
      assert.equal(one(db, `PRAGMA ${schema}.journal_size_limit`), 0);
    }
    db.exec('PRAGMA wal_autocheckpoint=1000; BEGIN EXCLUSIVE; COMMIT');
    assert.equal(one(db, 'PRAGMA locking_mode'), 'exclusive');
    assert.equal(one(db, 'PRAGMA project.locking_mode'), 'exclusive');
    if (config.fullfsync) {
      db.exec('PRAGMA fullfsync=ON');
      assert.equal(one(db, 'PRAGMA fullfsync'), 1);
    }
    if (config.project === 'DELETE') {
      db.exec('BEGIN; PRAGMA project.user_version=5; ROLLBACK');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function modifications(generation, step, projectOnly = false) {
  const first = (step - 1) * (changedClips / 4) + 1;
  const last = first + changedClips / 4 - 1;
  return `
    UPDATE project.clips SET generation=${generation} WHERE id BETWEEN ${first} AND ${last};
    UPDATE project.project_file SET generation=${generation} WHERE id=1;
    ${projectOnly ? '' : `
      INSERT INTO main.history_entries VALUES(${generation},${step},zeroblob(${historyBytes / 4}));
      UPDATE main.history_state SET seen=${generation} WHERE id=1;
    `}
  `;
}

function measureAction(db, generation, config) {
  const steps = Array.from({length: 4}, (_, index) => modifications(generation, index + 1, config.projectOnly));
  const bodies = config.split ? steps : [steps.join('\n')];
  const started = performance.now();
  let commitMs = 0;
  for (const body of bodies) {
    db.exec('BEGIN');
    db.exec(body);
    const beginCommit = performance.now();
    db.exec('COMMIT');
    commitMs += performance.now() - beginCommit;
  }
  const beginCheckpoint = performance.now();
  if (config.checkpoint) {
    for (const schema of ['main', 'project']) {
      const check = db.prepare(`PRAGMA ${schema}.wal_checkpoint(TRUNCATE)`).get();
      assert.equal(check.busy, 0);
      assert.equal(check.log, 0);
    }
  }
  const end = performance.now();
  return {commitMs, actionMs: end - started, checkpointMs: config.checkpoint ? end - beginCheckpoint : 0};
}

function distribution(samples) {
  return Object.fromEntries(Object.keys(samples[0]).map(key => {
    const ordered = samples.map(sample => sample[key]).sort((a, b) => a - b);
    const at = percentile => Number(ordered[Math.ceil(ordered.length * percentile) - 1].toFixed(4));
    return [key, {p50: at(.5), p95: at(.95), max: at(1)}];
  }));
}

function benchmark(temp, seedDir, variants, firstCount, steadyCount) {
  const samples = new Map(variants.map(config => [config.name, {first: [], steady: []}]));
  // Rotate option order across cold samples so a load spike doesn't select one policy.
  for (let index = 0; index < firstCount; index++) {
    for (const config of variants.map((_, offset) => variants[(index + offset) % variants.length])) {
      const directory = path.join(temp, 'first');
      seededCopy(seedDir, directory);
      const db = openAttached(directory, config);
      try { samples.get(config.name).first.push(measureAction(db, 1, config)); }
      finally { db.close(); rmSync(directory, {recursive: true}); }
    }
  }
  const sessions = variants.map(config => {
    const directory = path.join(temp, config.name);
    seededCopy(seedDir, directory);
    return {config, db: openAttached(directory, config)};
  });
  try {
    const warmups = 5;
    for (let index = 0; index < steadyCount + warmups; index++) {
      for (const {config, db} of sessions.map((_, offset) => sessions[(index + offset) % sessions.length])) {
        const sample = measureAction(db, index + 1, config);
        if (index >= warmups) samples.get(config.name).steady.push(sample);
      }
    }
    for (const {config, db} of sessions) {
      assert.equal(one(db, 'SELECT generation FROM project.project_file'), steadyCount + warmups);
      assert.equal(one(db, 'SELECT seen FROM main.history_state'), config.projectOnly ? 0 : steadyCount + warmups);
      assert.equal(one(db, 'SELECT count(*) FROM main.history_entries'), config.projectOnly ? 1 : 1 + (steadyCount + warmups) * 4);
    }
  } finally { for (const {db} of sessions) db.close(); }
  return variants.map(config => {
    const {first, steady} = samples.get(config.name);
    return {config, commitsPerAction: config.split ? 4 : 1, first: distribution(first), steady: distribution(steady)};
  });
}

function inspect(file, kind) {
  let db;
  try {
    db = new DatabaseSync(file);
    const healthy = one(db, 'PRAGMA integrity_check') === 'ok';
    if (kind === 'project') {
      const state = db.prepare(`SELECT min(CASE WHEN id<=${changedClips} THEN generation END) AS minGeneration,
                      max(CASE WHEN id<=${changedClips} THEN generation END) AS maxGeneration,
                      max(CASE WHEN id>${changedClips} THEN generation END) AS untouched,
                      count(*) AS countRows FROM clips`).get();
      const generation = one(db, 'SELECT generation FROM project_file');
      const complete = state.minGeneration === generation && state.maxGeneration === generation && state.untouched === 0 && state.countRows === 1500;
      return {healthy, generation, ...state, complete};
    }
    const generation = one(db, 'SELECT seen FROM history_state');
    const countRows = one(db, 'SELECT count(*) FROM history_entries WHERE generation>0');
    const bytes = one(db, 'SELECT coalesce(sum(length(payload)),0) FROM history_entries WHERE generation>0');
    return {healthy, generation, countRows, bytes, complete: countRows === generation * 4 && bytes === generation * historyBytes};
  } catch (error) {
    return {healthy: false, complete: false, code: error.code ?? error.name};
  } finally { db?.close(); }
}

function takeSnapshots(directory, label = 'open') {
  const raw = path.join(directory, `copy-${label}.mioon`);
  const source = path.join(directory, names.project);
  copyFileSync(source, raw);
  const header = readFileSync(raw);
  const headerMode = header[18] === 2 && header[19] === 2 ? 'wal'
    : header[18] === 1 && header[19] === 1 ? 'delete' : 'invalid';
  const sidecar = key => {
    try { return statSync(path.join(directory, names[key] + (key === 'cache' ? '-journal' : '-wal'))).size; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  return {copy: {...inspect(raw, 'project'), headerMode}, historyWalBytes: sidecar('history'), projectWalBytes: sidecar('project')};
}

function readProbeLog(file, completeLinesOnly = false) {
  const descriptor = openSync(file, 'r');
  const bytes = Buffer.alloc(maxProbeLogBytes + 1);
  try {
    let total = 0;
    while (total < bytes.length) {
      const length = readSync(descriptor, bytes, total, bytes.length - total, null);
      if (!length) break;
      total += length;
    }
    if (total > maxProbeLogBytes) throw Error('VFS probe log exceeded its byte limit');
    const snapshot = bytes.subarray(0, total);
    const end = completeLinesOnly ? snapshot.lastIndexOf(0x0a) + 1 : total;
    return new TextDecoder('utf-8', {fatal: true}).decode(snapshot.subarray(0, end));
  } finally { closeSync(descriptor); }
}

function startProbe(probe, args, stdout, stderr) {
  const out = openSync(stdout, 'wx', 0o600);
  try {
    const err = openSync(stderr, 'wx', 0o600);
    try { return spawn(probe, args, {env: testEnv(), stdio: ['ignore', out, err]}); }
    finally { closeSync(err); }
  } finally { closeSync(out); }
}

function crashWorker(probe, directory, config, phase, changes, graceful = false) {
  return new Promise((resolve, reject) => {
    const stdout = path.join(directory, 'probe.stdout.log');
    const stderr = path.join(directory, 'probe.stderr.log');
    const child = startProbe(probe, [
      path.join(directory, names.history), path.join(directory, names.project), path.join(directory, names.cache),
      config.history, config.project, config.sync, phase, changes, config.fullfsync ? '1' : '0',
    ], stdout, stderr);
    let captured, failure;
    const timer = setTimeout(() => { failure = new Error(`VFS probe timed out at ${phase}`); child.kill('SIGKILL'); }, 20_000);
    const poll = setInterval(() => {
      if (failure) return;
      try {
        if (!captured) {
          if (!readProbeLog(stdout, true).split('\n').includes(`PAUSED ${phase}`)) return;
          captured = takeSnapshots(directory);
        }
        if (graceful) {
          const state = spawnSync('ps', ['-o', 'stat=', '-p', String(child.pid)],
            {env: testEnv(), encoding: 'utf8', maxBuffer: maxProbeLogBytes, timeout: 1_000}).stdout?.trim();
          if (!state?.startsWith('T')) return;
        }
        clearInterval(poll);
        child.kill(graceful ? 'SIGCONT' : 'SIGKILL');
      } catch (error) {
        failure = error;
        clearInterval(poll);
        child.kill('SIGKILL');
      }
    }, 5);
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(poll);
      try {
        const output = readProbeLog(stdout), diagnostics = readProbeLog(stderr);
        if (failure || !captured || (graceful ? code !== 0 : signal !== 'SIGKILL')) {
          throw failure ?? Error(`VFS did not reach ${config.name}/${phase} (${code}/${signal})\n${diagnostics}`);
        }
        // Recover the original project first, matching the kernel's explicit order.
        const project = inspect(path.join(directory, names.project), 'project');
        const history = inspect(path.join(directory, names.history), 'history');
        const syncs = /^SYNC (\d+) (\d+) (\d+)$/m.exec(output);
        assert.ok(syncs);
        const [, rollbackJournal, other, superjournalUnlinks] = syncs.map(Number);
        resolve({...captured, project, history, syncs: {rollbackJournal, other, superjournalUnlinks},
          pairComplete: project.healthy && history.healthy && project.complete &&
            history.complete && (config.projectOnly || project.generation === history.generation),
          ...(graceful ? {closedCopy: takeSnapshots(directory, 'closed').copy} : {})});
      } catch (error) { reject(error); }
    });
  });
}

async function crash(temp, seedDir, variants, repeats) {
  const probe = path.join(temp, 'durability-probe');
  const source = fileURLToPath(new URL('./durability-vfs.c', import.meta.url));
  const processOptions = {env: testEnv(), encoding: 'utf8', maxBuffer: maxProbeLogBytes, timeout: 60_000};
  const cc = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-lsqlite3', '-o', probe], processOptions);
  if (cc.status !== 0) throw Error(`Build the SQLite VFS probe with a C compiler and sqlite3 headers:\n${cc.stderr ?? cc.error}`);
  const version = spawnSync(probe, ['--version'], processOptions);
  assert.equal(version.status, 0);
  const changes = path.join(temp, 'changes.sql');
  const outcomes = [];
  const duplicateOf = {'delete-full-batched': 'delete-full', 'wal-full-checkpoint': 'wal-full'};
  for (const config of variants.filter(option => !variants.some(other => other.name === duplicateOf[option.name]))) {
    const rollback = config.history === 'DELETE' && config.project === 'DELETE';
    const dualWal = config.history === 'WAL' && config.project === 'WAL';
    const phases = ['idle_before', 'before_commit'];
    if (config.split) phases.push('after_first_commit');
    else if (rollback) {
      phases.push('rollback_journal_synced', 'project_page_written');
      if (!config.projectOnly) phases.push('superjournal_deleted');
    }
    if (dualWal) phases.push('history_wal_commit_frame', 'project_wal_commit_frame');
    if (!rollback && !dualWal) phases.push('history_wal_commit_frame', 'project_page_written');
    phases.push('after_commit');
    if (dualWal) phases.push('checkpoint_project_page', 'after_checkpoint', 'graceful_close');
    writeFileSync(changes, Array.from({length: 4}, (_, index) => {
      const body = modifications(1, index + 1, config.projectOnly);
      if (!config.split || index === 3) return body;
      const observe = index === 0 ? "SELECT study_stage('before_commit');" : '';
      const committed = index === 0 ? "SELECT study_stage('after_first_commit');" : '';
      return `${body}\n${observe} COMMIT; ${committed} BEGIN;\n`;
    }).join('\n'));
    for (const phase of phases) {
      const cases = [];
      for (let index = 0; index < repeats; index++) {
        const directory = path.join(temp, 'crash-sample');
        seededCopy(seedDir, directory);
        const outcome = await crashWorker(probe, directory, config, phase, changes, phase === 'graceful_close');
        cases.push(outcome);
        rmSync(directory, {recursive: true});
      }
      outcomes.push({variant: config.name, phase, cases});
    }
  }
  return {probeSqlite: version.stdout.trim(), repeats, outcomes};
}

const arguments_ = process.argv.slice(2);
const choose = arguments_.filter(argument => ['--benchmark', '--crash'].includes(argument));
if (choose.length !== 1 || arguments_.some(arg => !['--benchmark', '--crash'].includes(arg) && !/^--(?:first-count|steady-count|repeats|variants)=/.test(arg))) {
  throw Error('Usage: node durability.mjs --benchmark|--crash [--first-count=32] [--steady-count=64] [--repeats=2] [--variants=a,b]');
}
const option = (name, fallback) => arguments_.find(argument => argument.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const count = (name, fallback) => {
  const value = Number(option(name, fallback));
  assert.ok(Number.isInteger(value) && value >= 1 && value <= 256, `Invalid ${name}`);
  return value;
};
const requested = option('variants', '').split(',').filter(Boolean);
const variants = requested.length ? configurations.filter(config => requested.includes(config.name)) : configurations;
assert.ok(variants.length && (!requested.length || variants.length === requested.length), 'Unknown or unavailable variant');
const temp = mkdtempSync(path.join(canonicalTemp, 'mioon-write-durability-'));
try {
  const seedDir = path.join(temp, 'seed');
  seed(seedDir);
  const firstCount = count('first-count', 32), steadyCount = count('steady-count', 64);
  const payload = choose[0] === '--benchmark' ? {firstCount, steadyCount, variants: benchmark(temp, seedDir, variants, firstCount, steadyCount)}
    : await crash(temp, seedDir, variants, count('repeats', 2));
  console.log(JSON.stringify({...metadata, loadEnd: os.loadavg().map(value => Number(value.toFixed(2))),
    historyBytes, changedClips, ...payload}, null, 2));
} finally { rmSync(temp, {recursive: true}); }
