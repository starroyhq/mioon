import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectsMessages } from '../packages/i18n/src/catalogs/subjects.ts';
import { LOCALES, catalogs, validateCatalogs, translate, renderMessage } from '../packages/i18n/src/index.ts';
import { subjectKinds, subjectKindLabel, subjectKindDescriptor } from '../apps/web/src/subject-state.js';

test('subject catalog has exact locale and placeholder parity and is integrated without overrides', () => {
  assert.deepEqual(validateCatalogs(subjectsMessages), []);
  assert.ok(Object.keys(subjectsMessages).length >= 140);
  for (const [key, entry] of Object.entries(subjectsMessages)) {
    assert.ok(key.startsWith('subjects.'));
    assert.equal(catalogs[key], entry);
    for (const locale of LOCALES) {
      const params = Object.fromEntries([...entry['zh-Hans'].matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, name === 'count' ? 3 : 'Example 2']));
      assert.ok(translate(locale, key, params).trim());
    }
  }
});

test('legacy subject labels stay stable while descriptor labels follow presentation locale', () => {
  for (const [kind, label] of subjectKinds) {
    assert.equal(subjectKindLabel(kind), label);
    assert.equal(renderMessage('zh-Hans', subjectKindDescriptor(kind)), label);
    for (const locale of LOCALES) assert.equal(renderMessage(locale, subjectKindDescriptor(kind)), subjectsMessages[`subjects.kind.${kind}`][locale]);
  }
  assert.equal(subjectKindDescriptor('future-kind'), 'future-kind');
});
