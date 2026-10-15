import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {toolingEnvironment} from '../scripts/lib/local-tooling.mjs';
import {inheritedTestCompileCache} from '../scripts/lib/test-compile-cache.ts';

const execute = promisify(execFile);
const lifecycle = new URL('./helpers/agent-edit-wire-lifecycle.ts', import.meta.url).href;

for (const cleanupFails of [false, true]) {
  test(`real node:test timeout reaps the CLI and retains ${cleanupFails ? 'cleanup failure' : 'cancellation cause'}`, {timeout: 15000}, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'mioon-outer-timeout-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const records = path.join(root, 'events.jsonl');
    const child = path.join(root, 'pending.cjs');
    const entry = path.join(root, 'outer.test.mjs');
    // A failed regression may make the driver kill the runner. Its synthetic
    // child then exits on losing that parent instead of becoming a leak.
    await writeFile(child, `const owner = process.ppid;
      require('node:fs').appendFileSync(${JSON.stringify(records)}, JSON.stringify({stage: 'child-started'}) + String.fromCharCode(10));
      setInterval(() => {if (process.ppid !== owner) process.exit(99);}, 100);
    `);
    await writeFile(entry, `import test from 'node:test';
      import {appendFileSync} from 'node:fs';
      import {OwnedFixtureLifetime, fixtureCli} from ${JSON.stringify(lifecycle)};
      const note = event => appendFileSync(${JSON.stringify(records)}, JSON.stringify(event) + String.fromCharCode(10));
      // This outer deadline must cancel the unchanged 12-second helper wait.
      test('synthetic outer timeout', {timeout: 1000}, async t => {
        const forced = Error('forced cleanup failure');
        const lifetime = new OwnedFixtureLifetime({signal: t.signal, after: callback => t.after(async () => {
          try {await callback(); note({stage: 'cleanup', failed: false});}
          catch (error) {note({stage: 'cleanup', failed: true, original: error === forced}); throw error;}
        })});
        const pending = fixtureCli(lifetime, process.execPath, [${JSON.stringify(child)}], {}, 'synthetic-pending', 'synthetic');
        lifetime.deferCleanup(() => note({stage: 'remaining-disposer'}));
        if (${cleanupFails}) lifetime.deferCleanup(() => {note({stage: 'forced-disposer'}); throw forced;});
        try {await pending;}
        catch (error) {note({stage: 'helper-rejected', aborted: t.signal.aborted, sameReason: error === t.signal.reason}); throw error;}
      });
    `);

    let outcome;
    try {
      await execute(process.execPath, ['--test', '--test-reporter=tap', entry], {
        env: {...toolingEnvironment(), ...inheritedTestCompileCache()}, encoding: 'utf8', timeout: 12000, killSignal: 'SIGKILL',
      });
    } catch (error) {outcome = error;}
    assert.ok(outcome, 'the deliberately timed-out nested test must fail');
    assert.equal(outcome.code, 1, outcome.stdout + outcome.stderr);
    assert.equal(outcome.signal, null, 'nested runner must exit without the independent driver killing it');
    assert.equal(outcome.killed, false);
    assert.match(outcome.stdout, /failureType: 'testTimeoutFailure'/u);
    assert.match(outcome.stdout, /# cancelled 1\b/u);
    assert.doesNotMatch(outcome.stdout, /CLI timed out|CLI execution and reap failed/u);

    const events = (await readFile(records, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.stage === 'child-started'), 'the real owned child started before cancellation');
    assert.deepEqual(events.find(event => event.stage === 'helper-rejected'), {stage: 'helper-rejected', aborted: true, sameReason: true});
    assert.ok(events.some(event => event.stage === 'remaining-disposer'), 'cleanup continues after an earlier disposer fails');
    assert.deepEqual(events.at(-1), cleanupFails ? {stage: 'cleanup', failed: true, original: true} : {stage: 'cleanup', failed: false});
    // Node reports the original outer timeout even if an after hook also fails.
    // The marker above checks the exact cleanup error that TAP does not expose.
  });
}
