import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {installedTypeScript} from '../scripts/lib/local-tooling.mjs';

// Frozen pre-migration implementations are text fixtures, not live modules.
// Compare emitted executable syntax, allowing only the dependency extension
// change and redundant parentheses introduced by erased type assertions.
const modules = [
  ['packages/contracts/src/timeline-volume-envelope.ts', 'timeline-volume-envelope.mjs.txt'],
  ['packages/business/src/timeline-volume-envelope-filter-candidate.ts', 'timeline-volume-envelope-filter-candidate.mjs.txt'],
];

test('envelope TypeScript migrations preserve the complete emitted runtime', async () => {
  const root = new URL('../', import.meta.url);
  const compiler = await installedTypeScript(root.pathname);
  const require = createRequire(pathToFileURL(compiler.entry));
  const ts = require('../lib/typescript.js');
  const options = {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true};
  const normalize = source => {
    const emitted = ts.transpileModule(source, {compilerOptions: options}).outputText;
    const parsed = ts.createSourceFile('runtime.mjs', emitted, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const syntax = node => {
      if (ts.isParenthesizedExpression(node)) return syntax(node.expression);
      const children = [];
      ts.forEachChild(node, child => { children.push(syntax(child)); });
      return children.length ? [node.kind, children] : [node.kind, node.getText(parsed)];
    };
    return syntax(parsed);
  };
  for (const [implementation, fixture] of modules) {
    const before = (await readFile(new URL(`tests/fixtures/volume-envelope-type-only/${fixture}`, root), 'utf8'))
      .replaceAll('timeline-volume-envelope.mjs', 'timeline-volume-envelope.ts');
    const after = await readFile(new URL(implementation, root), 'utf8');
    assert.deepEqual(normalize(after), normalize(before), `${implementation}: runtime statements, operators and strings must remain unchanged`);
  }
});
