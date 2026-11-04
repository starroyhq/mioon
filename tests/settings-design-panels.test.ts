import type {RootModule,RootControlledModules} from './helpers/strict-root-ui-types.ts';
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { i18nTestModule } from './helpers/i18n.ts';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import * as menuProtocol from '../apps/desktop/src/menu-command-protocol.ts';

const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = (value: RootTree) : string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const flush = () => new Promise(setImmediate);
function harness<File extends 'GenerationLiveGateNotice.tsx'|'SettingsExtraPages.tsx'|'SettingsVideoTools.tsx'|'SettingsWorkspace.tsx'|'SettingsMediaToolsDownload.tsx', Export extends keyof RootControlledModules[File]>(file: File, exportName: Export, imports: Record<string,unknown>, initialProps: Record<string,unknown> = {}) {
  const hooks: RootHook[] = []; let cursor = 0, effects: number[] = [], tree: string|number|boolean|RootNode|RootTree[]|null|undefined, props: Record<string,unknown> = { active: true, ...initialProps };
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useRef(initial: unknown) { return hooks[cursor++] ||= { current: initial }; },
    useCallback(callback: unknown, deps: readonly unknown[]) { const index = cursor++, previous = hooks[index]; if (previous?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return previous.value; hooks[index] = { value: callback, deps }; return callback; },
    useState(initial: unknown) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (next: unknown) => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next; }]; },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[] | undefined) { const index = cursor++, previous = hooks[index]; if (previous?.deps!.length === deps!.length && deps!.every((value, i) => Object.is(value, previous.deps![i]))) return; hooks[index] = { callback, deps, cleanup: previous?.cleanup }; effects.push(index); },
  };
  (react as typeof react & {default?: unknown}).default = react; (react as typeof react&{useLayoutEffect:typeof react.useEffect}).useLayoutEffect = react.useEffect;
  const primitive = new Proxy({}, { get: (_, key) => String(key) }), module = { exports: {} as RootModule<RootControlledModules[File]> };
  const source = readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)((name: string) => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule('zh-Hans');
    if (name === './settings-navigation-state.ts') return navigation;
    if (name === '../../desktop/src/menu-command-protocol.ts') return menuProtocol;
    if (name === './GenerationLiveGateNotice.tsx') return {notifyGenerationLiveGateChanged() {}};
    if (Object.hasOwn(imports, name)) return imports[name];
    if (name.startsWith('@mioon/ui/') || name.endsWith('.css')) return primitive;
    assert.fail(`Unexpected setting dependency ${name}`);
  }, module, module.exports);
  return {
    render(patch: Record<string,unknown>|undefined = {}) { props = { ...props, ...patch }; cursor = 0; effects = []; tree = (module.exports[exportName] as (props:Record<string,unknown>)=>RootTree)(props); for (const index of effects) { hooks[index].cleanup?.(); hooks[index].cleanup = hooks[index].callback!(); } return tree; },
    find(id: string) { return nodes(tree).find((node) => node.props?.['data-testid'] === id); },
    get tree() { return tree; }, exports: module.exports,
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

const workspaceSettings=(enabled: boolean)=>({formatVersion:1,revision:0,liveGeneration:enabled});
for (const enabled of [false, true]) test(`service panel shows the persisted live gate ${enabled} independently from missing credentials and checks only local metadata`, async () => {
  const calls: unknown[][] = [], missing = ['ARK_API_KEY', ...enabled ? [] : ['MIOON_ENABLE_LIVE_PROVIDER']];
  const h = harness('SettingsExtraPages.tsx', 'SettingsModelServices', {
    './workspace-info-client.ts': {},
    './workspace-settings-client.ts': {readWorkspaceSettings:async()=>workspaceSettings(enabled)},
    './browser-rpc.ts': { browserRpc: async (...args: unknown[]) => { calls.push(args); return [{ id: 'ark', configured: false, enabled: false, configuration: { missing } }, { id: 'veo', configured: false }, { id: 'mock', configured: true, enabled: true }]; } },
  });
  h.render(); await flush(); h.render();
  assert.equal((h.find('settings-live-generation'))!.props.checked, enabled);
  assert.equal((h.find('settings-live-generation'))!.props.disabled, false);
  assert.match(text(h.tree), /Seedance 2\.5.*Veo 3\.1.*本地模拟/u);
  assert.doesNotMatch(text(h.tree), /刷新项目列表/u);
  assert.deepEqual(nodes(h.tree).map(node => node.props?.['data-testid']).filter((id) => id?.startsWith('settings-service-check-')), ['settings-service-check-ark', 'settings-service-check-veo', 'settings-service-check-minimax', 'settings-service-check-vidu']);
  assert.doesNotMatch(text(h.tree), /Runway/u); assert.match(text(h.tree), /环境变量连接/u);
  (h.find('settings-service-check-ark'))!.props.onClick(); h.render(); await flush(); h.render();
  assert.equal(calls.length, 2); assert.ok(calls.every(([operation, input]) => operation === 'provider.list' && Object.keys(input as object).length === 0));
  h.unmount();
});

test('failed service discovery leaves the live gate unknown instead of presenting a configured provider as enabled', async () => {
  const h = harness('SettingsExtraPages.tsx', 'SettingsModelServices', { './workspace-info-client.ts': {}, './workspace-settings-client.ts':{readWorkspaceSettings:async()=>{throw Error('synthetic private settings');}}, './browser-rpc.ts': { browserRpc: async () => { throw Error('synthetic private diagnostic'); } } });
  h.render(); await flush(); h.render();
  assert.equal((h.find('settings-live-generation'))!.props.checked, false);
  assert.match(text(h.tree), /尚未检测/u); assert.doesNotMatch(text(h.tree), /synthetic private/u);
  assert.match(text(nodes(h.tree).find((node)=>node.type==='footer')),/状态未确认/);
  h.unmount();
});

test('live switch waits for the persisted revision and stale hidden callbacks cannot enable generation',async()=>{
 let value=workspaceSettings(false),resolve!:()=>void;const writes: unknown[]=[];
 const h=harness('SettingsExtraPages.tsx','SettingsModelServices',{'./workspace-info-client.ts':{},'./browser-rpc.ts':{browserRpc:async()=>[]},'./workspace-settings-client.ts':{readWorkspaceSettings:async()=>value,saveWorkspaceSettings:(input: {liveGeneration:boolean})=>{writes.push(input);return new Promise<ReturnType<typeof workspaceSettings>>(done=>{resolve=()=>{value={...value,revision:1,liveGeneration:input.liveGeneration};done(value);};});}}});
 h.render();await flush();h.render();const edit=(h.find('settings-live-generation'))!.props.onCheckedChange;edit(true);h.render();
 assert.equal((h.find('settings-live-generation'))!.props.checked,false);assert.equal((h.find('settings-live-generation'))!.props.disabled,true);assert.deepEqual(writes,[{expectedRevision:0,liveGeneration:true}]);
 (resolve)!();await flush();h.render();await flush();h.render();assert.equal((h.find('settings-live-generation'))!.props.checked,true);
 h.render({active:false});edit(false);assert.equal(writes.length,1);assert.match(text(h.tree),/更改立即保存在本机/);h.unmount();
});

test('video tool cards expose actual versions and missing capabilities after one bounded local check, without requiring a manual first check', async () => {
  const calls: unknown[] = [], diagnostics = { ffmpeg: { path: '/local/ffmpeg', available: true, version: 'ffmpeg version synthetic' }, ffprobe: { path: '/local/ffprobe', available: true, version: 'ffprobe version synthetic' }, capabilities: { libx264: true, aac: true, drawtext: false, subtitles: false } };
  const h = harness('SettingsVideoTools.tsx', 'default', { './SettingsMediaToolsDownload.tsx': { default: () => { calls.push('download card'); return null; } }, './workspace-info-client.ts': { workspaceToolsBridge: () => undefined, readWorkspaceInfo: async () => ({ tools: { ffmpeg: '/local/ffmpeg', ffprobe: '/local/ffprobe' } }), checkConfiguredMediaTools: async () => { calls.push('check'); return diagnostics; } } });
  h.render(); await flush(); h.render(); await flush(); h.render();
  assert.match(text(h.find('workspace-tool-ffmpeg')), /ffmpeg version synthetic/u);
  assert.match(text(h.find('workspace-tool-ffprobe')), /ffprobe version synthetic/u);
  assert.match(text(h.find('workspace-tool-ffmpeg')), /drawtext不可用.*subtitles不可用/u);
  assert.ok(h.find('workspace-tools-capability-warning'));
  h.render({ active: false }); h.render({ active: true }); await flush(); h.render();
  assert.deepEqual(calls, ['check']);
  h.unmount();
});

test('Mioon media tools card downloads through the native bridge, reports progress and failures, and marks the saved copy in use', async () => {
  const offer = { version: '7.1.5-1', ffmpegVersion: '7.1.5', arch: 'arm64', downloadBytes: 31_457_280, license: 'GPL-2.0-or-later', sourceUrl: 'https://github.com/starroyhq/mioon/releases/tag/media-tools-7.1.5-1' };
  const installedPaths = { ffmpeg: '/private/media-tools/7.1.5-1/ffmpeg', ffprobe: '/private/media-tools/7.1.5-1/ffprobe' };
  const diagnostics = { ffmpeg: { path: installedPaths.ffmpeg, available: true, version: 'ffmpeg version 7.1.5' }, ffprobe: { path: installedPaths.ffprobe, available: true, version: 'ffprobe version 7.1.5' }, capabilities: { libx264: true, aac: true, drawtext: true, subtitles: true } };
  let status: Record<string, unknown> = { offer, installed: null, progress: { phase: 'idle', receivedBytes: 0, totalBytes: 0, code: null } }, finish!: (value: unknown) => void;
  const installedCalls: unknown[][] = [], busy: boolean[] = [], requests: string[] = [];
  const native = { mediaToolsStatus: async () => { requests.push('status'); return status; }, installMediaTools: () => { requests.push('install'); return new Promise(resolve => { finish = resolve; }); }, cancelMediaToolsInstall: async () => { requests.push('cancel'); return true; } };
  const h = harness('SettingsMediaToolsDownload.tsx', 'default', { './workspace-native-client.ts': { workspaceNativeBridge: () => ({ restart: async () => { requests.push('restart'); } }) } },
    { native, saved: { ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' }, onInstalled: (...args: unknown[]) => installedCalls.push(args), onBusyChange: (value: boolean) => busy.push(value) });
  h.render(); await flush(); h.render();
  assert.match(text(h.tree), /Mioon 提供的版本.*FFmpeg 7\.1\.5 · Apple 芯片 · 约 30\.0 MB.*GPL.*media-tools-7\.1\.5-1/u);
  h.find('workspace-tools-download-install')!.props.onClick(); h.render();
  status = { ...status, progress: { phase: 'downloading', receivedBytes: 10_485_760, totalBytes: 31_457_280, code: null } };
  await flush(); h.render();
  assert.ok(h.find('workspace-tools-download-progress'));
  assert.equal(busy.at(-1), true);
  h.find('workspace-tools-download-cancel')!.props.onClick();
  finish({ ok: false, code: 'MEDIA_TOOLS_CHECKSUM_MISMATCH' }); status = { ...status, progress: { phase: 'failed', receivedBytes: 0, totalBytes: 31_457_280, code: 'MEDIA_TOOLS_CHECKSUM_MISMATCH' } };
  await flush(); h.render(); await flush(); h.render();
  assert.match(text(h.find('workspace-tools-download-failure')), /没有通过校验/u);
  assert.equal(busy.at(-1), false);
  h.find('workspace-tools-download-install')!.props.onClick(); h.render();
  finish({ ok: true, paths: installedPaths, diagnostics }); status = { ...status, installed: installedPaths, progress: { phase: 'completed', receivedBytes: 31_457_280, totalBytes: 31_457_280, code: null } };
  await flush(); h.render(); await flush(); h.render();
  assert.deepEqual(installedCalls, [[installedPaths, diagnostics]]);
  assert.match(text(h.tree), /已安装并保存路径/u);
  h.render({ saved: installedPaths });
  assert.match(text(h.tree), /正在使用/u);
  assert.equal(h.find('workspace-tools-download-install'), undefined, 'the copy in use offers no install button');
  assert.deepEqual(requests.filter(request => request !== 'status'), ['install', 'cancel', 'install']);
  h.unmount();
  const hidden = harness('SettingsMediaToolsDownload.tsx', 'default', { './workspace-native-client.ts': { workspaceNativeBridge: () => undefined } },
    { native: { ...native, mediaToolsStatus: async () => ({ ...status, offer: null }) }, saved: null, onInstalled: () => {} });
  hidden.render(); await flush(); hidden.render();
  assert.equal(hidden.tree, null, 'platforms without a Mioon build show nothing');
  hidden.unmount();
});

test('workspace settings preserve directory, usage and cleanup information without retired backup controls', async t => {
  const calls: string[] = [];
  const h = harness('SettingsWorkspace.tsx','default',{
    './workspace-info-client.ts': {workspaceToolsBridge:()=>undefined,readWorkspaceInfo:async()=>{calls.push('info');return {dataDirectory:'/private/current-data',usage:{bytes:1024,complete:false},pendingProjectCleanup:2};}},
    './workspace-settings-client.ts': {readWorkspaceSettings:async()=>{calls.push('settings');return workspaceSettings(false);}},
  });
  t.after(()=>h.unmount());h.render();await flush();h.render();
  assert.deepEqual(calls,['info','settings']);
  assert.equal(nodes(h.tree).find(node=>node.type==='input')!.props.value,'/private/current-data');
  assert.match(text(h.tree),/部分文件未统计/);assert.match(text(h.tree),/2/);
  assert.equal(h.find('workspace-backup-create'),undefined);assert.equal(h.find('workspace-auto-backup'),undefined);
  assert.match(text(nodes(h.tree).find(node=>node.type==='footer')),/更改立即保存在本机/);
});
test('hidden workspace settings abort pending reads and a late failure cannot publish into a new visible owner', async t => {
  let reject!: (reason:unknown)=>void;const signals: AbortSignal[]=[];let reads=0;
  const h = harness('SettingsWorkspace.tsx','default',{
    './workspace-info-client.ts': {workspaceToolsBridge:()=>undefined,readWorkspaceInfo:async()=>({dataDirectory:'/private/current-data',usage:{bytes:1024,complete:true},pendingProjectCleanup:0})},
    './workspace-settings-client.ts': {readWorkspaceSettings:async(signal:AbortSignal)=>{signals.push(signal);if(++reads===1)return new Promise((_yes,no)=>{reject=no;});return workspaceSettings(false);}},
  });
  t.after(()=>h.unmount());h.render();h.render({active:false});assert.equal(signals[0].aborted,true);
  h.render({active:true});await flush();h.render();reject(Object.assign(Error('private stale error'),{code:'NETWORK'}));await flush();h.render();
  assert.equal(reads,2);assert.doesNotMatch(text(h.tree),/private stale error|状态未确认/);
  assert.match(text(nodes(h.tree).find(node=>node.type==='footer')),/更改立即保存在本机/);
});

test('generation detail gate notices stop hidden reads and react only after the persisted live toggle changes', async () => {
  let enabled = false, opens = 0; const first = Promise.withResolvers<ReturnType<typeof workspaceSettings>>(), signals: AbortSignal[] = []; let reads = 0;
  const h = harness('GenerationLiveGateNotice.tsx', 'default', {'./workspace-settings-client.ts': {readWorkspaceSettings: (signal: AbortSignal) => {signals.push(signal); return ++reads === 1 ? first.promise : Promise.resolve(workspaceSettings(enabled));}}}, {pageKey: 'custom', onOpen: () => {opens++;}});
  h.render(); h.render({active: false}); assert.equal(signals[0]!.aborted, true); first.resolve(workspaceSettings(false)); await flush(); h.render();
  assert.equal(h.find('generation-live-disabled'), undefined);
  h.render({active: true, pageKey: 'official'}); await flush(); h.render(); const notice = h.find('generation-live-disabled'); assert.ok(notice);
  assert.match(text(notice), /真实生成已关闭.*连接设置仍可保存/); nodes(notice).find(node => node.type === 'Button')!.props.onClick(); assert.equal(opens, 1);
  enabled = true; h.exports.notifyGenerationLiveGateChanged(); await flush(); h.render(); assert.equal(h.find('generation-live-disabled'), undefined);
  h.unmount();
});
