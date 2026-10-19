import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';

// Shared bridge for tests that read real TypeScript source text, extract a
// reviewed fragment and execute it. The production source is typechecked; tests
// execute the same statements after erasing types with the pinned local esbuild.
// Keep the loader explicit: '.tsx' for fragments that may contain JSX, '.ts' for
// plain Node fragments. This helper deliberately does not validate or rewrite
// the fragment; each caller keeps its own exact seams and assertions.
export function readSource(file) {
  return readFileSync(file, 'utf8');
}

export function extractBetween(source, start, end) {
  const first = source.indexOf(start);
  if (first < 0) throw new Error(`Missing source seam: ${start}`);
  const last = source.indexOf(end, first + start.length);
  if (last < 0) throw new Error(`Missing end seam: ${end}`);
  if (source.indexOf(start, first + start.length) >= 0) throw new Error(`Ambiguous source seam: ${start}`);
  return source.slice(first, last);
}

export function stripSourceTypes(source, {loader = 'tsx'} = {}) {
  const result = transformSync(source, {
    loader, target: 'es2022', format: 'cjs', legalComments: 'none', minify: false, sourcemap: false,
  });
  return result.code.replace(/^["']use strict["'];?\s*/u, '');
}

// Execute a statement fragment with the same Function-constructor contract the
// historical tests used. Callers pass the exact parameter names and values.
export function evaluateSource(source, parameterNames = [], values = [], {loader = 'tsx'} = {}) {
  if (parameterNames.length !== values.length) throw new Error('Source parameter names and values must match');
  return Function(...parameterNames, stripSourceTypes(source, {loader}))(...values);
}

// Evaluate one expression in a fragment. The fragment may contain statements
// before the final expression (for example helper declarations).
export function evaluateExpression(source, expression, parameterNames = [], values = [], {loader = 'tsx'} = {}) {
  return evaluateSource(`${source}\nreturn (${expression});`, parameterNames, values, {loader});
}

// Execute a whole TypeScript module and return its CommonJS exports. Use this
// only for closed reviewed fixtures; module-rewriting tests keep their own
// explicit resolver/plugins.
export function evaluateModule(source, {loader = 'tsx'} = {}) {
  const module = {exports: {}};
  const execute = Function('module', 'exports', 'require', stripSourceTypes(source, {loader}));
  execute(module, module.exports, () => { throw new Error('Unexpected runtime require in reviewed source fragment'); });
  return module.exports;
}
