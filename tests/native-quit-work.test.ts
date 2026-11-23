import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeCloseAdmission, createNativeCloseRegistry} from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';

function admission(readQuitWork: Parameters<typeof createNativeCloseAdmission>[0]['readQuitWork'], token = 'work-token') {
  return createNativeCloseAdmission({registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => 'work-scope', newToken: () => token, now: () => 1000, readQuitWork});
}
test('renderer close inspection carries only a bounded work summary on version 2', () => {
  const inspection = admission(() => [{kind: 'export', count: 1}, {kind: 'generation', count: 2, unknown: true}]).inspect();
  assert.equal(inspection.version, 2); assert.equal(inspection.token, 'work-token');
  assert.deepEqual(inspection.work, [{kind: 'export', count: 1}, {kind: 'generation', count: 2, unknown: true}]);
  assert.ok(Object.isFrozen(inspection.work));
});
test('a malformed or throwing work provider falls back to the version-1 close protocol', () => {
  for (const provider of [() => [{kind: 'unknown-kind', count: 1}], () => [{kind: 'export', count: 0}],
    () => [{kind: 'export', count: 1}, {kind: 'export', count: 1}], () => {throw Error('provider failed');}]) {
    const inspection = admission(provider as Parameters<typeof createNativeCloseAdmission>[0]['readQuitWork']).inspect();
    assert.equal(inspection.version, 1); assert.equal(inspection.work, undefined);
  }
});
test('work summary is bounded to six categories and stays off reload inspection', () => {
  const kinds = ['export', 'preview', 'generation', 'mio', 'import', 'pending', 'unknown'] as const;
  const tooMany = admission(() => kinds.map(kind => ({kind, count: 1}))).inspect();
  assert.equal(tooMany.version, 1);
  const reload = admission(() => [{kind: 'export', count: 1}]).inspect('reload', 'http://127.0.0.1:45000/?project=project-a');
  assert.equal(reload.version, 1); assert.equal(reload.work, undefined);
});
