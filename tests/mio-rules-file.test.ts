import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readRulesFile, publishRulesFile, inspectRulesArtifact, finishRulesFileCleanup, type RulesPublicationInput, type RulesPublicationEvidence,
  type RulesPublicationPhase} from '../packages/business/src/agent/mio-rules-file.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mio-rules-file-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const projectDir = path.join(root, 'project'); mkdirSync(projectDir);
  const target = path.join(projectDir, 'AGENTS.md'), token = randomUUID();
  const candidateName = `.mioon-rules-${token}.candidate`, backupName = `.mioon-rules-${token}.backup`;
  const checkpoints: RulesPublicationEvidence[] = [];
  const input = (patch: Partial<RulesPublicationInput> = {}): RulesPublicationInput => ({
    expectedExists: false, expectedHash: null, text: 'New rules\r\n', candidateName, backupName,
    checkpoint: evidence => {checkpoints.push(structuredClone(evidence));}, ...patch});
  return {root, projectDir, target, candidateName, backupName, checkpoints, input,
    artifact: (name: string) => path.join(projectDir, name)};
}
function names(dir: string): string[] {return readdirSync(dir).sort();}

/** Deterministic ext4-style metadata coalescing; the file bytes really change. */
function freezeFileMetadata(file: string, afterRead?: (position: number, count: number) => void): () => void {
  const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync, originalRead = fs.readSync;
  const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync')!;
  const before = originalLstat(file, {bigint: true});
  const isFile = (value: unknown): boolean => value !== null && typeof value === 'object'
    && 'dev' in value && 'ino' in value && String(value.dev) === String(before.dev) && String(value.ino) === String(before.ino);
  Object.defineProperty(fs, 'lstatSync', {value: ((...args: unknown[]) => {
    const value: unknown = Reflect.apply(originalLstat, fs, args);
    return isFile(value) ? before : value;
  }) as typeof fs.lstatSync});
  fs.fstatSync = ((...args: unknown[]) => {
    const value: unknown = Reflect.apply(originalFstat, fs, args);
    return isFile(value) ? before : value;
  }) as typeof fs.fstatSync;
  fs.readSync = ((...args: unknown[]) => {
    const count: number = Reflect.apply(originalRead, fs, args);
    if (isFile(originalFstat(Number(args[0]), {bigint: true}))) afterRead?.(Number(args[4]), count);
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  return () => {Object.defineProperty(fs, 'lstatSync', lstatDescriptor); fs.fstatSync = originalFstat; fs.readSync = originalRead; syncBuiltinESMExports();};
}

test('read is fixed to the project AGENTS.md and missing does not discover parent rules', t => {
  const f = fixture(t); writeFileSync(path.join(f.root, 'AGENTS.md'), 'Parent private rules');
  assert.equal(readRulesFile(f.projectDir).status, 'missing');
  assert.deepEqual(names(f.projectDir), []);
  assert.deepEqual(readRulesFile(`${f.projectDir}${path.sep}..`), {status: 'error', code: 'invalid_directory'});
  assert.deepEqual(readRulesFile('relative'), {status: 'error', code: 'invalid_directory'});
});

for (const text of ['', 'Keep CRLF\r\n原字节\t\r\n', '\ufeffKeep BOM\n', 'a'.repeat(8192), '界'.repeat(2730) + 'ab']) {
  test(`read preserves exact UTF-8 bytes at ${Buffer.byteLength(text)} bytes`, t => {
    const f = fixture(t); writeFileSync(f.target, text);
    const result = readRulesFile(f.projectDir);
    assert.equal(result.status, 'safe');
    if (result.status !== 'safe') return;
    assert.equal(result.text, text); assert.equal(result.hash, hash(Buffer.from(text)));
    assert.equal(result.identity.size, String(Buffer.byteLength(text)));
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
  });
}

for (const bytes of [Buffer.alloc(8193, 97), Buffer.from([0xc3, 0x28]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xff])]) {
  test(`read rejects overlong or invalid bytes ${bytes.length}/${bytes[0]}`, t => {
    const f = fixture(t); writeFileSync(f.target, bytes);
    assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: bytes.length > 8192 ? 'too_large' : 'invalid_utf8'});
    assert.deepEqual(readFileSync(f.target), bytes);
  });
}

test('read rejects file and directory symlinks, directories, and FIFO without blocking', t => {
  const f = fixture(t), external = path.join(f.root, 'external'); writeFileSync(external, 'Private');
  symlinkSync(external, f.target);
  assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: 'unsafe_file'});
  unlinkSync(f.target); mkdirSync(f.target);
  assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: 'unsafe_file'});
  rmSync(f.target, {recursive: true});
  const alias = path.join(f.root, 'alias'); symlinkSync(f.projectDir, alias, 'dir');
  assert.deepEqual(readRulesFile(alias), {status: 'error', code: 'invalid_directory'});
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [f.target]).status, 0);
    assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: 'unsafe_file'});
  }
});

for (const phase of ['file_checked', 'file_opened', 'file_read'] as const) {
  test(`read rejects a replaced path at ${phase} even when bytes match`, t => {
    const f = fixture(t); writeFileSync(f.target, 'original'); let changed = false;
    const result = readRulesFile(f.projectDir, {onPhase: current => {
      if (!changed && current === phase) {changed = true; renameSync(f.target, `${f.target}.old`); writeFileSync(f.target, 'original');}
    }});
    assert.deepEqual(result, {status: 'error', code: 'changed'});
  });
}

test('read rejects same-inode rewrites and a replaced project directory', t => {
  const f = fixture(t); writeFileSync(f.target, 'same size');
  assert.deepEqual(readRulesFile(f.projectDir, {onPhase: phase => {
    if (phase === 'file_read') writeFileSync(f.target, 'new bytes');
  }}), {status: 'error', code: 'changed'});
  const result = readRulesFile(f.projectDir, {onPhase: phase => {
    if (phase === 'directory_checked') {renameSync(f.projectDir, `${f.projectDir}.old`); mkdirSync(f.projectDir); writeFileSync(f.target, 'replacement');}
  }});
  assert.deepEqual(result, {status: 'error', code: 'changed'});
});

for (const artifact of [false, true]) {
  test(`bounded verification rejects equal-size rewrites with identical inode, mtime and ctime (artifact=${artifact})`, t => {
    const f = fixture(t), file = artifact ? f.artifact(f.candidateName) : f.target;
    writeFileSync(file, 'same size');
    const before = statSync(file, {bigint: true}), positions: number[] = [];
    const restore = freezeFileMetadata(file, (position, count) => {if (count > 0) positions.push(position);});
    try {
      const options = {onPhase: (phase: string) => {if (phase === 'file_read') writeFileSync(file, 'new bytes');}};
      const result = artifact ? inspectRulesArtifact(f.projectDir, f.candidateName, options) : readRulesFile(f.projectDir, options);
      assert.deepEqual(result, {status: 'error', code: 'changed'});
      assert.equal(statSync(file, {bigint: true}).ino, before.ino);
      assert.deepEqual(fs.lstatSync(file, {bigint: true}), before);
      assert.deepEqual(positions, [0, 0], 'both bounded passes use the same descriptor from offset zero');
    } finally {restore();}
    assert.equal(readFileSync(file, 'utf8'), 'new bytes');
  });
}

test('same-metadata candidate rewrite is detected before publishing or losing the captured original', t => {
  const f = fixture(t); writeFileSync(f.target, 'before');
  const candidate = f.artifact(f.candidateName);
  let restore = () => {}, changed = false;
  try {
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), onPhase: phase => {
      if (phase === 'before_publish') restore = freezeFileMetadata(candidate, (position, count) => {
        if (!changed && position === 0 && count > 0) {changed = true; writeFileSync(candidate, 'new bytes\r\n');}
      });
    }}));
    assert.equal(changed, true); assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'changed'); assert.ok(!names(f.projectDir).includes('AGENTS.md'));
  } finally {restore();}
  assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
  assert.equal(readFileSync(candidate, 'utf8'), 'new bytes\r\n');
});

test('closing during the verification pass prevents all later reads', t => {
  const f = fixture(t); writeFileSync(f.target, 'same size');
  const controller = new AbortController(); let firstPasses = 0, afterCloseReads = 0;
  const restore = freezeFileMetadata(f.target, (position, count) => {
    if (controller.signal.aborted) afterCloseReads++;
    if (position === 0 && count > 0 && ++firstPasses === 2) controller.abort();
  });
  try {
    assert.deepEqual(readRulesFile(f.projectDir, {signal: controller.signal}), {status: 'error', code: 'aborted'});
    assert.equal(firstPasses, 2); assert.equal(afterCloseReads, 0);
  } finally {restore();}
});

test('read and write share the plain-text control validator without changing bytes', t => {
  const f = fixture(t);
  for (const text of ['bad\u0000text', 'bad\u000btext', 'bad\u0085text']) {
    writeFileSync(f.target, text);
    assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: 'invalid_text'});
    assert.equal(publishRulesFile(f.projectDir, f.input({text})).status, 'error');
    assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
  }
});

test('overlong file reads are capped at 8193 bytes, including a much larger existing file', t => {
  const f = fixture(t); writeFileSync(f.target, Buffer.alloc(64 * 1024, 97));
  const original = fs.readSync; let requested = 0;
  fs.readSync = ((...args: unknown[]) => {
    // This module always uses the positional Buffer overload.
    requested += Number(args[3]);
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {assert.deepEqual(readRulesFile(f.projectDir), {status: 'error', code: 'too_large'}); assert.equal(requested, 8193);}
  finally {fs.readSync = original; syncBuiltinESMExports();}
});

test('publication records durable before/after evidence and preserves CRLF; successful artifacts are removed', t => {
  const f = fixture(t); writeFileSync(f.target, 'Before\r\n');
  const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('Before\r\n')}));
  assert.equal(result.status, 'published'); assert.equal(readFileSync(f.target, 'utf8'), 'New rules\r\n');
  assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
  assert.deepEqual(f.checkpoints.map(x => x.phase), ['before_candidate', 'candidate_created', 'before_capture', 'original_captured', 'before_publish', 'published', 'before_cleanup', 'completed']);
  if (result.status !== 'published') return;
  assert.equal(result.evidence.capturedHash, hash('Before\r\n'));
  assert.equal(result.evidence.candidateIdentity!.ino, result.evidence.publishedIdentity!.ino);
  assert.equal(result.evidence.publishedIdentity!.ino, String(statSync(f.target, {bigint: true}).ino));
  assert.doesNotThrow(() => JSON.stringify(result.evidence));
});

test('publication creates an absent file and a zero-byte text remains a file', t => {
  const f = fixture(t); assert.equal(publishRulesFile(f.projectDir, f.input({text: ''})).status, 'published');
  assert.equal(readFileSync(f.target).length, 0); assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
});

test('publication refuses invalid intent names, hashes, oversized text, and lone surrogates before any effect', t => {
  const f = fixture(t);
  for (const patch of [{candidateName: '../AGENTS.md'}, {backupName: 'AGENTS.md'}, {expectedExists: true},
    {expectedHash: hash('x')}, {text: 'a'.repeat(8193)}, {text: '\ud800'}]) {
    assert.equal(publishRulesFile(f.projectDir, f.input(patch)).status, 'error'); assert.deepEqual(names(f.projectDir), []);
  }
});

test('pre-existing publication names are never overwritten', t => {
  const f = fixture(t);
  for (const artifact of [f.candidateName, f.backupName]) {
    writeFileSync(f.artifact(artifact), 'foreign');
    const result = publishRulesFile(f.projectDir, f.input());
    assert.equal(result.status, 'conflict'); assert.equal(readFileSync(f.artifact(artifact), 'utf8'), 'foreign');
    unlinkSync(f.artifact(artifact));
  }
});

test('hash conflict restores captured bytes without overwriting and keeps the candidate as evidence', t => {
  const f = fixture(t); writeFileSync(f.target, 'external edit');
  const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('approved before')}));
  assert.equal(result.status, 'conflict'); assert.equal(result.code, 'before_conflict');
  assert.equal(readFileSync(f.target, 'utf8'), 'external edit');
  assert.equal(readFileSync(f.artifact(f.candidateName), 'utf8'), 'New rules\r\n');
  assert.deepEqual(names(f.projectDir), [f.candidateName, 'AGENTS.md'].sort());
});

test('invalid UTF-8 or oversized external replacements are restored without unbounded reads', t => {
  for (const changed of [Buffer.from([0xff]), Buffer.alloc(8193, 42)]) {
    const f = fixture(t); writeFileSync(f.target, changed);
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('approved')}));
    assert.equal(result.status, 'conflict'); assert.deepEqual(readFileSync(f.target), changed);
  }
});

test('unsupported hard links refuse publication and never fall back to overwriting rename', t => {
  const f = fixture(t); writeFileSync(f.target, 'before');
  const original = fs.linkSync;
  fs.linkSync = () => {throw Object.assign(new Error('Unsupported'), {code: 'ENOTSUP'});}; syncBuiltinESMExports();
  try {
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before')}));
    assert.equal(result.status !== 'published' && result.code, 'hardlink_unavailable');
    assert.ok(!names(f.projectDir).includes('AGENTS.md'));
    assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
    assert.equal(readFileSync(f.artifact(f.candidateName), 'utf8'), 'New rules\r\n');
  } finally {fs.linkSync = original; syncBuiltinESMExports();}
});

test('deferred publication retains inode proof until explicit safe cleanup after upper-layer completion', t => {
  const f = fixture(t); writeFileSync(f.target, 'before');
  const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), deferCleanup: true}));
  assert.equal(result.status, 'published'); if (result.status !== 'published') return;
  assert.equal(result.evidence.phase, 'published');
  const candidate = inspectRulesArtifact(f.projectDir, f.candidateName), backup = inspectRulesArtifact(f.projectDir, f.backupName);
  assert.equal(candidate.status, 'safe'); assert.equal(backup.status, 'safe');
  if (candidate.status === 'safe') assert.equal(candidate.identity.ino, result.evidence.publishedIdentity!.ino);
  assert.deepEqual(inspectRulesArtifact(f.projectDir, '../AGENTS.md'), {status: 'error', code: 'invalid_publication'});
  const cleaned = finishRulesFileCleanup(f.projectDir, result.evidence, {checkpoint: e => {f.checkpoints.push(e);}});
  assert.equal(cleaned.status, 'published'); assert.equal(cleaned.evidence!.phase, 'completed');
  assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
});

test('explicit cleanup refuses replaced artifacts or modified target and never deletes foreign bytes', t => {
  for (const replaced of ['candidate', 'backup', 'target'] as const) {
    const f = fixture(t); writeFileSync(f.target, 'before');
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), deferCleanup: true}));
    assert.equal(result.status, 'published'); if (result.status !== 'published') continue;
    const file = replaced === 'target' ? f.target : f.artifact(replaced === 'candidate' ? f.candidateName : f.backupName);
    renameSync(file, `${file}.old`); writeFileSync(file, 'foreign');
    const before = names(f.projectDir);
    const cleaned = finishRulesFileCleanup(f.projectDir, result.evidence, {checkpoint: () => {}});
    assert.equal(cleaned.status, 'unknown'); assert.deepEqual(names(f.projectDir), before);
    assert.equal(readFileSync(file, 'utf8'), 'foreign');
  }
});

for (const expectedExists of [false, true]) {
  test(`external target creation before publication never gets overwritten (${expectedExists})`, t => {
    const f = fixture(t); if (expectedExists) writeFileSync(f.target, 'before');
    const result = publishRulesFile(f.projectDir, f.input({expectedExists, expectedHash: expectedExists ? hash('before') : null,
      onPhase: phase => {if (phase === 'before_publish') writeFileSync(f.target, 'foreign');}}));
    assert.equal(result.status, 'conflict'); assert.equal(result.code, 'target_exists');
    assert.equal(readFileSync(f.target, 'utf8'), 'foreign');
    assert.equal(readFileSync(f.artifact(f.candidateName), 'utf8'), 'New rules\r\n');
    if (expectedExists) assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
  });
}

test('conflict restoration also refuses an externally recreated target and retains both sides', t => {
  const f = fixture(t); writeFileSync(f.target, 'changed');
  const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), onPhase: phase => {
    if (phase === 'before_restore') writeFileSync(f.target, 'new external');
  }}));
  assert.equal(result.status, 'conflict'); assert.equal(readFileSync(f.target, 'utf8'), 'new external');
  assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'changed');
  assert.equal(readFileSync(f.artifact(f.candidateName), 'utf8'), 'New rules\r\n');
});

test('equal after hash from an external inode is not proof of publication ownership', t => {
  const f = fixture(t);
  const result = publishRulesFile(f.projectDir, f.input({onPhase: phase => {
    if (phase === 'before_publish') writeFileSync(f.target, 'New rules\r\n');
  }}));
  assert.equal(result.status, 'conflict'); assert.equal(result.evidence!.publishedIdentity, null);
  assert.notEqual(statSync(f.target).ino, statSync(f.artifact(f.candidateName)).ino);
});

test('replaced candidate or backup is neither published nor cleaned up as our artifact', t => {
  for (const replaced of ['candidate', 'backup'] as const) {
    const f = fixture(t); writeFileSync(f.target, 'before');
    const file = f.artifact(replaced === 'candidate' ? f.candidateName : f.backupName);
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), onPhase: phase => {
      if (phase === 'before_publish') {renameSync(file, `${file}.old`); writeFileSync(file, 'foreign');}
    }}));
    assert.equal(result.status, 'unknown'); assert.equal(readFileSync(file, 'utf8'), 'foreign');
    assert.ok(!names(f.projectDir).includes('AGENTS.md'));
  }
});

test('an external replacement after link is retained and publication becomes unknown', t => {
  const f = fixture(t);
  const result = publishRulesFile(f.projectDir, f.input({onPhase: phase => {
    if (phase === 'published') {renameSync(f.target, `${f.target}.ours`); writeFileSync(f.target, 'New rules\r\n');}
  }}));
  assert.equal(result.status, 'unknown');
  assert.ok(names(f.projectDir).includes(f.candidateName)); assert.equal(readFileSync(f.target, 'utf8'), 'New rules\r\n');
});

const publicationPhases: RulesPublicationPhase[] = ['before_candidate', 'candidate_created', 'before_capture', 'original_captured', 'before_publish', 'published', 'before_cleanup', 'completed'];
for (const phase of publicationPhases) {
  test(`closing at ${phase} has no effects after the checkpoint returns`, t => {
    const f = fixture(t); writeFileSync(f.target, 'before'); const controller = new AbortController();
    let stoppedSnapshot: Record<string, string> | undefined;
    const snapshot = () => Object.fromEntries(names(f.projectDir).map(name => [name, hash(readFileSync(f.artifact(name)))]));
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), signal: controller.signal,
      onPhase: current => {if (current === phase) {controller.abort(); stoppedSnapshot = snapshot();}}}));
    assert.equal(result.status === 'published', false); assert.equal(result.status !== 'published' && result.code, 'aborted');
    assert.deepEqual(snapshot(), stoppedSnapshot);
  });
}

test('a failed durable checkpoint prevents its following effect, including publication', t => {
  for (const phase of ['before_candidate', 'before_capture', 'before_publish'] as const) {
    const f = fixture(t); writeFileSync(f.target, 'before');
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true, expectedHash: hash('before'), checkpoint: evidence => {
      if (evidence.phase === phase) throw new Error('history unavailable');
    }}));
    assert.equal(result.status !== 'published' && result.code, 'checkpoint_failed');
    if (phase === 'before_candidate') assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
    else if (phase === 'before_capture') assert.equal(readFileSync(f.target, 'utf8'), 'before');
    else assert.ok(!names(f.projectDir).includes('AGENTS.md'));
  }
});

test('async durable callbacks are refused before candidate creation', t => {
  const f = fixture(t);
  const result = publishRulesFile(f.projectDir, f.input({checkpoint: async () => {}}));
  assert.equal(result.status, 'error'); assert.deepEqual(names(f.projectDir), []);
});

for (const effect of ['candidate_opened', 'candidate_synced', 'original_renamed', 'target_linked', 'backup_removed', 'candidate_removed', 'backup_restored'] as const) {
  test(`closing immediately after ${effect} prevents subsequent effects`, t => {
    const f = fixture(t); writeFileSync(f.target, 'before'); const controller = new AbortController();
    const snapshot = () => Object.fromEntries(names(f.projectDir).map(name => [name, hash(readFileSync(f.artifact(name)))]));
    let stoppedSnapshot: Record<string, string> | undefined;
    const result = publishRulesFile(f.projectDir, f.input({expectedExists: true,
      expectedHash: hash(effect === 'backup_restored' ? 'different' : 'before'), signal: controller.signal,
      afterEffect: current => {if (current === effect) {controller.abort(); stoppedSnapshot = snapshot();}}}));
    assert.equal(result.status, 'unknown'); assert.deepEqual(snapshot(), stoppedSnapshot);
  });
}

for (const phase of publicationPhases) {
  test(`SIGKILL at ${phase} retains durable intent evidence without late cleanup`, t => {
    const f = fixture(t); writeFileSync(f.target, 'before');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/mio-rules-file-crash.ts', import.meta.url)),
      f.projectDir, phase, f.candidateName, f.backupName], {timeout: 15_000});
    assert.equal(child.signal, 'SIGKILL');
    const evidence = JSON.parse(readFileSync(path.join(f.root, 'evidence.json'), 'utf8')) as RulesPublicationEvidence;
    assert.equal(evidence.phase, phase); assert.equal(evidence.beforeHash, hash('before'));
    if (phase === 'before_candidate') assert.deepEqual(names(f.projectDir), ['AGENTS.md']);
    if (phase === 'original_captured' || phase === 'before_publish') {
      assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
      assert.equal(evidence.capturedHash, hash('before')); assert.ok(!names(f.projectDir).includes('AGENTS.md'));
    }
    if (phase === 'published' || phase === 'before_cleanup' || phase === 'completed') {
      assert.equal(readFileSync(f.target, 'utf8'), 'after\r\n');
      assert.equal(evidence.publishedIdentity!.ino, String(statSync(f.target, {bigint: true}).ino));
    }
  });
}

for (const effect of ['candidate_opened', 'candidate_synced', 'original_renamed', 'target_linked', 'backup_removed', 'candidate_removed', 'backup_restored'] as const) {
  test(`SIGKILL after ${effect} leaves its preceding durable evidence for conservative recovery`, t => {
    const f = fixture(t); writeFileSync(f.target, 'before');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/mio-rules-file-crash.ts', import.meta.url)),
      f.projectDir, effect, f.candidateName, f.backupName], {timeout: 15_000});
    assert.equal(child.signal, 'SIGKILL');
    const evidence = JSON.parse(readFileSync(path.join(f.root, 'evidence.json'), 'utf8')) as RulesPublicationEvidence;
    if (effect === 'target_linked') {
      assert.equal(evidence.phase, 'before_publish'); assert.equal(evidence.publishedIdentity, null);
      const target = readRulesFile(f.projectDir), candidate = inspectRulesArtifact(f.projectDir, f.candidateName);
      assert.equal(target.status, 'safe'); assert.equal(candidate.status, 'safe');
      if (target.status === 'safe' && candidate.status === 'safe') {
        assert.equal(target.identity.ino, evidence.candidateIdentity!.ino);
        assert.equal(target.identity.ino, candidate.identity.ino); assert.equal(target.hash, evidence.afterHash);
      }
    } else if (effect === 'original_renamed') {
      assert.equal(evidence.phase, 'before_capture'); assert.equal(evidence.capturedIdentity, null);
      assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
      assert.ok(!names(f.projectDir).includes('AGENTS.md'));
    } else if (effect === 'backup_restored') {
      assert.equal(evidence.phase, 'before_restore'); assert.equal(readFileSync(f.target, 'utf8'), 'before');
      assert.equal(readFileSync(f.artifact(f.backupName), 'utf8'), 'before');
    }
  });
}
