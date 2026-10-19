import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { catalogs, validateCatalogs, translate, LOCALES } from '../packages/i18n/src/index.ts';
import type { Locale, MessageKey } from '../packages/i18n/src/index.ts';
import { compareUILedger, inspectUILiterals, readUILedger, visibleTemplateFragment } from '../scripts/audit-ui-localization.ts';

test('every composed UI and native catalog has exact four-locale and placeholder parity', () => {
  assert.deepEqual(validateCatalogs(catalogs), []);
  for (const [key, entry] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(entry).sort(), [...LOCALES].sort(), key);
    const source = typeof entry['zh-Hans'] === 'string' ? entry['zh-Hans'] : entry['zh-Hans'].other;
    const params = Object.fromEntries([...source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => [name, name === 'count' ? 2 : `synthetic-${name}`]));
    for (const locale of LOCALES) assert.ok(translate(locale, key as MessageKey, params as never).trim(), `${key}/${locale}`);
    const english = typeof entry.en === 'string' ? entry.en : `${entry.en.one}\n${entry.en.other}`;
    assert.doesNotMatch(english, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, `${key}: source-language prose leaked into English`);
  }
});

test('UI literal ledger rejects unexplained, newly introduced and stale exceptions', () => {
  const literal = { file: 'apps/web/src/Example.jsx', category: 'visible-jsx', hash: 'exact-literal-digest', line: 1, text: 'Example' };
  assert.equal(compareUILedger([literal], { version: 1, exceptions: [] }).unreviewed.length, 1);
  assert.throws(() => compareUILedger([literal], { version: 1, exceptions: [{ ...literal, owner: 'shell' }] }), /Unexplained/);
  const reviewed = { ...literal, owner: 'shell', reason: 'Product brand, deliberately unchanged in every language.' };
  assert.deepEqual(compareUILedger([literal], { version: 1, exceptions: [reviewed] }), { unreviewed: [], stale: [] });
  assert.equal(compareUILedger([], { version: 1, exceptions: [reviewed] }).stale.length, 1);
  assert.throws(() => compareUILedger([], { version: 1, exceptions: [reviewed, reviewed] }), /Duplicate/);
});

test('current source has no unreviewed or stale static UI literal exceptions', () => {
  assert.deepEqual(compareUILedger(inspectUILiterals(), readUILedger()), { unreviewed: [], stale: [] });
});

test('static semantic keys used by UI translation calls exist in the composed catalog', () => {
  const directory = new URL('../', import.meta.url), failures: string[] = [];
  const calls = new Set(['t', 'nt', 'nativeText', 'message', 'msg', 'localizedMessage']);
  function walk(relative: string): void {
    for (const entry of fs.readdirSync(new URL(relative, directory), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { walk(`${file}/`); continue; }
      if (!/\.(?:[cm]?js|jsx|tsx?)$/u.test(file)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(new URL(file, directory), 'utf8'), ts.ScriptTarget.Latest, true);
      const verify = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(node.text) && !Object.hasOwn(catalogs, node.text)) failures.push(`${file}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}: ${node.text}`);
        else if (ts.isConditionalExpression(node)) { verify(node.whenTrue); verify(node.whenFalse); }
      };
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const name = node.expression.text, argument = calls.has(name) ? node.arguments[0] : name === 'translate' ? node.arguments[1] : undefined;
          if (argument) verify(argument);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  for (const relative of ['apps/web/src/', 'apps/desktop/src/', 'packages/ui/src/']) walk(relative);
  assert.deepEqual(failures, []);
});


test('visible template guard distinguishes app copy from dynamic semantic keys', () => {
  const source = ts.createSourceFile('Example.jsx', '<div>{t(`audio.state.${state}`)}{translate(locale, `export.phase.${phase}`)}{`Value · rev ${revision}`}{t("app.label", { detail: `Value ${value}` })}</div>', ts.ScriptTarget.Latest, true);
  const visible: string[] = [];
  function visit(node: ts.Node): void {
    if (visibleTemplateFragment(node, source)) visible.push((node as ts.StringLiteralLike).text.trim());
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(visible.filter(Boolean), ['Value · rev', 'Value']);
});
