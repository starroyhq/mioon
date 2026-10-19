import assert from 'node:assert/strict';
import { readNativeLegacyClose } from '../../apps/web/src/native-close-legacy.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../../apps/web/src/native-close-state.ts';
import { createSettingsNavigationRegistry } from '../../apps/web/src/settings-navigation-state.ts';
import { stripSourceTypes } from '../helpers/eval-source.ts';

/** Existing draft regressions execute the actual App predicate through the real
 * new close controller. No business controller or dirty assertion is replaced. */
export interface AppCloseBindings {readonly shotCloseRef?: unknown; readonly subtitlesRef?: unknown; readonly subjectsRef?: unknown; readonly [key: string]: unknown}
export interface AppCloseEvent {preventDefault(): void; returnValue?: unknown}
export function actualAppCloseWarning(app: string, bindings: AppCloseBindings) {
  const expression = app.match(/readLegacySnapshot: \(\) => readNativeLegacyClose\((\{[\s\S]*?\})\),/)?.[1];
  assert.ok(expression, 'App must bind the exact pure legacy close snapshot');
  assert.match(app, /useEffect\(\(\) => installNativeCloseAdmission\(window/);
  const env = { shotCloseRef: { current: null }, subtitlesRef: { current: null }, subjectsRef: { current: null }, readNativeLegacyClose, ...bindings };
  const readLegacySnapshot = Function('env', stripSourceTypes(`with (env) { return () => readNativeLegacyClose(${expression}); }`, {loader: 'ts'}))(env);
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(), readScope: () => 'fixture', readLegacySnapshot });
  return (event: AppCloseEvent): unknown => admission.beforeUnload(event as never);
}
