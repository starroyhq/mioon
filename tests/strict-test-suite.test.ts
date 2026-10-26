import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('./', import.meta.url));
const frozen = ['fixtures/workspace-restore-legacy/', 'fixtures/workspace-restore-v27/legacy-contracts/'];
function currentTests(directory = root): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (frozen.some(prefix => `${relative}/`.startsWith(prefix))) return [];
    return entry.isDirectory() ? currentTests(file) : entry.isFile() && /\.test\.(?:mjs|ts)$/.test(entry.name) ? [file] : [];
  });
}

test('every current test is TypeScript and belongs to the strict tests project', () => {
  const files = currentTests().sort();
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter(file => file.endsWith('.mjs')), [], 'historical evidence and generated child scripts are not current test suites');
  const configFile = path.join(root, 'tsconfig.tests.json');
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.strict, true);
  for (const flag of ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply',
    'strictPropertyInitialization', 'strictBuiltinIteratorReturn', 'alwaysStrict', 'useUnknownInCatchVariables'] as const) {
    assert.notEqual(parsed.options[flag], false, `${flag} must inherit strict mode`);
  }
  assert.deepEqual(parsed.fileNames.filter(file => /\.test\.ts$/.test(file)).sort(), files);
});
