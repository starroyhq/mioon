import type {HookCell} from './helpers/strict-timeline-ui-types.ts';
import type {TimelineMixLoudnessInput} from '../packages/contracts/src/timeline-mix-loudness.ts';
import type {TimelineMixLoudnessReadOptions} from '../apps/web/src/timeline-mix-loudness-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-mix-loudness-state.ts';
import { context, draft, report, deferred, type MixInput } from './helpers/timeline-mix-loudness-ui-fixture.ts';

function hookHarness() {
  const refs: HookCell[] = [], effects: HookCell[] = [], pending: (() => void)[] = []; let cursor = 0;
  const react = {
    useRef(value?: unknown) { const index = cursor++; return refs[index] ??= { current: value }; },
    useState(value?: unknown) { const index = cursor++; refs[index] ??= { value }; return [refs[index].value, (next?: unknown) => { refs[index].value = next; }]; },
    useLayoutEffect(fn: () => void | (()=>void), deps: unknown[]) { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((item, i) => item !== old.deps?.[i])) pending.push(((() => { old?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; }) as unknown as Parameters<typeof pending.push>[0])); },
  };
  const module = { exports: {} as typeof import('../apps/web/src/use-timeline-mix-loudness.ts') }, source = readFileSync(new URL('../apps/web/src/use-timeline-mix-loudness.ts', import.meta.url), 'utf8');
  Function('module','exports','require',transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module,module.exports, (name: string) => name === 'react' ? react : stateModule);
  return { render(options: { context: { scope: string; executionScope: string; projectId: string; timelineId: string; revision: number; durationFrames: number; sourceIdentity: string; connected: boolean; visible: boolean; restored: boolean; hasUnsavedDrafts: boolean; pending: boolean; }; getContext: () => { scope: string; executionScope: string; projectId: string; timelineId: string; revision: number; durationFrames: number; sourceIdentity: string; connected: boolean; visible: boolean; restored: boolean; hasUnsavedDrafts: boolean; pending: boolean; }; read: (input?: unknown,options?: unknown) => Promise<unknown>; }) { cursor = 0; const view = module.exports.useTimelineMixLoudness(options); while (pending.length) (pending.shift())!(); return view; },
    dispose() { effects.forEach(item => item?.cleanup?.()); } };
}
test('actual hook installs visibility/pagehide fences, never auto-reads and removes ownership on disposal', async t => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window, document = new EventTarget() as EventTarget & {visibilityState: string}, window = new EventTarget();
  document.visibilityState = 'visible'; globalThis.document = document as unknown as Document; globalThis.window = window as unknown as typeof globalThis.window;
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  let live = context(); const calls: ({ input: TimelineMixLoudnessInput; options: TimelineMixLoudnessReadOptions; })[] = [], waits: ReturnType<typeof deferred>[] = [], h = hookHarness();
  const options = () => ({ context: live, getContext: () => live, read(input: TimelineMixLoudnessInput, options: TimelineMixLoudnessReadOptions) { const wait = deferred(); waits.push(wait); calls.push({ input, options }); return wait.promise; } });
  const view = h.render(((options()) as unknown as Parameters<NonNullable<(typeof h)["render"]>>[0])), owned = view.controller; h.render(((options()) as unknown as Parameters<NonNullable<(typeof h)["render"]>>[0])); assert.equal(calls.length, 0);
  owned.setDraft(draft, owned.getState()); const pending = owned.prepare(owned.getState());
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls[0].options.signal.aborted, true); waits[0].resolve(report(((calls[0].input) as unknown as Parameters<typeof report>[0]))); await pending; assert.equal((owned.getState().report as unknown), null);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); h.render(((options()) as unknown as Parameters<NonNullable<(typeof h)["render"]>>[0])); assert.equal(calls.length, 1);
  const next = owned.prepare(owned.getState()); waits[1].resolve(report(((calls[1].input) as unknown as Parameters<typeof report>[0]))); await next; assert.equal(owned.getState().phase, 'ready');
  window.dispatchEvent(new Event('pagehide')); assert.equal((owned.getState().report as unknown), null); assert.equal(calls.length, 2);
  live = { ...live, revision: 5 }; const masked = h.render(((options()) as unknown as Parameters<NonNullable<(typeof h)["render"]>>[0])); assert.equal((masked.state.report as unknown), null);
  const third = owned.prepare(owned.getState()); h.dispose(); assert.equal(calls[2].options.signal.aborted, true);
  waits[2].resolve(report(((calls[2].input) as unknown as Parameters<typeof report>[0]), live)); await third; assert.equal((owned.getState().report as unknown), null);
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); assert.equal(owned.getState().visible, false); assert.equal(calls.length, 3);
});
