import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-clip-loudness-state.ts';
import { context, report, deferred } from './helpers/timeline-clip-loudness-ui-fixture.ts';

interface HookSlot {current?: unknown; value?: unknown; cleanup?: () => void; deps?: readonly unknown[]}
interface HookState {report: unknown; phase?: string; visible?: boolean; [key: string]: unknown}
interface HookController {prepare(state: unknown): Promise<unknown>; getState(): HookState; dispose(): void}
interface HookView {controller: HookController; state: HookState}
interface Harness {render(options: unknown): HookView; dispose(): void}
interface Wait {promise: Promise<unknown>; resolve(value: unknown): void}
interface CallRecord {input: unknown; options: {signal: AbortSignal}}
function hookHarness(): Harness {
  const refs: HookSlot[] = [], effects: HookSlot[] = [], pending: Array<() => void> = []; let cursor = 0;
  const react = {
    useRef(value: unknown): HookSlot { const index = cursor++; return refs[index] ??= { current: value }; },
    useState(value: unknown): [unknown, (next: unknown) => void] { const index = cursor++; refs[index] ??= { value }; return [refs[index].value, (next: unknown) => { refs[index].value = next; }]; },
    useLayoutEffect(fn: () => (() => void) | void, deps?: readonly unknown[]): void { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((item, i) => item !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: fn() ?? undefined }; }); },
  };
  const module: {exports: Record<string, unknown>} = { exports: {} }, source = readFileSync(new URL('../apps/web/src/use-timeline-clip-loudness.ts', import.meta.url), 'utf8');
  Function('module','exports','require',transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module,module.exports,(name: string) => name === 'react' ? react : stateModule);
  const useHook = module.exports.useTimelineClipLoudness as (options: unknown) => HookView;
  return { render(options: unknown) { cursor = 0; const view = useHook(options); while (pending.length) pending.shift()?.(); return view; },
    dispose() { effects.forEach(item => item?.cleanup?.()); } };
}
test('actual hook installs visibility/pagehide fences, never auto-reads and removes ownership on disposal', async (t: TestContext) => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window, document = new EventTarget() as EventTarget & {visibilityState: string}, window = new EventTarget();
  document.visibilityState = 'visible'; globalThis.document = document as unknown as Document; globalThis.window = window as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  let live = context(); const calls: CallRecord[] = [], waits: Wait[] = [], h = hookHarness();
  const options = () => ({ context: live, getContext: () => live, read(input: unknown, request: {signal: AbortSignal}): Promise<unknown> { const wait = deferred() as unknown as Wait; waits.push(wait); calls.push({ input, options: request }); return wait.promise; } });
  const view = h.render(options()), owned = view.controller; h.render(options()); assert.equal(calls.length, 0);
  const pending = owned.prepare(owned.getState());
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls[0].options.signal.aborted, true); waits[0].resolve(report(calls[0].input as never)); await pending; assert.equal(owned.getState().report, null);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); h.render(options()); assert.equal(calls.length, 1);
  const next = owned.prepare(owned.getState()); waits[1].resolve(report(calls[1].input as never)); await next; assert.equal(owned.getState().phase, 'ready');
  window.dispatchEvent(new Event('pagehide')); assert.equal(owned.getState().report, null); assert.equal(calls.length, 2);
  live = { ...live, revision: 5 } as typeof live; const masked = h.render(options()); assert.equal(masked.state.report, null);
  const third = owned.prepare(owned.getState()); h.dispose(); assert.equal(calls[2].options.signal.aborted, true);
  waits[2].resolve(report(calls[2].input as never)); await third; assert.equal(owned.getState().report, null);
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); assert.equal(owned.getState().visible, false); assert.equal(calls.length, 3);
});
