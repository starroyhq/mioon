import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import type {Loader} from 'esbuild';

// Shared bridge for tests that read real TypeScript source text, extract a
// reviewed fragment and execute it. The production source is typechecked; tests
// execute the same statements after erasing types with the pinned local esbuild.
// Keep the loader explicit: '.tsx' for fragments that may contain JSX, '.ts' for
// plain Node fragments. This helper deliberately does not validate or rewrite
// the fragment; each caller keeps its own exact seams and assertions.
export interface SourceLoader { readonly loader?: Loader }
/** Callable/constructable replacement for the global Function constructor. */
export interface LenientFunctionConstructor {
  (...args: string[]): (...values: unknown[]) => unknown;
  new (...args: string[]): (...values: unknown[]) => unknown;
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}

export function extractBetween(source: string, start: string, end: string): string {
  const first = source.indexOf(start);
  if (first < 0) throw new Error(`Missing source seam: ${start}`);
  const last = source.indexOf(end, first + start.length);
  if (last < 0) throw new Error(`Missing end seam: ${end}`);
  if (source.indexOf(start, first + start.length) >= 0) throw new Error(`Ambiguous source seam: ${start}`);
  return source.slice(first, last);
}

export function stripSourceTypes(source: string, {loader = 'tsx'}: SourceLoader = {}): string {
  const result = transformSync(source, {
    loader, target: 'es2022', format: 'cjs', legalComments: 'none', minify: false, sourcemap: false,
  });
  return result.code.replace(/^["']use strict["'];?\s*/u, '');
}

// Function-constructor wrapper for retained test seams that now slice typed
// TypeScript source. It keeps the historical contract: execute the exact
// fragment with the supplied parameter names/values. If native parsing rejects
// TypeScript syntax, erase those types with the same pinned esbuild transform
// and retry once; any other SyntaxError is rethrown unchanged.
function lenientFunctionImpl(...args: string[]): (...values: unknown[]) => unknown {
  try { return new Function(...args) as (...values: unknown[]) => unknown; }
  catch (error) {
    const body = args[args.length - 1];
    if (!(error instanceof SyntaxError) || typeof body !== 'string') throw error;
    return new Function(...args.slice(0, -1), stripSourceTypes(body, {loader: 'tsx'})) as (...values: unknown[]) => unknown;
  }
}
// The call sites intentionally replace the global Function constructor; the
// public type stays both callable and constructable for that migration seam.
export const lenientFunction = lenientFunctionImpl as unknown as LenientFunctionConstructor;

// Execute a statement fragment with the same Function-constructor contract the
// historical tests used. Callers pass the exact parameter names and values.
export function evaluateSource<T = unknown>(source: string, parameterNames: readonly string[] = [], values: readonly unknown[] = [], {loader = 'tsx'}: SourceLoader = {}): T {
  if (parameterNames.length !== values.length) throw new Error('Source parameter names and values must match');
  return Function(...parameterNames, stripSourceTypes(source, {loader}))(...values) as T;
}

// Evaluate one expression in a fragment. The fragment may contain statements
// before the final expression (for example helper declarations).
export function evaluateExpression<T = unknown>(source: string, expression: string, parameterNames: readonly string[] = [], values: readonly unknown[] = [], {loader = 'tsx'}: SourceLoader = {}): T {
  return evaluateSource<T>(`${source}\nreturn (${expression});`, parameterNames, values, {loader});
}

// Execute a whole TypeScript module and return its CommonJS exports. Use this
// only for closed reviewed fixtures; module-rewriting tests keep their own
// explicit resolver/plugins.
export function evaluateModule<T = Record<string, unknown>>(source: string, {loader = 'tsx'}: SourceLoader = {}): T {
  const module: {exports: unknown} = {exports: {}};
  const execute = Function('module', 'exports', 'require', stripSourceTypes(source, {loader}));
  execute(module, module.exports, () => { throw new Error('Unexpected runtime require in reviewed source fragment'); });
  return module.exports as T;
}
