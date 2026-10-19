import assert from 'node:assert/strict';
import { readNativeLegacyClose } from '../../apps/web/src/native-close-legacy.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../../apps/web/src/settings-navigation-state.ts';
import { stripSourceTypes } from '../helpers/eval-source.mjs';

/** Existing draft regressions execute the actual App predicate through the real
 * new close controller. No business controller or dirty assertion is replaced. */
export function actualAppCloseWarning(app, bindings) {
  const expression = app.match(/readLegacySnapshot: \(\) => readNativeLegacyClose\((\{[\s\S]*?\})\),/)?.[1];
  assert.ok(expression, 'App must bind the exact pure legacy close snapshot');
  assert.match(app, /useEffect\(\(\) => installNativeCloseAdmission\(window/);
  const env = { shotCloseRef: { current: null }, subtitlesRef: { current: null }, subjectsRef: { current: null }, readNativeLegacyClose, ...bindings };
  const readLegacySnapshot = Function('env', stripSourceTypes(`with (env) { return () => readNativeLegacyClose(${expression}); }`, {loader: 'ts'}))(env);
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(), readScope: () => 'fixture', readLegacySnapshot });
  return event => admission.beforeUnload(event);
}
