import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('./', import.meta.url));
function currentTests(directory = root): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? currentTests(file) : entry.isFile() && /\.test\.(?:mjs|ts)$/.test(entry.name) ? [file] : [];
  });
}

test('every current test is TypeScript and belongs to the split strict test projects exactly once', () => {
  const files = currentTests().sort();
  assert.ok(files.length > 0);
  assert.deepEqual(files.filter(file => file.endsWith('.mjs')), [], 'historical evidence and generated child scripts are not current test suites');
  const configs = ['tsconfig.tests-runtime.json', 'tsconfig.tests-media.json'].map(name => {
    const configFile = path.join(root, name);
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    assert.deepEqual(parsed.errors, [], name);
    assert.equal(parsed.options.strict, true, name);
    for (const flag of ['noImplicitAny', 'noImplicitThis', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply',
      'strictPropertyInitialization', 'strictBuiltinIteratorReturn', 'alwaysStrict', 'useUnknownInCatchVariables'] as const) {
      assert.notEqual(parsed.options[flag], false, `${name} ${flag} must inherit strict mode`);
    }
    return parsed;
  });
  const testFiles = configs.flatMap(parsed => parsed.fileNames.filter(file => /\.test\.ts$/.test(file)));
  assert.deepEqual([...testFiles].sort(), files);
  assert.equal(new Set(testFiles).size, testFiles.length, 'the split projects must not compile the same test twice');
  const options = configs.map(({options: parsed}) => {
    const {configFilePath: _ignored, ...rest} = parsed;
    return rest;
  });
  assert.deepEqual(options[0], options[1], 'both split projects must keep identical strict compiler options');
});
