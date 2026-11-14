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
const childModules = new Set(['child_process', 'node:child_process']);
const childMethods = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'spawn', 'spawnSync']);

function isServerEntry(specifier: string): boolean {
  return specifier === '@mioon/server' ||
    /(?:^|\/)apps\/server\/src\/(?:index|project-runtime|project-host\/runtime)(?:\.[cm]?[jt]s)?$/u.test(specifier);
}

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

function serverSpecifier(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node) && isServerEntry(node.text)) return node.text;
  return ts.forEachChild(node, serverSpecifier);
}

function hasInlineServerImport(script: string): boolean {
  if (!/\b(?:import|require)\b/u.test(script)) return false;
  const source = ts.createSourceFile('inline.ts', script, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): boolean | undefined {
    const imported = importedAtRuntime(node);
    if (imported && serverSpecifier(imported)) return true;
    return ts.forEachChild(node, visit);
  }
  return Boolean(visit(source));
}

function inlineText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => {
    const entry = serverSpecifier(span.expression);
    return (entry ? JSON.stringify(entry) : 'undefined') + span.literal.text;
  }).join('');
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

// These commands perform local media, archive, filesystem or system queries.
// They do not load service provider configuration.
const localTools = new Set(['ffmpeg', 'ffprobe', 'mkfifo', 'tar', 'icacls.exe', 'fsutil.exe', '/bin/ps', '/usr/bin/sw_vers']);
const localGitQueries = new Set(['rev-parse', 'show', 'archive', 'diff', 'check-ignore']);

function isLocalTool(command: ts.Expression | undefined, args: ts.ArrayLiteralExpression | undefined): boolean {
  if (!command || !ts.isStringLiteralLike(command)) return false;
  if (localTools.has(command.text)) return true;
  if (!args) return false;
  const first = args.elements[0];
  if (command.text === 'which') return args.elements.length === 1 && first && ts.isStringLiteralLike(first) && first.text === 'mkfifo';
  if (command.text !== 'git') return false;
  // Existing fixtures use pairs of -C/-c and a fixed local Git subcommand.
  let index = 0;
  while (index < args.elements.length) {
    const word = args.elements[index];
    if (!word || !ts.isStringLiteralLike(word)) return false;
    if (word.text !== '-C' && word.text !== '-c') return localGitQueries.has(word.text);
    index += 2;
  }
  return false;
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
  const childNamespaces = new Set<string>();
  const childNames = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !childModules.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) childNamespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) childNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && childMethods.has(exported)) childNames.set(element.name.text, exported);
    }
  }
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) declarations.push(node);
    ts.forEachChild(node, collect);
  }
  collect(source);
  const initializers = new Map<string, ts.Expression>();
  for (const {name, initializer} of declarations) {
    if (ts.isIdentifier(name) && initializer) initializers.set(name.text, initializer);
    const loaded = initializer && importedAtRuntime(ts.isAwaitExpression(initializer) ? initializer.expression : initializer);
    if (!loaded || !ts.isStringLiteralLike(loaded) || !childModules.has(loaded.text)) continue;
    if (ts.isIdentifier(name)) childNamespaces.add(name.text);
    if (ts.isObjectBindingPattern(name)) for (const element of name.elements) {
      const exported = element.propertyName ?? element.name;
      if (ts.isIdentifier(exported) && ts.isIdentifier(element.name) && childMethods.has(exported.text)) {
        childNames.set(element.name.text, exported.text);
      }
    }
  }

  function childMethod(node: ts.Node): string | undefined {
    const expression = throughParentheses(node);
    if (ts.isIdentifier(expression)) return childNames.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = member(expression);
      const namespace = throughParentheses(expression.expression);
      const loaded = importedAtRuntime(ts.isAwaitExpression(namespace) ? namespace.expression : namespace);
      if (name && childMethods.has(name) && (ts.isIdentifier(namespace) && childNamespaces.has(namespace.text) ||
        loaded && ts.isStringLiteralLike(loaded) && childModules.has(loaded.text))) return name;
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'promisify' && expression.arguments[0]) return childMethod(expression.arguments[0]);
  }

  function resolved(node: ts.Node | undefined): ts.Node | undefined {
    const seen = new Set<string>();
    while (node) {
      const expression = throughParentheses(node);
      if (!ts.isIdentifier(expression) || seen.has(expression.text)) return expression;
      seen.add(expression.text);
      const initializer = initializers.get(expression.text);
      if (!initializer) return expression;
      node = initializer;
    }
  }

  function childArguments(call: ts.CallExpression, method: string): {args?: ts.ArrayLiteralExpression; options?: ts.Node} {
    const second = resolved(call.arguments[1]);
    if (method === 'exec' || method === 'execSync') return {options: second};
    if (second && ts.isArrayLiteralExpression(second)) return {args: second, options: resolved(call.arguments[2])};
    // An identifier such as args or argv can be a function parameter.
    if (call.arguments.length >= 3 || second && !ts.isObjectLiteralExpression(second) && method.startsWith('spawn')) {
      return {options: resolved(call.arguments[2])};
    }
    return {options: second};
  }

  function explicitEnvironment(options: ts.Node | undefined): boolean {
    if (!options) return false;
    if (ts.isObjectLiteralExpression(options)) {
      return options.properties.some(property => {
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'env') return true;
        if (!ts.isPropertyAssignment(property) || !property.name ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) || property.name.text !== 'env') return false;
        const value = throughParentheses(property.initializer);
        return value.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(value) && value.text === 'undefined');
      });
    }
    // Named caller-owned options may arrive through helpers and typed parameters.
    return ts.isIdentifier(options) ? options.text !== 'undefined' && !/^(?:callback|cb|done)$/u.test(options.text)
      : options.kind !== ts.SyntaxKind.NullKeyword && !ts.isFunctionExpression(options) && !ts.isArrowFunction(options);
  }

  function inlineChildImport(args: ts.ArrayLiteralExpression | undefined): boolean {
    if (!args) return false;
    return args.elements.some((arg, i) => {
      if (!ts.isStringLiteralLike(arg)) return false;
      const candidate = arg.text === '-e' || arg.text === '--eval' ? resolved(args.elements[i + 1]) : arg;
      const script = arg.text.startsWith('--eval=') ? arg.text.slice('--eval='.length)
        : candidate && candidate !== arg ? inlineText(candidate) : undefined;
      return script !== undefined && hasInlineServerImport(script);
    });
  }
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

  // Follow normal aliases and util.promisify wrappers of the child APIs.
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const method = childMethod(declaration.initializer);
    if (method) childNames.set(declaration.name.text, method);
  }

  const environmentLines = new Set<number>();
  const implicitLines = new Set<number>();
  const serverLines = new Set<number>();
  function visit(node: ts.Node): void {
    const imported = importedAtRuntime(node);
    if (file !== serverHelper && imported && serverSpecifier(imported)) serverLines.add(position(node));
    if (ts.isCallExpression(node)) {
      const method = childMethod(node.expression);
      if (method) {
        const {args, options} = childArguments(node, method);
        const line = position(node);
        if (!explicitEnvironment(options) && !isLocalTool(node.arguments[0], args)) implicitLines.add(line);
      }
    }
    if (ts.isArrayLiteralExpression(node) && inlineChildImport(node)) serverLines.add(position(node));
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
    ...[...implicitLines].map(line => ({line, fix: 'pass env: testEnv() or an explicit fixture environment to the child process'})),
    ...[...serverLines].map(line => ({line, fix: 'use the isolated entry point in tests/helpers/test-server.ts'})),
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
    "import {composeHostedProject} from '../apps/server/src/project-host/runtime.ts';",
    "await import('../apps/server/src/project-runtime.ts');",
    "launch(['-e', `import {startServer} from '@mioon/server';`]);",
    "launch(['--eval=await import(\"./apps/server/src/project-runtime.ts\")']);",
    "const code = `await import(${JSON.stringify(new URL('../apps/server/src/index.ts', import.meta.url).href)});`; launch(['--eval', code]);",
  ];
  for (const source of raw) assert.deepEqual(isolationViolations('fixture.ts', source).map(({line}) => line), [1], source);
  const safe = [
    "import type {ProjectRuntime} from '../apps/server/src/project-runtime.ts';",
    "import type {HostedProject} from '../apps/server/src/project-host/runtime.ts';",
    "import type {ServerOptions} from '../apps/server/src/index.ts';",
    "import {type ServerOptions} from '@mioon/server';",
    "type Options = import('../apps/server/src/index.ts').ServerOptions;",
    "await import('./helpers/test-server.ts');",
  ];
  for (const source of safe) assert.deepEqual(isolationViolations('fixture.ts', source), [], source);
});

test('the guard detects implicit child environments and documents local exceptions', () => {
  const raw = [
    "import {spawn} from 'node:child_process'; spawn(command);",
    "import {fork} from 'node:child_process'; fork(script, []);",
    "import {spawn} from 'node:child_process'; spawn('git', ['push', 'show']);",
    "import {spawn} from 'node:child_process'; const options = {stdio: 'ignore'}; const alias = options; spawn(command, args, alias);",
    "import {exec as shell} from 'child_process'; shell(command, callback);",
    "import * as cp from 'node:child_process'; cp.execFileSync(command, args, {encoding: 'utf8'});",
    "const {spawnSync: run} = await import('node:child_process'); run(command, [], {env: undefined});",
    "const cp = require('node:child_process'); cp.spawn(command, [], {env: null});",
    "import {execFile} from 'node:child_process'; const run = promisify(execFile); run(command, [], {cwd: root});",
  ];
  for (const source of raw) assert.match(isolationViolations('fixture.ts', source)[0]?.fix ?? '', /pass env/, source);
  const safe = [
    "import {spawn} from 'node:child_process'; spawn(command, {env: testEnv()});",
    "import {fork} from 'node:child_process'; fork(script, [], {env: {PATH: '/test/bin'}});",
    "import {execFileSync as run} from 'node:child_process'; run('ffmpeg', args);",
    "import {spawn} from 'node:child_process'; spawn('git', ['show', 'HEAD']);",
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
