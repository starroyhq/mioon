import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {providerEnvironmentKeys} from '../packages/business/src/providers/environment.ts';
import {testEnv} from './helpers/test-env.ts';

const root = fileURLToPath(new URL('./', import.meta.url));
const environmentHelper = path.join(root, 'helpers', 'test-env.ts');
const serverHelper = path.join(root, 'helpers', 'test-server.ts');
const processModules = new Set(['process', 'node:process']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) ? [file] : [];
  });
}

function member(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
}

function throughParentheses(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function importedAtRuntime(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return;
    if (clause?.namedBindings && !clause.name && ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length && clause.namedBindings.elements.every(element => element.isTypeOnly)) return;
    return node.moduleSpecifier;
  }
  if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
    const clause = node.exportClause;
    if (clause && ts.isNamedExports(clause) && clause.elements.length && clause.elements.every(element => element.isTypeOnly)) return;
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    ts.isIdentifier(node.expression) && node.expression.text === 'require')) return node.arguments[0];
}

function readOrWriteOnly(node: ts.Node): boolean {
  let expression = node;
  while (expression.parent && throughParentheses(expression.parent) === node) expression = expression.parent;
  const parent = expression.parent;
  if (!parent) return false;
  // Accesses such as process.env.PATH and process.env[key] use one value.
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === expression) return true;
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    return parent.name.elements.every(element => !element.dotDotDotToken);
  }
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== expression ||
    !ts.isPropertyAccessExpression(parent.expression) || !ts.isIdentifier(parent.expression.expression) ||
    parent.expression.expression.text !== 'Object') return false;
  const method = parent.expression.name.text;
  return method === 'keys' || method === 'hasOwn' || method === 'assign' && ts.isExpressionStatement(parent.parent);
}

function isolationViolations(file: string, text: string): Array<{line: number; fix: string}> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const processNames = new Set(['process']);
  const environmentNames = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !processModules.has(statement.moduleSpecifier.text)) continue;
    const {name, namedBindings} = statement.importClause ?? {};
    if (name) processNames.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) processNames.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) for (const element of namedBindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      if (exported === 'env') environmentNames.add(element.name.text);
      if (exported === 'default') processNames.add(element.name.text);
    }
  }

  const isProcess = (node: ts.Node): boolean => {
    const unwrapped = throughParentheses(node);
    const expression = ts.isAwaitExpression(unwrapped) ? throughParentheses(unwrapped.expression) : unwrapped;
    const imported = importedAtRuntime(expression);
    if (imported && ts.isStringLiteralLike(imported) && processModules.has(imported.text)) return true;
    return ts.isIdentifier(expression) && processNames.has(expression.text) ||
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      member(expression) === 'process' && ['globalThis', 'global'].includes(expression.expression.getText());
  };
  const position = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const declarations: ts.VariableDeclaration[] = [];
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  }
  collect(source);
  // Resolve simple aliases of the process object. Whole-environment aliases
  // themselves are rejected at the declaration where the raw object escapes.
  let added = true;
  while (added) {
    added = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name) && !processNames.has(declaration.name.text) && isProcess(declaration.initializer!)) {
        processNames.add(declaration.name.text);
        added = true;
      }
    }
  }

  const environmentLines = new Set<number>();
  const serverLines = new Set<number>();
  function visit(node: ts.Node): void {
    const imported = importedAtRuntime(node);
    if (file !== serverHelper && imported && ts.isStringLiteralLike(imported) &&
      (imported.text === '@mioon/server' || /(?:^|\/)apps\/server\/src\/index\.ts$/u.test(imported.text))) serverLines.add(position(node));
    if (ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name) && isProcess(node.initializer)) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (element.dotDotDotToken || ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === 'env' &&
          (!ts.isObjectBindingPattern(element.name) || element.name.elements.some(part => part.dotDotDotToken)))) environmentLines.add(position(element));
      }
    }
    const ambient = ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      member(node) === 'env' && isProcess(node.expression)) ||
      ts.isIdentifier(node) && environmentNames.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
    if (ambient && !readOrWriteOnly(node)) environmentLines.add(position(node));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [
    ...(file === environmentHelper ? [] : [...environmentLines].map(line => ({line, fix: 'use testEnv() from tests/helpers/test-env.ts'}))),
    ...[...serverLines].map(line => ({line, fix: 'import startServer from tests/helpers/test-server.ts'})),
  ].sort((a, b) => a.line - b.line);
}

test('the test environment guard detects direct copies, aliases and alternate process spellings', () => {
  const raw = [
    'spawn(command, args, {env: process.env});',
    'const supplied = {...process.env}; startServer({env: supplied});',
    'const supplied = (process["env"] as Record<string, string>);',
    'const {PATH, ...rest} = process.env;',
    'const {env: inherited} = process;',
    'const {"env": {PATH, ...rest}} = process;',
    'Object.assign({}, process.env);',
    'Object.entries(process.env).filter(([key]) => key !== "ARK_API_KEY");',
    'spawn(command, args, {env: Object.assign(process.env, fixture)});',
    'const p = globalThis.process; const options = {env: p.env};',
    "const p = require('node:process'); startServer({env: p.env});",
    "const p = await import('node:process'); startServer({env: p.env});",
    "import { env as inherited } from 'node:process'; spawn(command, args, {env: inherited});",
  ];
  for (const source of raw) assert.deepEqual(isolationViolations('fixture.ts', source).map(({line}) => line), [1], source);
  const safe = [
    'spawn(command, args, {env: {...testEnv(), PORT: "0"}});',
    'startServer({env: {PATH: process.env.PATH}});',
    'const path = (process.env as Record<string, string>).PATH;',
    'const {PATH, HOME: home} = process.env;',
    'const {env: {PATH}} = process;',
    'process.env.PORT = "0"; delete process.env.PORT;',
    'Object.keys(process.env); Object.hasOwn(process.env, key);',
    'Object.assign(process.env, syntheticFixture);',
    '// spawn(command, args, {env: process.env});',
  ];
  for (const source of safe) assert.deepEqual(isolationViolations('fixture.ts', source), [], source);
});

test('the test environment guard requires the server fixture for runtime imports', () => {
  const raw = [
    "import {startServer} from '../apps/server/src/index.ts';",
    "await import('../../apps/server/src/index.ts');",
    "export {startServer} from '@mioon/server';",
  ];
  for (const source of raw) assert.deepEqual(isolationViolations('fixture.ts', source).map(({line}) => line), [1], source);
  const safe = [
    "import type {ServerOptions} from '../apps/server/src/index.ts';",
    "import {type ServerOptions} from '@mioon/server';",
    "type Options = import('../apps/server/src/index.ts').ServerOptions;",
    "await import('./helpers/test-server.ts');",
  ];
  for (const source of safe) assert.deepEqual(isolationViolations('fixture.ts', source), [], source);
});

test('testEnv removes production provider settings and preserves unrelated test variables', () => {
  assert.ok(providerEnvironmentKeys.length > 0);
  const unrelated = {PATH: '/test/bin', TMPDIR: '/test/tmp', TZ: 'UTC', MIOON_TEST_TEMP_DIR: '/test/work'};
  const source = {...unrelated};
  for (const key of providerEnvironmentKeys) Object.assign(source, {
    [key]: 'synthetic-provider-setting',
    [key.toLowerCase()]: 'synthetic-lowercase-provider-setting',
  });
  const before = {...source};
  const filtered = testEnv(source);
  assert.deepEqual(filtered, unrelated);
  assert.notStrictEqual(filtered, source);
  assert.deepEqual(source, before);
});

test('test sources use the shared test environment before forwarding ambient variables', () => {
  const violations = sourceFiles(root).sort().flatMap(file =>
    isolationViolations(file, readFileSync(file, 'utf8')).map(({line, fix}) =>
      `tests/${path.relative(root, file).split(path.sep).join('/')}:${line} ${fix}`));
  assert.deepEqual(violations, []);
});
