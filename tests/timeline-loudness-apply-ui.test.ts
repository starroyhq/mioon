import * as i18n from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-loudness-apply-state.ts';
import * as floatModule from '@mioon/contracts/timeline-export-float';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS } from '@mioon/contracts';
import { createExportSettingsController, exportSettingsKey, freezeExportSettings } from '../apps/web/src/export-settings-state.ts';
import { fixture, context, draft, report, input } from './helpers/timeline-mix-loudness-ui-fixture.ts';
interface TreeNode {type?: unknown; props?: Record<string, unknown> & {children?: unknown; 'data-testid'?: string}; children?: unknown; [key: string]: unknown}
interface HookRef {current?: unknown; value?: unknown; cleanup?: (() => void) | void; deps?: unknown[]}
const source = (name: string): string => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const flatten = (value: unknown): TreeNode[] => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value as TreeNode, ...flatten((value as TreeNode).props?.children)] : [];
const byTest = (tree: unknown, id: string): TreeNode | undefined => flatten(tree).find((value: TreeNode) => value.props?.['data-testid'] === id);
function moduleFor(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const react: Record<string, unknown> & {default?: unknown} = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): TreeNode => ({ type, props: { ...props, children } }) }; react.default = react;
  const module: {exports: Record<string, unknown>} = { exports: {} };
  Function('module','exports','require',transformSync(source(name), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module,module.exports,
    (name: string) => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? react : name === '@mioon/ui/components/button' ? { Button: 'Button' } : name === '@mioon/ui/components/label' ? { Label: 'Label' } :
      name === '@mioon/contracts/timeline-export-float' ? floatModule : (extra[name] ?? stateModule));
  return module.exports;
}
const initial = (_observation: unknown): Record<string, unknown> => ({ phase: 'idle', version: 0, scope: null, projectId: null, requestId: null, observationVersion: null, error: '' });
test('actual apply component only offers an explicit review for passing changed candidates; never applies on render', async () => {
  const Component = (moduleFor('TimelineLoudnessApply.tsx') as {default: (props: Record<string, unknown>) => TreeNode | null}).default, f = fixture(); f.edit(); await f.ready(undefined);
  const observation = f.state(), reviews: unknown[] = [], tasks: unknown[] = [], apply = { state: initial(observation), controller: { review: (value: unknown) => { reviews.push(value); } } };
  const tree = Component({ apply, observation, onOpenTasks: () => { tasks.push(true); } }); assert.equal(reviews.length, 0);
  const button = byTest(tree, 'timeline-loudness-apply-review'); assert.ok(button?.props); assert.equal(button.props.disabled, false); (button.props.onClick as () => void)(); assert.equal(reviews[0], observation);
  const text = JSON.stringify(tree); assert.match(text, /不是默认 v1 导出结果/); assert.match(text, /不会自动选择 v2/); assert.match(text, /不保证输出响度或 AAC 真峰值/);
  for (const patch of [{ restored: true }, { visible: false }, { projectId: null }]) assert.equal(Component({ apply, observation: { ...observation, ...patch }, onOpenTasks() {} }), null);
  for (const value of [{ ...observation, hasUnsavedDrafts: true }, { ...observation, report: report(input({ integratedLufs: -14, truePeakCeilingDbtp: -1 })) }]) {
    const disabledButton = byTest(Component({ apply, observation: value, onOpenTasks() {} }), 'timeline-loudness-apply-review'); assert.ok(disabledButton?.props); assert.equal(disabledButton.props.disabled, true);
  }
});
test('unknown UI preserves task action and cannot create another apply; stale report requires a fresh preparation', async () => {
  const Component = (moduleFor('TimelineLoudnessApply.tsx') as {default: (props: Record<string, unknown>) => TreeNode | null}).default, f = fixture(); f.edit(); await f.ready(undefined);
  const observation = f.state(), state = { ...initial(observation), scope: observation.scope, projectId: observation.projectId, observationVersion: observation.version, requestId: 'original-task-key' };
  let opened = 0; const render = (phase: string) => Component({ apply: { state: { ...state, phase }, controller: { review() { assert.fail('No auto apply'); } } }, observation, onOpenTasks: () => { opened++; } });
  const unknown = render('unknown'); const unknownButton = byTest(unknown,'timeline-loudness-apply-review'); assert.ok(unknownButton?.props); assert.equal(unknownButton.props.disabled,true);
  assert.match(JSON.stringify(unknown), /原请求保留在任务中心/); const tasksButton = byTest(unknown,'timeline-loudness-apply-tasks'); assert.ok(tasksButton?.props); (tasksButton.props.onClick as () => void)(); assert.equal(opened,1);
  const errorButton = byTest(render('error'),'timeline-loudness-apply-review'); assert.ok(errorButton?.props); assert.equal(errorButton.props.disabled,true);
  const appliedButton = byTest(render('applied'),'timeline-loudness-apply-review'); assert.ok(appliedButton?.props); assert.equal(appliedButton.props.disabled,true);
});
test('explicit export profile selector retains omitted legacy and default-v1 shapes, never selects v2 after apply', () => {
  const profileModule = moduleFor('TimelineExportProfile.tsx') as {default: (props: Record<string, unknown>) => TreeNode; chooseTimelineExportProfile: (value: unknown, profileId: string) => unknown};
  const Component = profileModule.default, chooseTimelineExportProfile = profileModule.chooseTimelineExportProfile;
  const before = JSON.stringify(TIMELINE_EXPORT_DEFAULT_SETTINGS), choices: unknown[] = [];
  const tree = Component({ value: TIMELINE_EXPORT_DEFAULT_SETTINGS, disabled: false, onChange: (value: unknown) => { choices.push(value); }, Select: 'Select' });
  assert.equal(choices.length, 0); const selector = byTest(tree,'export-audio-profile'); assert.ok(selector?.props); assert.equal(selector.props.value,'mp4_h264_v1');
  (selector.props.onChange as (event: {target: {value: string}}) => void)({ target: { value: floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID } });
  assert.equal((choices[0] as {profileId?: string}).profileId,'mp4_h264_float_checked_v2'); assert.equal(JSON.stringify(TIMELINE_EXPORT_DEFAULT_SETTINGS),before);
  assert.equal(freezeExportSettings(undefined),undefined); assert.equal(exportSettingsKey(undefined),'legacy');
  const next = chooseTimelineExportProfile(choices[0],'mp4_h264_v1') as Record<string, unknown>; assert.deepEqual(next,TIMELINE_EXPORT_DEFAULT_SETTINGS);
  assert.equal(chooseTimelineExportProfile(next,'automatic'),null);
  const disabled = Component({ value: next, disabled: true, onChange() { assert.fail('Disabled profile cannot change'); }, Select: 'Select' });
  const disabledSelector = byTest(disabled,'export-audio-profile'); assert.ok(disabledSelector?.props); (disabledSelector.props.onChange as (event: {target: {value: string}}) => void)({ target: { value: floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID } });
  const controller = createExportSettingsController(); controller.setContext({ scope:'project:1', enabled:true });
  const captured = controller.getState(); assert.equal(controller.choose(choices[0],captured.scope,captured.version),true);
  assert.equal(controller.getSettings('project:1').profileId,floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID);
  controller.setContext({scope:'project:2',enabled:true});assert.deepEqual(controller.getSettings('project:2'),TIMELINE_EXPORT_DEFAULT_SETTINGS);
  assert.match(source('TimelineExportSettings.tsx'), /<TimelineExportProfile value=\{value\} disabled=\{disabled\} onChange=\{onChange\} Select=\{WorkbenchSelect\}/);
});
interface HookView {controller: {review(observation: unknown): Promise<unknown>}; [key: string]: unknown}
function hookHarness(): {render(options: Record<string, unknown>): HookView; dispose(): void} {
  const refs: HookRef[]=[], effects: HookRef[]=[], pending: (() => void)[]=[]; let cursor=0;
  const react: Record<string, unknown>={useRef(value: unknown){const index=cursor++;refs[index]??={current:value};return refs[index];},
    useState(value: unknown){const index=cursor++;refs[index]??={value};return[refs[index]?.value,(next: unknown)=>{const item=refs[index];if(item)item.value=next;}];},
    useLayoutEffect(fn: () => (() => void) | void,deps?: unknown[]){const index=cursor++,old=effects[index];if(!old||!deps||deps.some((value,i)=>value!==old.deps?.[i]))pending.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:fn()};});}};
  const module: {exports: Record<string, unknown>}={exports:{}};
  Function('module','exports','require',transformSync(source('use-timeline-loudness-apply.ts'),{loader:'ts',format:'cjs'}).code)(module,module.exports,(name: string)=>name==='react'?react:stateModule);
  return{render(options: Record<string, unknown>){cursor=0;const view=(module.exports.useTimelineLoudnessApply as (value: unknown) => HookView)(options);while(pending.length)pending.shift()?.();return view;},dispose(){effects.forEach(item=>item?.cleanup?.());}};
}
test('actual apply hook revokes confirmation on hidden page, pagehide and window blur; remount never resumes it', async t => {
  type VisibleEventTarget = EventTarget & {visibilityState: string};
  const oldDocument=globalThis.document,oldWindow=globalThis.window,document=new EventTarget() as VisibleEventTarget,window=new EventTarget() as VisibleEventTarget; document.visibilityState='visible';(globalThis as unknown as {document: unknown}).document=document;(globalThis as unknown as {window: unknown}).window=window;
  t.after(()=>{(globalThis as unknown as {document: unknown}).document=oldDocument;(globalThis as unknown as {window: unknown}).window=oldWindow;});
  for(const event of ['visibilitychange','pagehide','blur']){
    const f=fixture();f.edit();await f.ready(undefined); const h=hookHarness();let approve: ((value: boolean) => void) | undefined,called=0;
    const view=h.render({getObservation:()=>f.state(),createRequestId:()=> 'hook-original-key',confirm:()=>new Promise<boolean>(resolve=>{approve=resolve;}),submit:async()=>{called++;return{status:'applied'};}});
    const pending=view.controller.review(f.state());
    // The shared browser crypto digest is asynchronous; wait for its confirmation boundary.
    while(!approve)await new Promise<void>(resolve=>{setImmediate(resolve);});
    if(event==='visibilitychange'){document.visibilityState='hidden';document.dispatchEvent(new Event(event));}else window.dispatchEvent(new Event(event));
    const approveFn=approve;assert.ok(approveFn);approveFn(true);await pending;assert.equal(called,0);document.visibilityState='visible';h.dispose();
  }
});

test('unverified recovery identity displays an actionable explanation without a pending-task action', async () => {
  const Component = (moduleFor('TimelineLoudnessApply.tsx') as {default: (props: Record<string, unknown>) => TreeNode | null}).default, f = fixture(); f.edit(); await f.ready(undefined);
  const controller = stateModule.createTimelineLoudnessApplyController({ getObservation: () => f.state(), getRecoveryScope: () => null,
    confirm: async () => assert.fail('Must not ask for approval without identity'), createRequestId: () => assert.fail('Must not mint an unrecoverable key'), submit: async () => assert.fail('Must not submit') } as never);
  await controller.review(f.state() as never);
  const tree = Component({ apply: { state: controller.getState(), controller }, observation: f.state(), onOpenTasks() {} });
  assert.match(JSON.stringify(tree), /工作区身份尚未核验.*重新连接或重新载入.*重新准备/);
  const reviewButton=byTest(tree, 'timeline-loudness-apply-review');assert.ok(reviewButton?.props);assert.equal(reviewButton.props.disabled, true);
  assert.equal(byTest(tree, 'timeline-loudness-apply-tasks'), undefined);
});
