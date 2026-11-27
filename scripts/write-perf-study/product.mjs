import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync} from 'node:fs';
import {arch, cpus, loadavg, platform, release, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyProjectToNewFile} from '../../packages/business/src/project-file/copy.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore, openProjectStore} from '../../packages/business/src/project-file/store.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const diagnosticTest = 'tests/project-format5-performance.test.ts';
const rounds = parseRounds(process.argv.slice(2));
const workspace = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-write-product-'));
const at = '2026-01-01T00:00:00.000Z';

function parseRounds(args) {
  if (!args.length) return 5;
  assert.equal(args.length, 1, 'Specify only --rounds=N');
  const match = /^--rounds=([1-9][0-9]?)$/u.exec(args[0]);
  assert.ok(match && Number(match[1]) <= 30, '--rounds must be between 1 and 30');
  return Number(match[1]);
}

function distribution(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value)));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = value => sorted[Math.ceil(sorted.length * value) - 1];
  return {count: sorted.length, p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1)};
}

function measureCurrentPath() {
  const rows = [];
  const budgetMeasurements = [];
  for (let round = 1; round <= rounds; round++) {
    const loadBefore = loadavg();
    const evidence = path.join(workspace, `budget-${round}.jsonl`);
    const stdout = execFileSync(process.execPath, ['--test', '--test-reporter=tap', diagnosticTest], {
      cwd: repo, encoding: 'utf8', maxBuffer: 2 * 1024 ** 2,
      env: {...process.env, MIOON_PERF_EVIDENCE: evidence,
        ...(process.platform === 'darwin' ? {MIOON_PERF_RECORD_ONLY: '1'} : {})},
    });
    const samples = stdout.split('\n').filter(line => line.startsWith('# {"scope":')).map(line => JSON.parse(line.slice(2)));
    assert.deepEqual(samples.map(value => value.totalClips), [100, 500, 1_500]);
    for (const sample of samples) {
      assert.equal(sample.journal, 'delete');
      assert.equal(sample.synchronous, 2);
      rows.push({round, loadBefore, loadAfter: loadavg(), ...sample});
    }
    for (const line of readFileSync(evidence, 'utf8').trim().split('\n')) {
      budgetMeasurements.push({round, ...JSON.parse(line)});
    }
  }
  const summary = [100, 500, 1_500].map(scale => {
    const group = rows.filter(row => row.totalClips === scale);
    return {scale, reopenMs: distribution(group.map(row => row.coldOpenMs)),
      firstCommitMs: distribution(group.map(row => row.firstEdit.commitMs)),
      firstCodePathMs: distribution(group.map(row => row.firstEdit.codePathMs)),
      // The production benchmark emits distributions per process. Keep them
      // intact; combining medians would not reconstruct a pooled percentile.
      warmByRound: group.map(({round, results}) => ({round, modes: results.map(({mode, samples, commitMs, codePathMs}) =>
        ({mode, samples, commitMs, codePathMs}))}))};
  });
  return {summary, rows, budgetMeasurements};
}

function makeProject(name) {
  const directory = path.join(workspace, name);
  mkdirSync(directory, {mode: 0o700});
  const projectId = randomUUID();
  const projectFile = path.join(directory, 'project.mioon');
  const privateRoot = path.join(workspace, name + '-private');
  const locate = () => ({localDir: path.join(privateRoot, 'records'), cacheDir: path.join(privateRoot, 'cache'),
    tempDir: path.join(privateRoot, 'temp')});
  const store = createProjectStore({projectId, projectFile, locate, targetFormat: FORMAT5_PROJECT_SCHEMA_VERSION});
  const write = (revision, label) => store.tx(() => {
    store.put('projects', {id: projectId, name: label, createdAt: at, updatedAt: at, revision});
  });
  write(1, 'Before');
  write(2, 'Committed');
  return {directory, projectId, projectFile, locate, store, write};
}

function nameInCopy(file, projectId) {
  const records = mkdtempSync(path.join(workspace, 'copy-records-'));
  const opened = openProjectStore({projectFile: file, locate: () => ({localDir: path.join(records, 'local'),
    cacheDir: path.join(records, 'cache'), tempDir: path.join(records, 'temp')})});
  try {return opened.get('projects', projectId)?.name;} finally {opened.close();}
}

async function verifyCopyAndMove() {
  const live = makeProject('live');
  let folderMove;
  try {
    const raw = path.join(workspace, 'live-copy.mioon');
    const journalBytes = lstatSync(live.projectFile + '-journal', {throwIfNoEntry: false})?.size ?? 0;
    assert.equal(journalBytes, 0);
    // POSIX locks are process-scoped. Raw copy deliberately uses another
    // process and samples a committed pause, with the original still held.
    execFileSync(process.execPath, ['-e', "require('node:fs').copyFileSync(process.argv[1], process.argv[2])", live.projectFile, raw]);
    assert.equal(nameInCopy(raw, live.projectId), 'Committed');
    const owned = path.join(workspace, 'app-copy.mioon');
    const copied = await copyProjectToNewFile(live.store, {projectFile: owned, sourceProjectDir: live.directory});
    assert.notEqual(copied.projectId, live.projectId);
    assert.equal(nameInCopy(owned, copied.projectId), 'Committed');
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(lstatSync(owned + suffix, {throwIfNoEntry: false}), undefined);

    let fileOnlyMove = null, entireFolderMove = null;
    if (process.platform !== 'win32') {
      const movedFile = path.join(live.directory, 'renamed.mioon');
      renameSync(live.projectFile, movedFile);
      assert.throws(() => live.write(3, 'Invalid late write'), {code: 'PROJECT_FILE_MOVED'});
      live.store.close();
      assert.equal(nameInCopy(movedFile, live.projectId), 'Committed');
      fileOnlyMove = {lateWrite: 'PROJECT_FILE_MOVED', reopenedCommittedContent: true};

      folderMove = makeProject('folder-move');
      const movedDirectory = path.join(workspace, 'same-folder-new-name');
      renameSync(folderMove.directory, movedDirectory);
      folderMove.write(3, 'After folder move');
      folderMove.store.close();
      const reopened = openProjectStore({projectFile: path.join(movedDirectory, 'project.mioon'), locate: folderMove.locate});
      try {assert.equal(reopened.get('projects', folderMove.projectId)?.name, 'After folder move');}
      finally {reopened.close();}
      entireFolderMove = {lateWrite: 'committed', reopenedCommittedContent: true};
    }
    return {quiescentExternalCopy: {reopenedCommittedContent: true, journalBytes},
      liveAppCopy: {reopenedCommittedContent: true, freshIdentity: true, singleFile: true},
      fileOnlyMove, entireFolderMove};
  } finally {
    if (live.store.db.isOpen) live.store.close();
    if (folderMove?.store.db.isOpen) folderMove.store.close();
  }
}

try {
  console.log(JSON.stringify({system: {platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model,
    node: process.version, loadBefore: loadavg()}, portability: await verifyCopyAndMove(), ...measureCurrentPath()}, null, 2));
} finally {rmSync(workspace, {force: true, recursive: true});}
