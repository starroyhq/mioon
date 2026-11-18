import test from 'node:test';
import assert from 'node:assert/strict';
import * as i18n from '../packages/i18n/src/index.ts';
import {editUiMessages} from '../packages/i18n/src/catalogs/edit-ui.ts';

test('the editing UI catalog has all four locales and exact placeholders', () => {
  assert.deepEqual(i18n.validateCatalogs(editUiMessages), []);
  for (const [key, row] of Object.entries(editUiMessages)) {
    const simplified = (row as {'zh-Hans': string | {readonly one: string; readonly other: string}})['zh-Hans'];
    const source = typeof simplified === 'string' ? simplified : simplified.other;
    const params = Object.fromEntries([...source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([, name]) => [name, name === 'version' || name === 'badge' || name === 'seconds' ? 2 : '值']));
    for (const locale of i18n.LOCALES) {
      const rendered = i18n.translate(locale, key as i18n.MessageKey, params as never);
      assert.ok(rendered.length, `${key}/${locale}`);
      for (const [name, value] of Object.entries(params)) assert.ok(rendered.includes(String(value)), `${key}/${locale} preserves ${name}`);
    }
  }
});

test('every editing UI message used by the new components is registered', () => {
  for (const key of Object.keys(editUiMessages)) assert.ok(Object.hasOwn(i18n.catalogs, key), key);
});
