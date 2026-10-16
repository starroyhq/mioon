import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('candidate render authority exercises real SQL, hashed synthetic files and private lifetimes without media processes', () => {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', fileURLToPath(new URL('./fixtures/opacity-render-authority-pure.mjs', import.meta.url))],
    {encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='NODE_TEST_CONTEXT'))});
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pass 9/u);
});
