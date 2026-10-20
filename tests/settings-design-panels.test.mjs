import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { i18nTestModule } from './helpers/i18n.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const flush = () => new Promise(setImmediate);
function harness(file, exportName, imports) {
  const hooks = []; let cursor = 0, effects = [], tree, props = { active: true };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useState(initial) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }]; },
    useEffect(callback, deps) { const index = cursor++, previous = hooks[index]; if (previous?.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; hooks[index] = { callback, deps, cleanup: previous?.cleanup }; effects.push(index); },
  };
  react.default = react; react.useLayoutEffect = react.useEffect;
  const primitive = new Proxy({}, { get: (_, key) => String(key) }), module = { exports: {} };
  const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(name => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule('zh-Hans');
    if (name === './settings-navigation-state.ts') return navigation;
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.startsWith('@mioon/ui/') || name.endsWith('.css')) return primitive;
    assert.fail(`Unexpected setting dependency ${name}`);
  }, module, module.exports);
  return {
    render(patch = {}) { props = { ...props, ...patch }; cursor = 0; effects = []; tree = module.exports[exportName](props); for (const index of effects) { hooks[index].cleanup?.(); hooks[index].cleanup = hooks[index].callback(); } return tree; },
    find(id) { return nodes(tree).find(node => node.props?.['data-testid'] === id); },
    get tree() { return tree; },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

const workspaceSettings=enabled=>({formatVersion:1,revision:0,liveGeneration:enabled,automaticBackup:false,backupIntervalHours:24,backupLocation:'default',backupDirectory:'/private/local-backups'});
for (const enabled of [false, true]) test(`service panel shows the persisted live gate ${enabled} independently from missing credentials and checks only local metadata`, async () => {
  const calls = [], missing = ['ARK_API_KEY', ...enabled ? [] : ['MIOON_ENABLE_LIVE_PROVIDER']];
  const h = harness('SettingsExtraPages.tsx', 'SettingsModelServices', {
    './workspace-info-client.ts': {},
    './workspace-settings-client.ts': {readWorkspaceSettings:async()=>workspaceSettings(enabled)},
    './browser-rpc.ts': { browserRpc: async (...args) => { calls.push(args); return [{ id: 'ark', configured: false, enabled: false, configuration: { missing } }, { id: 'veo', configured: false }, { id: 'mock', configured: true, enabled: true }]; } },
  });
  h.render(); await flush(); h.render();
  assert.equal(h.find('settings-live-generation').props.checked, enabled);
  assert.equal(h.find('settings-live-generation').props.disabled, false);
  assert.match(text(h.tree), /Seedance 2\.5.*Veo 3\.1.*本地模拟/u);
  assert.doesNotMatch(text(h.tree), /刷新项目列表/u);
  assert.deepEqual(nodes(h.tree).map(node => node.props?.['data-testid']).filter(id => id?.startsWith('settings-service-check-')), ['settings-service-check-ark', 'settings-service-check-veo', 'settings-service-check-minimax', 'settings-service-check-vidu']);
  assert.doesNotMatch(text(h.tree), /Runway/u); assert.match(text(h.tree), /环境变量连接/u);
  h.find('settings-service-check-ark').props.onClick(); h.render(); await flush(); h.render();
  assert.equal(calls.length, 2); assert.ok(calls.every(([operation, input]) => operation === 'provider.list' && Object.keys(input).length === 0));
  h.unmount();
});

test('failed service discovery leaves the live gate unknown instead of presenting a configured provider as enabled', async () => {
  const h = harness('SettingsExtraPages.tsx', 'SettingsModelServices', { './workspace-info-client.ts': {}, './workspace-settings-client.ts':{readWorkspaceSettings:async()=>{throw Error('synthetic private settings');}}, './browser-rpc.ts': { browserRpc: async () => { throw Error('synthetic private diagnostic'); } } });
  h.render(); await flush(); h.render();
  assert.equal(h.find('settings-live-generation').props.checked, false);
  assert.match(text(h.tree), /尚未检测/u); assert.doesNotMatch(text(h.tree), /synthetic private/u);
  assert.match(text(nodes(h.tree).find(node=>node.type==='footer')),/状态未确认/);
  h.unmount();
});

test('live switch waits for the persisted revision and stale hidden callbacks cannot enable generation',async()=>{
 let value=workspaceSettings(false),resolve;const writes=[];
 const h=harness('SettingsExtraPages.tsx','SettingsModelServices',{'./workspace-info-client.ts':{},'./browser-rpc.ts':{browserRpc:async()=>[]},'./workspace-settings-client.ts':{readWorkspaceSettings:async()=>value,saveWorkspaceSettings:input=>{writes.push(input);return new Promise(done=>{resolve=()=>{value={...value,revision:1,liveGeneration:input.liveGeneration};done(value);};});}}});
 h.render();await flush();h.render();const edit=h.find('settings-live-generation').props.onCheckedChange;edit(true);h.render();
 assert.equal(h.find('settings-live-generation').props.checked,false);assert.equal(h.find('settings-live-generation').props.disabled,true);assert.deepEqual(writes,[{expectedRevision:0,liveGeneration:true}]);
 resolve();await flush();h.render();await flush();h.render();assert.equal(h.find('settings-live-generation').props.checked,true);
 h.render({active:false});edit(false);assert.equal(writes.length,1);assert.match(text(h.tree),/更改立即保存在本机/);h.unmount();
});

test('video tool cards expose actual versions and missing capabilities after one bounded local check, without requiring a manual first check', async () => {
  const calls = [], diagnostics = { ffmpeg: { path: '/local/ffmpeg', available: true, version: 'ffmpeg version synthetic' }, ffprobe: { path: '/local/ffprobe', available: true, version: 'ffprobe version synthetic' }, capabilities: { libx264: true, aac: true, drawtext: false, subtitles: false } };
  const h = harness('SettingsVideoTools.tsx', 'default', { './workspace-info-client.ts': { workspaceToolsBridge: () => undefined, readWorkspaceInfo: async () => ({ tools: { ffmpeg: '/local/ffmpeg', ffprobe: '/local/ffprobe' } }), checkConfiguredMediaTools: async () => { calls.push('check'); return diagnostics; } } });
  h.render(); await flush(); h.render(); await flush(); h.render();
  assert.match(text(h.find('workspace-tool-ffmpeg')), /ffmpeg version synthetic/u);
  assert.match(text(h.find('workspace-tool-ffprobe')), /ffprobe version synthetic/u);
  assert.match(text(h.find('workspace-tool-ffmpeg')), /drawtext不可用.*subtitles不可用/u);
  assert.ok(h.find('workspace-tools-capability-warning'));
  h.render({ active: false }); h.render({ active: true }); await flush(); h.render();
  assert.deepEqual(calls, ['check']);
  h.unmount();
});

function workspaceFixture(options={}) {
 let settings=workspaceSettings(false),backup={phase:'idle',directory:settings.backupDirectory,automatic:false,intervalHours:24,lastBackupAt:null,nextBackupAt:null,lastError:null,backups:[],pendingRestore:null};
 const writes=[],creates=[],restores=[];
 const client={workspaceBackupBridge:()=>undefined,workspaceBackupDownloadUrl:id=>`/api/workspace-backups/${id}/download`,readWorkspaceSettings:async signal=>options.readSettings?options.readSettings(settings,signal):settings,readWorkspaceBackupStatus:async()=>backup,
  saveWorkspaceSettings:async input=>{writes.push(input);if(options.save)await options.save(input);settings={...settings,...input,revision:settings.revision+1};return settings;},
  createLocalWorkspaceBackup:async requestId=>{creates.push(requestId);if(options.create)return options.create(requestId);return {id:'new-backup'};},
  stageLocalWorkspaceRestore:async(...args)=>{restores.push(args);backup={...backup,pendingRestore:{state:'pending',restartRequired:true}};},
  importLocalWorkspaceBackup:async()=>{throw Error('Unexpected import');},};
 const h=harness('SettingsWorkspace.tsx','default',{'./workspace-info-client.ts':{workspaceToolsBridge:()=>undefined,readWorkspaceInfo:async()=>({dataDirectory:'/private/workspace',usage:{bytes:1024,complete:true},pendingProjectCleanup:0})},'./workspace-settings-client.ts':client,'./WorkspaceControls.tsx':{WorkbenchSelect:'WorkbenchSelect'},'@mioon/ui/components/workbench-confirm':{useConfirmation:()=>options.confirm??(async()=>true)}});
 return {h,writes,creates,restores,get settings(){return settings;},setBackup:value=>{backup={...backup,...value};}};
}

function captureWorkspacePoll(t){
 const callbacks=[];
 t.mock.method(globalThis,'setInterval',callback=>{callbacks.push(callback);return callbacks.length;});
 t.mock.method(globalThis,'clearInterval',()=>{});
 return ()=>callbacks.at(-1)();
}

test('late workspace polling cannot overwrite a successful save ACK before the next effect cleanup',async t=>{
 const poll=captureWorkspacePoll(t);let resolveRead,reads=0;
 const f=workspaceFixture({readSettings:snapshot=>++reads===2?new Promise(resolve=>{resolveRead=()=>resolve(snapshot);}):snapshot});t.after(()=>f.h.unmount());
 f.h.render();await flush();f.h.render();poll();
 f.h.find('workspace-auto-backup').props.onCheckedChange(true);await flush();
 assert.equal(f.settings.automaticBackup,true);resolveRead();await flush();f.h.render();
 assert.equal(f.h.find('workspace-auto-backup').props.checked,true);
 await flush();f.h.render();assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/更改立即保存在本机/);
});

test('retired workspace reads and callbacks cannot act after switching settings categories',async t=>{
 const poll=captureWorkspacePoll(t);let rejectRead,reads=0;
 const f=workspaceFixture({readSettings:snapshot=>++reads===2?new Promise((resolve,reject)=>{rejectRead=()=>reject(Object.assign(Error('private old read'),{code:'WORKSPACE_SETTINGS_CONFLICT'}));}):snapshot});t.after(()=>f.h.unmount());
 f.h.render();await flush();f.h.render();const edit=f.h.find('workspace-auto-backup').props.onCheckedChange;poll();
 edit(true);f.h.render({active:false});await flush();assert.equal(f.settings.automaticBackup,true);
 rejectRead();await flush();f.h.render();edit(false);assert.equal(f.writes.length,1);
 f.h.render({active:true});await flush();f.h.render();
 assert.equal(f.h.find('workspace-auto-backup').props.checked,true);assert.doesNotMatch(text(f.h.tree),/其他窗口已更改|状态未确认|private old read/);
 assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/更改立即保存在本机/);
});

test('workspace save failures stay visible through retired polls and retry the persisted revision',async t=>{
 const poll=captureWorkspacePoll(t);let resolveRead,reads=0,attempts=0;
 const f=workspaceFixture({readSettings:snapshot=>++reads===2?new Promise(resolve=>{resolveRead=()=>resolve(snapshot);}):snapshot,save:async()=>{if(++attempts===1)throw Object.assign(Error('private write failure'),{code:'NETWORK'});}});t.after(()=>f.h.unmount());
 f.h.render();await flush();f.h.render();poll();f.h.find('workspace-auto-backup').props.onCheckedChange(true);await flush();resolveRead();await flush();f.h.render();await flush();f.h.render();
 assert.equal(f.h.find('workspace-auto-backup').props.checked,false);assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/状态未确认/);assert.doesNotMatch(text(f.h.tree),/private write failure/);
 f.h.find('workspace-auto-backup').props.onCheckedChange(true);await flush();f.h.render();await flush();f.h.render();
 assert.deepEqual(f.writes,[{expectedRevision:0,automaticBackup:true},{expectedRevision:0,automaticBackup:true}]);
 assert.equal(f.h.find('workspace-auto-backup').props.checked,true);assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/更改立即保存在本机/);
});

test('workspace automatic backup changes persist immediately and backup retries retain their original request identity',async t=>{
 let attempts=0;const f=workspaceFixture({create:async requestId=>{if(++attempts===1)throw Object.assign(Error('private'),{code:'NETWORK'});return{id:'new-backup',requestId};}});t.after(()=>f.h.unmount());
 f.h.render();await flush();f.h.render();await f.h.find('workspace-auto-backup').props.onCheckedChange(true);await flush();f.h.render();
 assert.deepEqual(f.writes,[{expectedRevision:0,automaticBackup:true}]);
 await f.h.find('workspace-backup-create').props.onClick();await flush();f.h.render();await flush();f.h.render();
 assert.match(text(f.h.tree),/核对并重试同一备份请求/);assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/状态未确认/);await f.h.find('workspace-backup-create').props.onClick();await flush();f.h.render();
 assert.equal(f.creates.length,2);assert.equal(f.creates[0],f.creates[1]);assert.match(text(f.h.tree),/备份已完成并验证/);assert.doesNotMatch(text(f.h.tree),/private/);
});

test('workspace restore requires explicit confirmation and a late approval cannot act on a hidden settings page',async t=>{
 let approve;const f=workspaceFixture({confirm:()=>new Promise(resolve=>{approve=resolve;})});t.after(()=>f.h.unmount());f.setBackup({backups:[{id:'saved-backup',createdAt:'2026-10-20T00:00:00Z',payloadBytes:1024}]});
 f.h.render();await flush();f.h.render();f.h.find('workspace-backup-restore').props.onClick();assert.equal(f.restores.length,0);
 f.h.render({active:false});approve(true);await flush();f.h.render();assert.equal(f.restores.length,0);
});

test('staged workspace restore reports restart and prevents another backup rather than fabricating immediate replacement',async t=>{
 const f=workspaceFixture();t.after(()=>f.h.unmount());f.setBackup({backups:[{id:'saved-backup',createdAt:'2026-10-20T00:00:00Z',payloadBytes:1024}]});
 f.h.render();await flush();f.h.render();f.h.find('workspace-backup-restore').props.onClick();await flush();f.h.render();await flush();f.h.render();
 assert.equal(f.restores.length,1);assert.equal(f.restores[0][0],'saved-backup');assert.match(text(f.h.tree),/重启应用或本地服务后生效/);assert.equal(f.h.find('workspace-backup-create').props.disabled,true);
 assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/等待重启以切换工作区/);
});

test('persisted automatic backup failures remain visible after reopening settings',async t=>{
 const f=workspaceFixture();t.after(()=>f.h.unmount());f.setBackup({automatic:true,lastError:'WORKSPACE_BACKUP_BUSY'});
 f.h.render();await flush();f.h.render();assert.match(text(f.h.tree),/待对账的任务/);assert.match(text(nodes(f.h.tree).find(node=>node.type==='footer')),/状态未确认/);
});
