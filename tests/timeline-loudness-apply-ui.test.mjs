import * as i18n from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as stateModule from '../apps/web/src/timeline-loudness-apply-state.ts';
import * as floatModule from '@mioon/contracts/timeline-export-float';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS } from '@mioon/contracts';
import { createExportSettingsController, exportSettingsKey, freezeExportSettings } from '../apps/web/src/export-settings-state.js';
import { fixture, context, draft, report, input } from './helpers/timeline-mix-loudness-ui-fixture.mjs';
const source = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children)] : [];
const byTest = (tree, id) => flatten(tree).find(value => value.props?.['data-testid'] === id);
function moduleFor(name, extra = {}) {
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} };
  Function('module','exports','require',transformSync(source(name), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module,module.exports,
    name => name === './i18n/I18nProvider.tsx' ? i18n.i18nTestModule() : name === '../../../packages/i18n/src/index.ts' ? i18n : name === 'react' ? react : name === '@mioon/ui/components/button' ? { Button: 'Button' } : name === '@mioon/ui/components/label' ? { Label: 'Label' } :
      name === '@mioon/contracts/timeline-export-float' ? floatModule : extra[name] ?? stateModule);
  return module.exports;
}
const initial = observation => ({ phase: 'idle', version: 0, scope: null, projectId: null, requestId: null, observationVersion: null, error: '' });
test('actual apply component only offers an explicit review for passing changed candidates; never applies on render', async () => {
  const Component = moduleFor('TimelineLoudnessApply.tsx').default, f = fixture(); f.edit(); await f.ready();
  const observation = f.state(), reviews = [], tasks = [], apply = { state: initial(observation), controller: { review: value => reviews.push(value) } };
  const tree = Component({ apply, observation, onOpenTasks: () => tasks.push(true) }); assert.equal(reviews.length, 0);
  const button = byTest(tree, 'timeline-loudness-apply-review'); assert.equal(button.props.disabled, false); button.props.onClick(); assert.equal(reviews[0], observation);
  const text = JSON.stringify(tree); assert.match(text, /不是默认 v1 导出结果/); assert.match(text, /不会自动选择 v2/); assert.match(text, /不保证输出响度或 AAC 真峰值/);
  for (const patch of [{ restored: true }, { visible: false }, { projectId: null }]) assert.equal(Component({ apply, observation: { ...observation, ...patch }, onOpenTasks() {} }), null);
  for (const value of [{ ...observation, hasUnsavedDrafts: true }, { ...observation, report: report(input({ integratedLufs: -14, truePeakCeilingDbtp: -1 })) }])
    assert.equal(byTest(Component({ apply, observation: value, onOpenTasks() {} }), 'timeline-loudness-apply-review').props.disabled, true);
});
test('unknown UI preserves task action and cannot create another apply; stale report requires a fresh preparation', async () => {
  const Component = moduleFor('TimelineLoudnessApply.tsx').default, f = fixture(); f.edit(); await f.ready();
  const observation = f.state(), state = { ...initial(), scope: observation.scope, projectId: observation.projectId, observationVersion: observation.version, requestId: 'original-task-key' };
  let opened = 0; const render = phase => Component({ apply: { state: { ...state, phase }, controller: { review() { assert.fail('No auto apply'); } } }, observation, onOpenTasks: () => opened++ });
  const unknown = render('unknown'); assert.equal(byTest(unknown,'timeline-loudness-apply-review').props.disabled,true);
  assert.match(JSON.stringify(unknown), /原请求保留在任务中心/); byTest(unknown,'timeline-loudness-apply-tasks').props.onClick(); assert.equal(opened,1);
  assert.equal(byTest(render('error'),'timeline-loudness-apply-review').props.disabled,true);
  assert.equal(byTest(render('applied'),'timeline-loudness-apply-review').props.disabled,true);
});
test('explicit export profile selector retains omitted legacy and default-v1 shapes, never selects v2 after apply', () => {
  const { default: Component, chooseTimelineExportProfile } = moduleFor('TimelineExportProfile.tsx');
  const before = JSON.stringify(TIMELINE_EXPORT_DEFAULT_SETTINGS), choices = [];
  const tree = Component({ value: TIMELINE_EXPORT_DEFAULT_SETTINGS, disabled: false, onChange: value => choices.push(value), Select: 'Select' });
  assert.equal(choices.length, 0); const selector = byTest(tree,'export-audio-profile'); assert.equal(selector.props.value,'mp4_h264_v1');
  selector.props.onChange({ target: { value: floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID } });
  assert.equal(choices[0].profileId,'mp4_h264_float_checked_v2'); assert.equal(JSON.stringify(TIMELINE_EXPORT_DEFAULT_SETTINGS),before);
  assert.equal(freezeExportSettings(undefined),undefined); assert.equal(exportSettingsKey(undefined),'legacy');
  const next = chooseTimelineExportProfile(choices[0],'mp4_h264_v1'); assert.deepEqual(next,TIMELINE_EXPORT_DEFAULT_SETTINGS);
  assert.equal(chooseTimelineExportProfile(next,'automatic'),null);
  const disabled = Component({ value: next, disabled: true, onChange() { assert.fail('Disabled profile cannot change'); }, Select: 'Select' });
  byTest(disabled,'export-audio-profile').props.onChange({ target: { value: floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID } });
  const controller = createExportSettingsController(); controller.setContext({ scope:'project:1', enabled:true });
  const captured = controller.getState(); assert.equal(controller.choose(choices[0],captured.scope,captured.version),true);
  assert.equal(controller.getSettings('project:1').profileId,floatModule.TIMELINE_EXPORT_FLOAT_PROFILE_ID);
  controller.setContext({scope:'project:2',enabled:true});assert.deepEqual(controller.getSettings('project:2'),TIMELINE_EXPORT_DEFAULT_SETTINGS);
  assert.match(source('TimelineExportSettings.jsx'), /<TimelineExportProfile value=\{value\} disabled=\{disabled\} onChange=\{onChange\} Select=\{WorkbenchSelect\}/);
});
function hookHarness() {
  const refs=[], effects=[], pending=[]; let cursor=0;
  const react={useRef(value){const index=cursor++;return refs[index]??={current:value};},
    useState(value){const index=cursor++;refs[index]??={value};return[refs[index].value,next=>{refs[index].value=next;}];},
    useLayoutEffect(fn,deps){const index=cursor++,old=effects[index];if(!old||!deps||deps.some((value,i)=>value!==old.deps?.[i]))pending.push(()=>{old?.cleanup?.();effects[index]={deps,cleanup:fn()};});}};
  const module={exports:{}};
  Function('module','exports','require',transformSync(source('use-timeline-loudness-apply.ts'),{loader:'ts',format:'cjs'}).code)(module,module.exports,name=>name==='react'?react:stateModule);
  return{render(options){cursor=0;const view=module.exports.useTimelineLoudnessApply(options);while(pending.length)pending.shift()();return view;},dispose(){effects.forEach(item=>item?.cleanup?.());}};
}
test('actual apply hook revokes confirmation on hidden page, pagehide and window blur; remount never resumes it', async t => {
  const oldDocument=globalThis.document,oldWindow=globalThis.window,document=new EventTarget(),window=new EventTarget(); document.visibilityState='visible';globalThis.document=document;globalThis.window=window;
  t.after(()=>{globalThis.document=oldDocument;globalThis.window=oldWindow;});
  for(const event of ['visibilitychange','pagehide','blur']){
    const f=fixture();f.edit();await f.ready(); const h=hookHarness();let approve,called=0;
    const view=h.render({getObservation:()=>f.state(),createRequestId:()=> 'hook-original-key',confirm:()=>new Promise(resolve=>{approve=resolve;}),submit:async()=>{called++;return{status:'applied'};}});
    const pending=view.controller.review(f.state());
    // The shared browser crypto digest is asynchronous; wait for its confirmation boundary.
    while(!approve)await new Promise(resolve=>setImmediate(resolve));
    if(event==='visibilitychange'){document.visibilityState='hidden';document.dispatchEvent(new Event(event));}else window.dispatchEvent(new Event(event));
    approve(true);await pending;assert.equal(called,0);document.visibilityState='visible';h.dispose();
  }
});

test('unverified recovery identity displays an actionable explanation without a pending-task action', async () => {
  const Component = moduleFor('TimelineLoudnessApply.tsx').default, f = fixture(); f.edit(); await f.ready();
  const controller = stateModule.createTimelineLoudnessApplyController({ getObservation: () => f.state(), getRecoveryScope: () => null,
    confirm: async () => assert.fail('Must not ask for approval without identity'), createRequestId: () => assert.fail('Must not mint an unrecoverable key'), submit: async () => assert.fail('Must not submit') });
  await controller.review(f.state());
  const tree = Component({ apply: { state: controller.getState(), controller }, observation: f.state(), onOpenTasks() {} });
  assert.match(JSON.stringify(tree), /工作区身份尚未核验.*重新连接或重新载入.*重新准备/);
  assert.equal(byTest(tree, 'timeline-loudness-apply-review').props.disabled, true);
  assert.equal(byTest(tree, 'timeline-loudness-apply-tasks'), undefined);
});
