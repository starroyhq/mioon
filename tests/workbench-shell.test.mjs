import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');

test('task reveal uses a separate overlay and keeps project, view and composition admission', () => {
  const body = app.slice(app.indexOf('  function openTasks('), app.indexOf('  function inspectTaskJob('));
  const calls = [];
  let composition = false;
  const currentProject = { current: 'project-a' }, viewReady = { current: true };
  const open = Function('clipDraftRef', 'currentProject', 'viewReady', 'markPanelIntent', 'setShowDelivery', 'setShowImage', 'setShowTasks', `${body}; return openTasks;`)(
    { current: { hasPendingComposition: () => composition } }, currentProject, viewReady,
    () => calls.push('intent'), value => calls.push(['delivery', value]), value => calls.push(['image', value]), value => calls.push(['tasks', value]),
  );
  assert.equal(open(() => false), false); assert.deepEqual(calls, []);
  composition = true; assert.equal(open(), false); assert.deepEqual(calls, []);
  composition = false; viewReady.current = false; assert.equal(open(), false); assert.deepEqual(calls, []);
  viewReady.current = true; currentProject.current = ''; assert.equal(open(), false); assert.deepEqual(calls, []);
  currentProject.current = 'project-b'; assert.equal(open(), true);
  assert.deepEqual(calls, ['intent', ['delivery', false], ['image', false], ['tasks', true]]);
  assert.doesNotMatch(body, /setRightDockTab|setPanelOpen/);
});

test('export opening is passive and closing its retained overlay does not cancel or resubmit', () => {
  const body = app.slice(app.indexOf('  function openTimelineExport('), app.indexOf('  const historyState'));
  const calls = [];
  const open = Function('clipDraftRef', 'markPanelIntent', 'setShowTasks', 'setShowImage', 'setShowExports', 'setShowDelivery', 'exportPreflight', `${body}; return openTimelineExport;`)(
    { current: { hasPendingComposition: () => false } }, () => calls.push('intent'), value => calls.push(['tasks', value]),
    value => calls.push(['image', value]), value => calls.push(['history', value]), value => calls.push(['delivery', value]),
    { controller: { setVisible: value => calls.push(['visible', value]) } },
  );
  open();
  assert.deepEqual(calls, ['intent', ['tasks', false], ['image', false], ['history', false], ['delivery', true], ['visible', true]]);
  assert.doesNotMatch(body, /\.check\(|renderTimeline\(|rpc\(/);
  const dialog = app.slice(app.indexOf('<Dialog open={showDelivery}'), app.indexOf('<Dialog open={showTasks}'));
  assert.match(dialog, /keepMounted hidden=\{!showDelivery\} inert=\{!showDelivery\}/);
  assert.match(dialog, /setShowDelivery\(false\); exportPreviewPause\.current\?\.\(\)/);
  assert.doesNotMatch(dialog.slice(0, dialog.indexOf('<WorkbenchDialogContent')), /cancel|rpc|renderTimeline/i);
  assert.doesNotMatch(app, /rightDockTab === '(?:delivery|tasks|image)'/);
});

test('project view and help keep the moved function entrances and the inspector owns only mode tabs', () => {
  assert.match(app, /DropdownMenuSubTrigger data-testid="panels-menu"/);
  assert.match(app, /redesign\.shell\.view/);
  assert.doesNotMatch(app, /<PanelsMenu|t\('shell\.actions'\)|t\('shell\.panel\.menu'\)/);
  for (const marker of ['project-switcher', 'menu-panel-assets', 'menu-panel-inspector', 'menu-panel-timeline', 'menu-panel-storyboard', 'reset-panel-layout', 'export-button', 'region-guide-toggle', 'agent-settings-open', 'jobs-button', 'global-settings-open', 'export-timeline', 'right-dock-tab-image']) assert.ok((app + readFileSync(new URL('../apps/web/src/CanvasToolbar.tsx',import.meta.url),'utf8') + readFileSync(new URL('../apps/web/src/TaskPopover.tsx',import.meta.url),'utf8')).includes(`data-testid="${marker}"`), marker);
  const shell = readFileSync(new URL('../apps/web/src/WorkbenchShell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /mode === 'canvas' && <TabsTrigger[^>]*value="versions"/);
  assert.doesNotMatch(shell, /value="(?:tasks|image|delivery)"/);
  assert.match(app, /<WorkbenchTopbar/); assert.match(app, /<WorkbenchInspectorTabs/);
  assert.match(app, /<CollapsibleContent keepMounted className="inspector-region-content"/);
});


test('retained closed confirmations do not raise ordinary settings or export backdrops above their popup',()=>{
 const css=readFileSync(new URL('../apps/web/src/styles.css',import.meta.url),'utf8');
 assert.match(css,/body:has\(\.workbench-confirm\[data-open\]\) \[data-slot="dialog-overlay"\]\{z-index:110\}/);
 assert.doesNotMatch(css,/body:has\(\.workbench-confirm\) \[data-slot="dialog-overlay"\]/);
});


test('zoomed full-window surfaces and modal bounds share the inverse logical viewport',()=>{
 const css=readFileSync(new URL('../apps/web/src/viewport-scale.css',import.meta.url),'utf8');
 assert.match(css,/--mioon-viewport-height: calc\(100dvh \/ var\(--mioon-ui-scale\)\)/);
 assert.match(css,/\.workbench, \.project-home-page, \.project-home-page > \.project-home, \.project-home-settings-window, \.boot-page \{ height: var\(--mioon-viewport-height\)/);
 assert.doesNotMatch(css,/\.workbench, \.project-home,/,'Embedded project pickers must use their dialog height');
 assert.match(css,/\[data-slot="dialog-content"\] \{ z-index: 90/);
 assert.match(css,/\.web-settings-dialog\.project-home \{[^}]*var\(--mioon-viewport-width\)[^}]*var\(--mioon-viewport-height\)/);
});
