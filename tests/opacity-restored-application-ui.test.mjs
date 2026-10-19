import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {transformSync} from 'esbuild';
import {i18nTestModule} from './helpers/i18n.ts';
import {DEFAULT_UI_PREFERENCES} from '../packages/contracts/src/ui-preferences.ts';
import * as geometry from '../apps/web/src/timeline-view-geometry.ts';
import {displayTimelineFrame} from '../apps/web/src/timeline-removal.ts';
import {WAVEFORM_LIMITS} from '../apps/web/src/waveform-state.js';
import {rulerFrameForKey} from '../apps/web/src/timeline-keyboard.js';
import {timelineDropPreview} from '../apps/web/src/timeline-snapping.js';
import {staleSourceSentence} from '../apps/web/src/timeline-source-freshness.ts';
import {randomUUID} from 'node:crypto';
import * as legacy from '@mioon/contracts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {reopenOpacityCandidateApplicationStore, reopenRestoredOpacityCandidateApplicationStore} from '../packages/business/src/opacity-candidate-store.ts';
import {createRestoredOpacityCandidateLocalDrafts} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.mjs';
import {opacityBackupFixture} from './helpers/opacity-backup-fixture.mjs';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../apps/web/src/opacity-candidate-application.ts';
import {createEditTaskClient} from '../apps/web/src/edit-task-client.js';
import {createEditTaskController} from '../apps/web/src/edit-task-controller.js';
import {rpc} from '../apps/web/src/api.js';
import {readOpacityCandidateInspectorBinding} from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import {createClipDraftController, clipDraftRaw, clipDraftSource} from '../apps/web/src/clip-draft-state.ts';
import {rawOpacityEnvelopeFields} from '../apps/web/src/clip-opacity-envelope-state.ts';
import {pinNewWorkspaceIntent} from '../apps/web/src/workspace-origin.js';
import {LOCALES, translate, validateCatalogs} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const runtime = {...legacy, rpc, createEditTaskClient};
const response = data => new Response(JSON.stringify({ok: true, data}), {status: 200, headers: {'Content-Type': 'application/json'}});

/** Actual cold42 backup and43 restoration, real services and durable task
 * coordinator. Only the HTTP transport is in-process; there is no listener,
 * browser, provider or media execution. */
async function fixture(t, {captureRender = false} = {}) {
  const f = await opacityBackupFixture(t);
  if (captureRender) {
    const source = reopenOpacityCandidateApplicationStore(f.source), service = createOpacityCandidateApplicationServices(source);
    try {
      // Omitted-settings render acceptance captures metadata only. No worker,
      // listener or decoder is constructed in this owned source42 fixture.
      f.captured = await service.call('timeline.render', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, purpose: 'preview'});
    } finally {await service.drain();source.close();}
  }
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  f.restoration = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  const store = reopenRestoredOpacityCandidateApplicationStore(f.destination);f.stores.push(store);
  const services = createOpacityCandidateApplicationServices(store), tasks = createEditTasks({store, services});
  f.manage(async () => {await tasks.drain(); await services.drain();});
  const drafts = createRestoredOpacityCandidateLocalDrafts(store);
  const requests = [];
  const fetcher = async (url, options = {}) => {
    const address = new URL(url, 'http://in-process.invalid'), body = options.body ? JSON.parse(options.body) : {};
    requests.push({path: address.pathname, body: structuredClone(body)});
    try {
      let data;
      const context = body.expectedWorkspaceOrigin ? {expectedWorkspaceOrigin: body.expectedWorkspaceOrigin} : {};
      if (address.pathname === '/api/local-drafts/restored43/clip') data = options.method === 'PUT' ? drafts.put(body) : options.method === 'DELETE' ? drafts.discard(body) : drafts.get({...Object.fromEntries(address.searchParams), schemaVersion: 1});
      else if (address.pathname === '/api/rpc') data = await services.call(body.operation, body.input, context);
      else if (address.pathname === '/api/tasks') data = tasks.list({projectId: address.searchParams.get('projectId'), limit: Number(address.searchParams.get('limit')), pendingOnly: address.searchParams.get('pendingOnly') !== 'false', ...(address.searchParams.has('cursor') ? {cursor: address.searchParams.get('cursor')} : {})});
      else if (address.pathname === '/api/tasks/prepare') {const {expectedWorkspaceOrigin, ...input} = body;data = tasks.prepare(input, context);}
      else {
        const parts = address.pathname.split('/'), taskId = parts[3], action = parts[4];
        const {expectedWorkspaceOrigin, ...input} = body;
        data = action ? await tasks[action]({...input, taskId}, context) : tasks.get({projectId: address.searchParams.get('projectId'), taskId});
      }
      return response(data);
    } catch (error) {return new Response(JSON.stringify({ok: false, error: {code: error.code, message: error.message, details: error.details}}), {status: error.status || 409});}
  };
  const token = createOpacityCandidateApplication(runtime, fetcher), application = readOpacityCandidateApplication(token);
  const workspace = await application.rpc('workspace.restore.inspect');
  return {...f, store, services, tasks, requests, fetcher, token, application, workspace};
}

test('candidate RPC opens a real restored43 project and preserves strict scope and held export disclosure', async t => {
  const f = await fixture(t, {captureRender: true}), {application, workspace} = f;
  assert.equal(workspace.schemaVersion, 43);assert.equal(workspace.draftPolicy, 'excluded');
  assert.equal(workspace.workspaceOrigin, f.restoration.workspaceOrigin);
  assert.equal(application.isRestoredWorkspace(workspace), true);
  const project = await application.rpc('project.get', {projectId: f.projectId});
  assert.equal(application.validateProjectSnapshot(project, f.projectId), true);
  assert.deepEqual(project.timeline.clips[0].opacityEnvelope, f.opacityEnvelope);
  assert.deepEqual(project.restore, {workspaceOrigin: workspace.workspaceOrigin, heldExportIds: [f.captured.id]});
  assert.deepEqual(project.exports, [f.captured]);
  for (const mutate of [
    value => {value.restore.workspaceOrigin = randomUUID();}, value => {delete value.restore;},
    value => {value.restore.heldExportIds = [randomUUID()];}, value => {value.restore.heldExportIds.push(f.captured.id);}, value => {value.restore.extra = true;},
    value => {value.project.id = randomUUID();},
  ]) {const bad = structuredClone(project);mutate(bad);assert.equal(application.validateProjectSnapshot(bad, f.projectId), false);}
  const fresh = readOpacityCandidateApplication(createOpacityCandidateApplication(runtime, async (_url, options) => {
    const {operation} = JSON.parse(options.body);return response(operation === 'workspace.restore.inspect' ? {restored: false} : project);
  }));
  await fresh.rpc('workspace.restore.inspect');
  await assert.rejects(fresh.rpc('project.get', {projectId: f.projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  const stripped = structuredClone(project);delete stripped.restore;
  assert.equal(fresh.validateProjectSnapshot(stripped, f.projectId), true);
});

test('only the exact candidate client binding accepts43; legacy API, copied binding and forged capability responses reject', async t => {
  const f = await fixture(t), fetcher = async () => response(f.workspace);
  await assert.rejects(rpc('workspace.restore.inspect', {}, {fetcher}), {code: 'BACKEND_PROTOCOL_ERROR'});
  await assert.rejects(rpc('workspace.restore.inspect', {}, {fetcher, opacityBinding: {kind: 'internal-opacity-client'}}), {code: 'BACKEND_PROTOCOL_ERROR'});
  for (const mutate of [
    value => {value.schemaVersion = 41;}, value => {value.source.schemaVersion = 40;},
    value => {value.audioRoleCapability = {editable: true};}, value => {value.volumeEnvelopeCapability = {editable: true};},
    value => {value.operationPolicy.find(item => item.operation === 'asset.import').available = true;},
    value => {value.draftPolicy = 'restored';},
  ]) {
    const bad = structuredClone(f.workspace);mutate(bad);
    const application = readOpacityCandidateApplication(createOpacityCandidateApplication(runtime, async () => response(bad)));
    await assert.rejects(application.rpc('workspace.restore.inspect'), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  const changed = structuredClone(f.workspace);changed.workspaceOrigin = randomUUID();
  let calls = 0;
  const application = readOpacityCandidateApplication(createOpacityCandidateApplication(runtime, async () => response(calls++ ? changed : f.workspace)));
  await application.rpc('workspace.restore.inspect');
  await assert.rejects(application.rpc('workspace.restore.inspect'), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('real restored application binding and clip controller persist new-origin drafts, save/cancel, undo/redo and refuse captured pending without v3 traffic', async t => {
  const f = await fixture(t), {application, workspace} = f;
  const taskController = createEditTaskController({client: application.taskClient, getWorkspace: () => workspace});
  const loaded = await taskController.load(f.projectId);
  assert.equal(loaded.phase, 'ready');assert.deepEqual(loaded.heldIds, [f.taskId]);assert.equal(taskController.blocked(f.projectId), false);
  const beforeReject = f.requests.length;
  await assert.rejects(taskController.recover(loaded.items.find(item => item.id === f.taskId)), {code: 'RESTORED_RECORD_HELD'});
  assert.equal(f.requests.length, beforeReject, 'captured recovery is rejected before transport');
  let timeline = (await application.rpc('project.get', {projectId: f.projectId})).timeline;
  const asset = f.store.get('assets', f.assetId), clip = () => timeline.clips[0];
  const context = () => ({scope: `${workspace.workspaceOrigin}:${f.projectId}:inspector`, projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId,
    restored: true, workspaceOrigin: workspace.workspaceOrigin, connected: true, visible: true, busy: false, opacityEnvelopeEditable: true,
    timelineRevision: timeline.revision, source: clipDraftSource(clip(), asset), saved: {...clipDraftRaw(clip()), ...rawOpacityEnvelopeFields(clip())}});
  const controller = createClipDraftController({context: context(), client: readOpacityCandidateInspectorBinding(application.inspectorBinding).client,
    validateTimeline: (value, projectId) => application.isTimelineRecord(value, {projectId})});
  t.after(() => controller.dispose());await controller.load();assert.equal(controller.getState().phase, 'ready');assert.equal(controller.supportsRestoredPersistence(workspace.workspaceOrigin), true);
  const input = {profileId: f.opacityEnvelope.profileId, points: [{frame: '0', opacity: '.6'}, {frame: '30', opacity: '1'}]};
  controller.editOpacityEnvelope(input, controller.capture());assert.equal(controller.hasUnsaved(), true);
  await controller.discard(controller.capture());assert.equal(controller.hasUnsaved(), false);
  assert.deepEqual(f.store.get('timelines', f.timelineId).clips[0].opacityEnvelope, f.opacityEnvelope);
  controller.editOpacityEnvelope(input, controller.capture());
  const submit = async (operation, extra = {}, options = {}) => {
    const body = {projectId: f.projectId, requestId: randomUUID(), expectedRevision: timeline.revision, ...extra};
    const result = await taskController.submit(pinNewWorkspaceIntent({projectId: f.projectId, operation, input: body}, workspace), options);
    assert.equal(result.task.status, 'applied');await taskController.acknowledge(result.task);return result.result;
  };
  const saved = await controller.save(async (clipId, patch, revision, options) => {
    assert.equal(revision, timeline.revision);return submit('timeline.clip.update', {clipId, patch}, options);
  });
  assert.ok(saved);timeline = saved;controller.setContext(context());assert.equal(controller.hasUnsaved(), false);
  assert.equal(clip().opacityEnvelope.points[0].opacity, .6);
  timeline = await submit('timeline.undo');assert.deepEqual(clip().opacityEnvelope, f.opacityEnvelope);
  timeline = await submit('timeline.redo');assert.equal(clip().opacityEnvelope.points[0].opacity, .6);
  assert.deepEqual({...f.store.db.prepare('SELECT status,acknowledged,executionEpoch FROM edit_tasks WHERE id=?').get(f.taskId)}, {status: 'prepared', acknowledged: 0, executionEpoch: 'captured'});
  const epochs = f.store.db.prepare('SELECT DISTINCT executionEpoch FROM edit_tasks WHERE id<>?').all(f.taskId);
  assert.deepEqual(epochs.map(row => row.executionEpoch), [workspace.workspaceOrigin]);
  assert.equal(f.requests.some(item => /delivery/u.test(item.path)), false);
  assert.ok(f.requests.some(item => item.path === '/api/local-drafts/restored43/clip'));
  assert.equal(f.requests.some(item => item.path === '/api/local-drafts/clip'), false);
  assert.equal(existsSync(path.join(f.destination, 'local-drafts-v3.json')), false);
  assert.deepEqual(readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
});

test('actual App view updates remain in memory for43 and continue using the existing preference controller for42', async t => {
  const f = await fixture(t), start = appSource.indexOf('  const updateView = useCallback('), end = appSource.indexOf('  const field =', start);
  const use = Function('env', `with(env) {${appSource.slice(start, end)};return updateView;}`);
  for (const restored of [true, false]) {
    const writes = [], currentProject = {current: f.projectId}, previous = {activeMode: 'editing', editing: {selectedClipId: null}};
    const viewRef = {current: previous}, rendered = [];
    const update = use({useCallback: fn => fn, application: f.application, viewReady: {current: true}, dataRef: {current: {project: {id: f.projectId}}}, currentProject,
      viewRef, workspaceRef: {current: restored ? f.workspace : {restored: false}}, clipDraftRef: {current: null}, clipLoudnessEpoch: {current: 0},
      setView: value => rendered.push(value), preferencesRef: {current: {update: (...args) => writes.push(args)}}, pinNewWorkspaceIntent});
    update('editing', {selectedClipId: f.clipId});
    assert.equal(viewRef.current.editing.selectedClipId, f.clipId);assert.equal(rendered.length, 1);assert.equal(writes.length, restored ? 0 : 1);
  }
});

function renderComponents(f) {
  const data = {timeline: f.timeline, asset: f.store.get('assets', f.assetId), project: f.store.get('projects', f.projectId)};
  const fixture = `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server.browser';
    import AssetLibrary from './src/AssetLibrary.jsx';import Timeline from './src/Timeline.jsx';import Preview from './src/Preview.jsx';
    import TimelineInspector from './src/TimelineInspector.jsx';import ProjectHome from './src/ProjectHome.tsx';import OpacityRestoredNotice from './src/OpacityRestoredNotice.tsx';
    import {I18nProvider} from './src/i18n/I18nProvider.tsx';import {ConfirmationProvider} from '@mioon/ui/components/workbench-confirm';
    import {createOpacityCandidateApplication,readOpacityCandidateApplication} from './src/opacity-candidate-application.ts';
    import * as contracts from '@mioon/contracts';import {rpc} from './src/api.js';import {createEditTaskClient} from './src/edit-task-client.js';
    const f=${JSON.stringify(data)}, noop=()=>{}, token=createOpacityCandidateApplication({...contracts,rpc,createEditTaskClient},()=>{throw Error('SSR must never fetch');}), app=readOpacityCandidateApplication(token);
    const components={assets:<AssetLibrary mutationDisabled assets={[f.asset]} project={f.project} mode="editing" filter="all" search="" onFilter={noop} onSearch={noop} onPreview={noop} busy={{}}/>,
      timeline:<Timeline basicEditingOnly structureReadOnly sessionViewOnly waveformReadOnly timeline={f.timeline} assets={[f.asset]} playhead={0} historyState={{canUndo:true,canRedo:true}} onHistory={noop} onSeek={noop} onRender={noop} onCollapse={noop}/>,
      inspector:<TimelineInspector clip={f.timeline.clips[0]} timeline={f.timeline} asset={f.asset} draftContext={{restored:true}} onDirtyChange={noop} opacityCandidate={app.inspectorBinding}/>,
      preview:<Preview kind="source" visible timeline={{...f.timeline,clips:[]}} onSeek={noop} onRender={noop} opacityApplication={token}/>,
      home:<ProjectHome projects={[f.project]} phase="home" page="projects" onPage={noop} onOpen={noop} onRetry={noop} onRefresh={noop} onCreate={async()=>false} createDisabledReason="RESTORED_CREATE_DISABLED" status={<OpacityRestoredNotice/>}/>,notice:<OpacityRestoredNotice/>};
    export const html=Object.fromEntries(['zh-Hans','zh-Hant','en','ja'].map(locale=>{
      const state={locale,preference:locale,persistence:'session',saving:false,ready:true}, store={subscribe:()=>noop,getSnapshot:()=>state,connect:()=>noop,setPreference:async()=>{}};
      return [locale,Object.fromEntries(Object.entries(components).map(([name,component])=>[name,renderToStaticMarkup(<I18nProvider store={store}><ConfirmationProvider labels={{title:'Confirm',cancel:'Cancel',continue:'Continue'}}>{component}</ConfirmationProvider></I18nProvider>)]))];
    }));`;
  const script = `import {build} from 'esbuild';globalThis.fetch=()=>{throw Error('SSR must not fetch');};
    const {outputFiles}=await build({stdin:{contents:${JSON.stringify(fixture)},loader:'jsx',resolveDir:${JSON.stringify(path.join(root, 'apps/web'))}},bundle:true,format:'esm',platform:'browser',write:false,loader:{'.css':'empty'},jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
    const result=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64')).catch(error=>{process.stderr.write(error.stack.replace(/data:text\\/javascript;base64,[A-Za-z0-9+/=]+/g,'<bundle>'));process.exit(1);});
    await new Promise(resolve=>process.stdout.write(JSON.stringify(result.html),resolve));process.exit(0);`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {cwd: root, input: script, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024}));
}

test('real shared components show43 draft disclosure in four languages and remove unavailable mutation actions while keeping clip/history/preview controls', async t => {
  const f = await fixture(t), rendered = renderComponents(f);
  assert.deepEqual(validateCatalogs(), []);
  for (const locale of LOCALES) {
    const html = rendered[locale];
    assert.ok(html.notice.includes(translate(locale, 'opacity.restored.drafts')));assert.ok(html.home.includes('opacity-restored-notice'));
    assert.match(html.home, /data-testid="project-home-create-toggle"[^>]*disabled/);
    assert.match(html.assets, /data-testid="import-button"[^>]*disabled/);
    assert.match(html.assets, /data-testid="asset-card-[^"]+" draggable="false"/);
    assert.match(html.assets, /data-testid="asset-to-timeline-[^"]+"[^>]*disabled/);
    // Track/render actions now live in the real closed menu. Their actual
    // item disabled state and retained callbacks are exercised below.
    assert.doesNotMatch(html.timeline, /data-testid="add-(?:video|audio)-track"/);
    assert.match(html.timeline, /data-testid="timeline-clip-[^"]+"[^>]*draggable="true"/);
    assert.doesNotMatch(html.timeline, /data-testid="timeline-render-preview"/);assert.match(html.timeline, /data-testid="timeline-undo"/);
    assert.ok(html.timeline.includes(translate(locale, 'opacity.restored.snapHint')));assert.ok(!html.timeline.includes(translate(locale, 'timeline.view.snapHint')));
    assert.match(html.inspector, /data-testid="clip-opacity-envelope"/);assert.match(html.inspector, /data-testid="save-clip"/);
    assert.ok(html.inspector.includes(translate(locale, 'opacity.restored.currentDraft')));assert.ok(!html.inspector.includes(translate(locale, 'recovery.clip.shortDisclosure')));
    assert.doesNotMatch(html.inspector, /data-testid="remove-clip"|restore-clip-draft|discard-stored-clip-draft/);
    assert.ok(!html.preview.includes(translate(locale, 'timeline.preview.import')));
  }
});


// Execute the actual Timeline admission callbacks and the actual toolbar menu
// composition. UI primitives are inert nodes here; no SSR check is treated as
// an opened browser menu, and no mutation result is supplied by a test double.
function timelineActionsHarness(timeline, asset) {
  const hooks = [], cleanup = [], writes = [], modules = new Map();let cursor = 0;
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
  const react = {
    createElement: (type, props, ...children) => ({type, props: {...props, children}}),
    useRef: initial => hooks[cursor++] ||= {current: initial},
    useState(initial) {const at = cursor++;hooks[at] ??= {value: typeof initial === 'function' ? initial() : initial};return [hooks[at].value, value => {hooks[at].value = typeof value === 'function' ? value(hooks[at].value) : value;}];},
    useLayoutEffect(callback) {cleanup.push(callback());}, useEffect() {},
  };react.default = react;
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = {exports:{}};
    Function('require','module','exports',transformSync(readFileSync(new URL(`../apps/web/src/${file}`,import.meta.url),'utf8'),{loader:file.endsWith('.tsx')?'tsx':'jsx',format:'cjs'}).code)(name => {
      if (name === 'react') return react;
      if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
      if (name === './UiPreferencesProvider.tsx') return {useUiPreferences:()=>({preferences:DEFAULT_UI_PREFERENCES})};
      if (name === './timeline-view-geometry.ts') return geometry;
      if (name === './timeline-removal.ts') return {displayTimelineFrame};
      if (name === './timeline-keyboard.js') return {rulerFrameForKey};
      if (name === './timeline-snapping.js') return {timelineDropPreview};
      if (name === './timeline-source-freshness.ts') return {staleSourceSentence};
      if (name === './TimelineToolbar.tsx') return load('TimelineToolbar.tsx');
      if (name === './ClipRemovalControls.tsx') return {ClipActionsMenu:'ClipActionsMenu',TimelineRemovalShortcuts:'TimelineRemovalShortcuts',useClipRemoval:()=>({request(){},dialog:null})};
      if (name === './use-timeline-waveforms.js') return {useTimelineWaveforms:()=>({enabled:false,windows:[],entries:new Map(),setEnabled(){},retry(){}})};
      if (name === './TimelineWaveform.jsx') return {default:'TimelineWaveform',TimelineWaveformControls:'TimelineWaveformControls',__esModule:true};
      if (name === './waveform-state.js') return {WAVEFORM_LIMITS};
      if (name === './api.js') return {assetUrl:()=>''};
      if (name === './Nodes.jsx') return {Media:'Media'};
      if (name.startsWith('@mioon/ui/')) return new Proxy({}, {get:(_,key)=>String(key)});
      if (name.endsWith('.css')) return {};
      if (name.endsWith('.jsx')) return {default:name,__esModule:true};
      throw Error(`Unexpected Timeline action dependency ${name}`);
    },module,module.exports);
    modules.set(file,module.exports);return module.exports;
  }
  const Timeline = load('Timeline.jsx').default, Toolbar = load('TimelineToolbar.tsx').default;
  return {writes, render(structureReadOnly, overrides={}) {
    cursor=0;
    const tree=Timeline({timeline,assets:[asset],playhead:0,visible:true,presentationVisible:true,collapsed:false,basicEditingOnly:true,structureReadOnly,sessionViewOnly:true,waveformReadOnly:true,
      onTrackAdd:kind=>writes.push(['add',kind]),onTrackUpdate:(id,patch)=>writes.push(['update',id,patch]),onSeek(){},onCollapse(){},onRender(){},...overrides});
    const toolbar=Toolbar(nodes(tree).find(node=>node.type===Toolbar).props);
    return {all:[...nodes(tree),...nodes(toolbar)],find:id=>nodes(toolbar).find(node=>node.props?.['data-testid']===id)};
  },dispose(){for(const fn of cleanup)fn?.();}};
}

test('actual restored Timeline menu disables structure writes and rejects current and retained mutation callbacks', async t => {
  const f=await fixture(t),h=timelineActionsHarness(f.timeline,f.store.get('assets',f.assetId));t.after(()=>h.dispose());
  const ordinary=h.render(false);
  for(const name of ['add-video-track','add-audio-track']) {
    const item=ordinary.find(name);assert.equal(item.type,'DropdownMenuItem');assert.equal(Boolean(item.props.disabled),false);item.props.onClick();
  }
  assert.deepEqual(h.writes,[['add','video'],['add','audio']],'The same actual callback path admits ordinary writes');h.writes.length=0;
  const restored=h.render(true);
  for(const view of [ordinary,restored]) for(const name of ['add-video-track','add-audio-track']) {
    const item=view.find(name);if(view===restored)assert.equal(item.props.disabled,true);
    item.props.onClick();
  }
  const controls=restored.all.filter(node=>node.type==='Button'&&node.props?.['aria-pressed']!==undefined&&node.props?.onClick&&!node.props?.['data-testid']);
  assert.ok(controls.length>=2,'Restored video/audio track controls remain inspectable');
  for(const control of controls){assert.equal(control.props.disabled,true);control.props.onClick();}
  assert.deepEqual(h.writes,[],'Neither a disabled current menu nor an old ordinary portal may write restored structure');
  const current=h.render(false),retained=current.find('add-video-track').props.onClick;h.dispose();retained();
  assert.deepEqual(h.writes,[],'Unmounted portal callbacks cannot resume writing');
});
