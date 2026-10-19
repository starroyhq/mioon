import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import * as i18nCore from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceFile = join(root, 'apps/web/src/ProjectHome.tsx');
const present = existsSync(sourceFile);
// The baseline fails this explicit contract; the rendering cases are skipped
// until the new boundary exists, instead of failing for unrelated missing imports.
test('H1 provides a dedicated typed project home boundary', () => {
  assert.ok(present, 'ProjectHome.tsx must exist: an empty workbench is not the project home');
});
const componentTest = (name, body) => test(name, { skip: !present }, body);
const projects = Object.freeze([
  Object.freeze({ id: 'project-a', name: '山野之间', description: '秋日短片', updatedAt: '2026-10-13T10:30:00.000Z' }),
  Object.freeze({ id: 'project-b', name: '第二个故事', updatedAt: '2026-10-12T08:00:00.000Z' }),
]);
const forbidden = () => assert.fail('Presentation must use only the supplied callbacks');
const defaults = patch => ({ projects, phase: 'home', busy: false, listBusy: false, page: 'projects',
  onPage: forbidden, onOpen: forbidden, onRetry: forbidden, onRefresh: forbidden, onCreate: forbidden,
  settings: null, ...patch });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const find = (tree, id) => { const node = nodes(tree).find(value => value.props?.['data-testid'] === id); assert.ok(node, id); return node; };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = key => ({ key, nativeEvent: { key }, target: { value: '' }, prevented: false, preventDefault() { this.prevented = true; } });
let builtUI;
function ui() {
  if (builtUI) return builtUI;
  const uiRequire = createRequire(join(root, 'packages/ui/package.json'));
  const baseRoot = dirname(dirname(uiRequire.resolve('@base-ui/react/button')));
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ProjectHome from './src/ProjectHome.tsx';
    import { Button } from '@mioon/ui/components/button';
    import { Input } from '@mioon/ui/components/input';
    import { Textarea } from '@mioon/ui/components/textarea';
    import { Label } from '@mioon/ui/components/label';
    import { useButton } from ${JSON.stringify(join(baseRoot, 'internals/use-button/useButton.js'))};
    export { React, ProjectHome, Button, Input, Textarea, Label, renderToStaticMarkup };
    export const render = props => renderToStaticMarkup(<ProjectHome {...props} />);
    export function buttonProps(props) {
      let result;
      function Probe() {
        const { getButtonProps } = useButton({ disabled: props.disabled, native: true });
        result = getButtonProps({ onClick: props.onClick });
        return null;
      }
      renderToStaticMarkup(<Probe />);
      return result;
    }`;
  const result = buildSync({ stdin: { contents: fixture, loader: 'jsx', resolveDir: join(root, 'apps/web') },
    bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' } });
  const module = { exports: {} };
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  builtUI = module.exports;
  return builtUI;
}

// Execute the actual TSX callbacks with deterministic hook slots, while retaining
// real React elements and shared controls for SSR and Base UI handler checks.
function harness(patch = {}) {
  const actual = ui(), slots = [], calls = [], effects = [];
  let cursor = 0, mounted = true, language = 'zh-Hans';
  const react = { ...actual.React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { if (mounted) slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useId() { const index = cursor++; return `home-test-${index}`; },
    useEffect(effect, dependencies) {
      const index = cursor++, before = slots[index];
      if (before && dependencies && before.dependencies && dependencies.length === before.dependencies.length &&
          dependencies.every((value, offset) => Object.is(value, before.dependencies[offset]))) return;
      const current = { kind: 'effect', dependencies: dependencies ? [...dependencies] : undefined, cleanup: undefined };
      slots[index] = current;
      effects.push(() => {
        if (!mounted || slots[index] !== current) return;
        before?.cleanup?.();
        current.cleanup = effect();
      });
    },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'fetch', 'localStorage', 'sessionStorage', transformSync(readFileSync(sourceFile, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(name => {
    if (name === './i18n/I18nProvider.tsx') return { useI18n: () => createI18nTestContext(language) };
    if (name === '../../../packages/i18n/src/index.ts') return i18nCore;
    if (name === './LanguageControl.tsx') return { __esModule: true, default: 'LanguageControl' };
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/workbench-icons') return { WorkbenchIcon: () => null };
    if (name === '@mioon/ui/components/dialog') return { Dialog: ({children}) => actual.React.createElement(actual.React.Fragment, null, children) };
    if (name === '@mioon/ui/components/workbench-controls') return { WorkbenchDialogContent: ({children}) => actual.React.createElement('section', {role:'dialog'}, children) };
    if (name.endsWith('.css')) return {};
    const key = { '@mioon/ui/components/button': 'Button', '@mioon/ui/components/input': 'Input', '@mioon/ui/components/textarea': 'Textarea', '@mioon/ui/components/label': 'Label' }[name];
    if (key) return { [key]: actual[key] };
    assert.fail(`Unexpected presentation dependency: ${name}`);
  }, module, module.exports, forbidden, new Proxy({}, { get: forbidden, set: forbidden }), new Proxy({}, { get: forbidden, set: forbidden }));
  const h = { calls, props: defaults({ onPage: value => calls.push(['page', value]), onOpen: value => calls.push(['open', value]),
    onRetry: () => calls.push(['retry']), onRefresh: () => calls.push(['refresh']), onCreate: async (...args) => { calls.push(['create', ...args]); return true; }, ...patch }) };
  h.setLanguage = value => { language = value; };
  h.flushEffects = () => { for (const run of effects.splice(0)) run(); };
  h.render = (next = {}) => {
    assert.equal(mounted, true, 'Disposed harness cannot rerender');
    h.flushEffects(); h.props = { ...h.props, ...next }; cursor = 0;
    const tree = module.exports.default(h.props); h.flushEffects(); return tree;
  };
  h.unmount = () => {
    if (!mounted) return;
    mounted = false; effects.length = 0;
    for (const slot of slots) if (slot?.kind === 'effect') { slot.cleanup?.(); slot.cleanup = undefined; }
  };
  h.html = tree => actual.renderToStaticMarkup(tree);
  return h;
}
function showForm(h) { find(h.render(), 'project-home-create-toggle').props.onClick(); return h.render(); }
function fill(h, name = '  新的故事  ', description = '  简短说明  ') {
  const tree = h.render();
  find(tree, 'project-home-name').props.onChange({ target: { value: name } });
  find(tree, 'project-home-description').props.onChange({ target: { value: description } });
  return h.render();
}
function submit(h) { const e = event(); const result = find(h.render(), 'project-home-create-form').props.onSubmit(e); assert.equal(e.prevented, true); return result; }

componentTest('empty home is a standalone welcome without project controls or a modal', () => {
  const html = ui().render(defaults({ projects: [] }));
  assert.match(html, /data-testid="project-home"/);
  assert.match(html, /还没有项目/);
  assert.match(html, /创建第一个项目/);
  assert.match(html, /项目/);
  assert.match(html, /data-testid="project-home-create-toggle"/);
  assert.doesNotMatch(html, /react-flow|timeline-panel|asset-panel|inspector-region|task-workspace|image-generation|role="dialog"|aria-modal/);
  assert.doesNotMatch(html, /暂无任务|没有任务|关闭项目/);
});

componentTest('real shared controls render keyboard-native page and project buttons with honest timestamps', () => {
  const html = ui().render(defaults());
  for (const id of ['project-home-page-projects', 'project-home-page-settings', 'project-home-refresh', 'project-home-open-project-a']) {
    assert.match(html, new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`));
  }
  assert.match(html, /data-slot="button"/);
  assert.match(html, /更新时间/);
  assert.match(html, /dateTime="2026-10-13T10:30:00.000Z"/i);
  assert.match(html, /山野之间/);
  assert.doesNotMatch(html, /最近打开|上次打开|MRU/);
  assert.ok(html.indexOf('山野之间') < html.indexOf('第二个故事'), 'Keep the supplied list order');
});

componentTest('list errors do not masquerade as empty workspaces and keep refresh reachable', () => {
  const html = ui().render(defaults({ projects: [], listError: '项目列表读取失败' }));
  assert.match(html, /role="alert"/); assert.match(html, /项目列表读取失败/);
  assert.match(html, /data-testid="project-home-refresh"/);
  assert.doesNotMatch(html, /还没有项目|创建第一个项目/);
  const loading = ui().render(defaults({ projects: [], listBusy: true }));
  assert.match(loading, /正在读取项目列表/);
  assert.doesNotMatch(loading, /还没有项目/);
});

componentTest('opening and error states stay on home, identify the target, and offer an explicit retry', () => {
  const opening = ui().render(defaults({ phase: 'opening', openingName: '山野之间' }));
  assert.match(opening, /正在打开/); assert.match(opening, /山野之间/); assert.match(opening, /role="status"/);
  assert.doesNotMatch(opening, /data-testid="project-home-retry"/);
  const failure = ui().render(defaults({ phase: 'error', openingName: '山野之间', error: '读取失败' }));
  assert.match(failure, /role="alert"/); assert.match(failure, /读取失败/); assert.match(failure, /山野之间/);
  assert.match(failure, /data-testid="project-home-retry"/);
  assert.match(failure, /data-testid="project-home-open-project-b"/);
});

componentTest('notice and supplied status remain visible across project and settings pages', () => {
  const actual = ui();
  for (const page of ['projects', 'settings']) {
    const html = actual.render(defaults({ page, notice: '恢复分支限制', status: actual.React.createElement('span', null, '位置状态保留'), settings: actual.React.createElement('section', null, '设置正文') }));
    assert.match(html, /恢复分支限制/); assert.match(html, /位置状态保留/);
    assert.equal(html.includes('设置正文'), page === 'settings');
    assert.equal(html.includes('project-home-open-project-a'), page === 'projects');
    assert.doesNotMatch(html, /role="dialog"|aria-modal|drawer/);
  }
});

componentTest('actual callbacks dispatch only explicit list, retry, open, and page intent', () => {
  const h = harness({ phase: 'error', error: '打开失败' }); const tree = h.render();
  assert.deepEqual(h.calls, []);
  find(tree, 'project-home-refresh').props.onClick();
  find(tree, 'project-home-retry').props.onClick();
  find(tree, 'project-home-open-project-b').props.onClick();
  find(tree, 'project-home-page-settings').props.onClick();
  assert.deepEqual(h.calls, [['refresh'], ['retry'], ['open', 'project-b'], ['page', 'settings']]);
});

componentTest('busy and opening disable repeated project actions including real shared keyboard handlers', () => {
  for (const patch of [{ busy: true }, { phase: 'opening' }]) {
    const h = harness(patch), tree = h.render();
    for (const id of ['project-home-open-project-a', 'project-home-create-toggle']) {
      const control = find(tree, id); assert.equal(control.props.disabled, true, id);
      control.props.onClick();
      const native = ui().buttonProps(control.props), click = event();
      native.onClick(click); assert.equal(click.prevented, true);
      for (const key of ['Enter', ' ']) { native.onKeyDown(event(key)); native.onKeyUp(event(key)); }
    }
    assert.deepEqual(h.calls, []);
  }
});

componentTest('opening cannot enter settings, while an error preserves controlled settings navigation', async () => {
  const h = harness({ phase: 'opening' }), blocked = find(h.render(), 'project-home-page-settings');
  assert.equal(blocked.props.disabled, true); blocked.props.onClick();
  const native = ui().buttonProps(blocked.props); native.onClick(event());
  for (const key of ['Enter', ' ']) { native.onKeyDown(event(key)); native.onKeyUp(event(key)); }
  assert.deepEqual(h.calls, []);
  const tree = h.render({ phase: 'error', error: '打开失败' });
  assert.equal(find(tree, 'project-home-page-settings').props.disabled, false);
  find(tree, 'project-home-page-settings').props.onClick();
  assert.deepEqual(h.calls, [['page', 'settings']]);
  assert.equal(h.props.page, 'projects', 'Only the controlled parent can accept a page change');
  assert.ok(find(h.render(), 'project-home-open-project-a'));
  h.render({ page: 'settings' });
  find(h.render(), 'project-home-page-projects').props.onClick();
  assert.equal(h.props.page, 'settings', 'Leaving settings also waits for the parent');
});

componentTest('modal creation uses labeled shared inputs, 500-character direction and native form submission', () => {
  const h = harness(), tree = showForm(h), html = h.html(tree);
  const name = find(tree, 'project-home-name'), description = find(tree, 'project-home-description');
  assert.equal(name.type, ui().Input); assert.equal(description.type, ui().Textarea);
  assert.equal(name.props.maxLength, 150); assert.equal(name.props.required, true);
  assert.equal(description.props.maxLength, 500);
  assert.ok(nodes(tree).some(node => node.type === ui().Label && node.props.htmlFor === name.props.id));
  assert.ok(nodes(tree).some(node => node.type === ui().Label && node.props.htmlFor === description.props.id));
  assert.match(html, /<form[^>]*data-testid="project-home-create-form"/);
  assert.equal(find(tree, 'project-home-create-submit').props.type, 'submit');
  assert.match(html, /role="dialog"/);
});

componentTest('required-name and length validation reject programmatic invalid submissions', async () => {
  for (const [name, description] of [['   ', ''], ['n'.repeat(151), ''], ['valid', 'd'.repeat(501)]]) {
    const h = harness(); showForm(h); fill(h, name, description); await submit(h);
    assert.deepEqual(h.calls, []); assert.match(h.html(h.render()), /role="alert"/);
  }
});

componentTest('a form already open cannot submit after opening begins or the controlled page leaves', async () => {
  for (const patch of [{ phase: 'opening' }, { busy: true }, { page: 'settings' }]) {
    const h = harness(); showForm(h); fill(h); const retained = find(h.render(), 'project-home-create-form').props.onSubmit;
    const tree = h.render(patch); await retained(event());
    assert.deepEqual(h.calls, []);
    if (patch.page !== 'settings') {
      assert.equal(find(tree, 'project-home-name').props.disabled, true);
      assert.equal(find(tree, 'project-home-description').props.disabled, true);
      assert.equal(find(tree, 'project-home-create-submit').props.disabled, true);
    }
  }
});

componentTest('create trims inputs, dispatches once before a parent rerender, and clears only accepted success', async () => {
  const pending = deferred(), calls = [], h = harness({ onCreate: (...args) => { calls.push(args); return pending.promise; } });
  showForm(h); fill(h); const original = find(h.render(), 'project-home-create-form').props.onSubmit;
  const first = original(event()); const duplicate = original(event()); await duplicate;
  assert.deepEqual(calls, [['新的故事', '简短说明', 'portrait_1080']]);
  const busy = h.render(); assert.equal(find(busy, 'project-home-create-submit').props.disabled, true);
  assert.equal(find(busy, 'project-home-open-project-a').props.disabled, true);
  pending.resolve(true); await first;
  const closed = h.render(); assert.equal(nodes(closed).some(node => node.props?.['data-testid'] === 'project-home-create-form'), false);
  const reopened = showForm(h); assert.equal(find(reopened, 'project-home-name').props.value, ''); assert.equal(find(reopened, 'project-home-description').props.value, '');
});

componentTest('rejected or unknown create results retain exact inputs and offer list checking without replay', async () => {
  for (const result of ['rejected', 'unknown']) {
    let calls = 0; const h = harness({ onCreate: async () => { calls++; if (result === 'unknown') throw Error('响应未知'); return false; } });
    showForm(h); fill(h); await submit(h);
    const tree = h.render(); assert.equal(find(tree, 'project-home-name').props.value, '  新的故事  ');
    assert.equal(find(tree, 'project-home-description').props.value, '  简短说明  ');
    assert.match(h.html(tree), /刷新.*列表/);
    find(tree, 'project-home-refresh').props.onClick(); h.render();
    assert.equal(calls, 1); assert.deepEqual(h.calls, [['refresh']]);
  }
});

componentTest('cancel, settings navigation, and a late unaccepted result never clear draft input or navigate', async () => {
  const h = harness(); showForm(h); fill(h);
  find(h.render(), 'project-home-create-cancel').props.onClick();
  assert.equal(find(showForm(h), 'project-home-name').props.value, '  新的故事  ');
  h.render({ page: 'settings', settings: ui().React.createElement('div', null, '连接内容') });
  assert.equal(find(h.render({ page: 'projects' }), 'project-home-name').props.value, '  新的故事  ');
  const pending = deferred(); h.render({ onCreate: () => pending.promise }); const first = submit(h);
  h.render({ page: 'settings' }); pending.resolve(false); await first;
  assert.deepEqual(h.calls, []);
  assert.equal(find(h.render({ page: 'projects' }), 'project-home-name').props.value, '  新的故事  ');
});

componentTest('classic JSX executes with explicit React import and presentation has no business dependencies', () => {
  assert.equal(typeof globalThis.React, 'undefined');
  const h = harness(); assert.match(h.html(h.render()), /项目列表/);
  const source = readFileSync(sourceFile, 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|\brpc\s*\(|localStorage|sessionStorage|setInterval|setTimeout|createPortal|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck/);
});

componentTest('home styles are scoped and include bounded scrolling and narrow-window layout', () => {
  const css = readFileSync(join(root, 'apps/web/src/project-home.css'), 'utf8');
  assert.match(css, /\.project-home\s*\{/); assert.match(css, /height:\s*100%/);
  const redesigned = readFileSync(join(root, 'apps/web/src/project-home-redesign.css'), 'utf8');
  assert.match(redesigned, /\.project-home-page \{ height: 100dvh;/);
  assert.match(redesigned, /\.project-home-embedded > \.project-home \{ height: 100%; min-height: 0;/);
  assert.match(css, /overflow-y:\s*auto/); assert.match(css, /min-width:\s*0/);
  assert.match(css, /overflow-wrap:\s*anywhere/); assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.doesNotMatch(css, /\.workbench|\.topbar|\.inspector-region|\.timeline-panel|\.asset-panel|^body\b/m);
});

componentTest('mac-inset home header preserves native-control space and interactive no-drag boundaries', () => {
  const css = readFileSync(join(root, 'apps/web/src/project-home.css'), 'utf8');
  assert.match(css, /:root\[data-desktop-frame="mac-inset"\] \.project-home-settings-window \.project-home-header\s*\{[^}]*padding-left:\s*88px;[^}]*-webkit-app-region:\s*drag;/);
  assert.match(css, /:root\[data-desktop-frame="mac-inset"\] \.project-home-settings-window \.project-home-header :is\(a, button, input, select, textarea,[^}]*summary\)\s*\{\s*-webkit-app-region:\s*no-drag;/);
  for (const selector of css.matchAll(/:root[^{}]+\{/g)) assert.match(selector[0], /\.project-home-settings-window \.project-home-header/);
  const redesigned = readFileSync(join(root, 'apps/web/src/project-home-redesign.css'), 'utf8');
  assert.match(redesigned, /:root\[data-desktop-frame="mac-inset"\] \.project-home-page \.project-home-header \{[^}]*padding-left: 88px/);
  assert.match(redesigned, /\.project-home-embedded > \.project-home > \.project-home-header \{[^}]*-webkit-app-region: no-drag/);
});


test('actual App wires the scoped home stylesheet without weakening TypeScript module checks', () => {
  assert.match(readFileSync(join(root, 'apps/web/src/App.jsx'), 'utf8'), /import ['"]\.\/project-home\.css['"]/);
});

componentTest('native create intent effect opens once and retained inputs survive later same-version renders', () => {
  const h = harness({ canMutateEntry: () => true });
  h.render({ createIntentVersion: 1 });
  assert.ok(find(h.render(), 'project-home-create-form'));
  fill(h, 'retained input', 'retained description');
  find(h.render(), 'project-home-create-cancel').props.onClick();
  assert.equal(nodes(h.render()).some(node => node.props?.['data-testid'] === 'project-home-create-form'), false);
  h.render({ createIntentVersion: 2 });
  assert.equal(find(h.render(), 'project-home-name').props.value, 'retained input');
  assert.equal(find(h.render(), 'project-home-description').props.value, 'retained description');
  assert.deepEqual(h.calls, []);
  h.unmount(); h.flushEffects();
});


componentTest('four-language live rendering retains draft fields, form ownership, and unknown pending outcome', async () => {
  const answer = deferred(), requests = [], reports = [];
  const h = harness({ onCreate: (...args) => { requests.push(args); return answer.promise; }, onCreateStateChange: state => reports.push(state) });
  showForm(h); fill(h, ' 用户项目 <literal> ', ' 日本語の内容 stays unchanged ');
  const initial = h.render(), inputId = find(initial, 'project-home-name').props.id;
  const work = submit(h), reportCount = reports.length;
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    h.setLanguage(locale); const tree = h.render();
    assert.equal(find(tree, 'project-home-name').props.id, inputId);
    assert.equal(find(tree, 'project-home-name').props.value, ' 用户项目 <literal> ');
    assert.equal(find(tree, 'project-home-description').props.value, ' 日本語の内容 stays unchanged ');
    assert.equal(find(tree, 'project-home-name').props.disabled, true);
    assert.equal(requests.length, 1); assert.equal(reports.length, reportCount, 'Language is presentation only, not a new draft version');
    assert.ok(text(tree).includes(i18nCore.translate(locale, 'projects.list')));
  }
  answer.resolve(false); await work;
  assert.deepEqual(requests, [['用户项目 <literal>', '日本語の内容 stays unchanged', 'portrait_1080']]);
  for (const locale of ['en', 'ja', 'zh-Hant', 'zh-Hans']) {
    h.setLanguage(locale); const tree = h.render();
    assert.equal(find(tree, 'project-home-name').props.value, ' 用户项目 <literal> ');
    assert.ok(text(tree).includes(i18nCore.translate(locale, 'projects.createRetained')));
  }
  assert.equal(requests.length, 1);
});
