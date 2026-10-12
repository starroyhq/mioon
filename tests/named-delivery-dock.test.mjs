import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = path.join(root, 'apps/web/src/DeliveryWorkspace.tsx');
let rendered;
before(() => {
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import DeliveryWorkspace from './src/DeliveryWorkspace.tsx';
    import {AgentDockPane} from './src/AgentWorkspace.jsx';
    export const html = Object.fromEntries(['compose', 'history'].map(page => [page, renderToStaticMarkup(
      <DeliveryWorkspace page={page} onPage={() => { throw Error('Rendering may not change pages'); }}>
        <AgentDockPane id="delivery-compose-pane" labelledBy="delivery-compose-tab" visible={page === 'compose'} fallbackFocus="[data-testid=delivery-page-compose]">
          <div data-testid="retained-compose-draft"><input aria-label="本次名称" value="  未提交草稿  " readOnly /></div>
        </AgentDockPane>
        <AgentDockPane id="delivery-history-pane" labelledBy="delivery-history-tab" visible={page === 'history'} fallbackFocus="[data-testid=delivery-page-history]">
          <div className="export-list" data-testid="retained-history"><div className="export-card"><div className="export-detail"><strong>冻结名称</strong></div></div></div>
        </AgentDockPane>
      </DeliveryWorkspace>)]));`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => { throw Error('Delivery workspace presentation may not request data'); };
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, outfile: 'delivery-dock-fixture.js', define: {'process.env.NODE_ENV': '"production"'}});
    const javascript = outputFiles.find(file => file.path.endsWith('.js'));
    if (!javascript) throw Error('Delivery dock fixture did not emit JavaScript');
    const result = await import('data:text/javascript;base64,' + Buffer.from(javascript.text).toString('base64'));
    process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('actual right-dock workspace uses shared labelled tabs and inline headings, never a dialog', () => {
  for (const [page, html] of Object.entries(rendered)) {
    assert.match(html, new RegExp(`data-testid="delivery-workspace" data-page="${page}"`));
    assert.match(html, /aria-labelledby="delivery-workspace-heading"/);
    assert.match(html, /data-slot="tabs"/); assert.match(html, /data-slot="tabs-list"/); assert.match(html, /role="tablist"/);
    assert.match(html, /aria-label="成片交付页面"/); assert.equal((html.match(/role="tab"/g) || []).length, 2);
    assert.match(html, /本次导出/); assert.match(html, /导出记录/);
    assert.doesNotMatch(html, /role="dialog"|aria-modal=|modal-backdrop|data-slot="dialog/);
  }
  assert.match(rendered.compose, /<h2 id="delivery-workspace-heading">成片交付<\/h2>/);
  assert.match(rendered.compose, /切换到记录不会清除草稿/);
  assert.match(rendered.history, /<h2 id="delivery-workspace-heading">导出记录<\/h2>/);
  assert.match(rendered.history, /创建时的固定快照/); assert.match(rendered.history, /已命名成片保留原名称/);
});

test('controlled tab semantics link to App-owned panes and retain both child trees', () => {
  for (const [page, html] of Object.entries(rendered)) {
    const active = page === 'compose' ? 'delivery-compose-tab' : 'delivery-history-tab';
    const inactive = page === 'compose' ? 'delivery-history-tab' : 'delivery-compose-tab';
    const activeTab = html.match(new RegExp(`<button[^>]*id="${active}"[^>]*>`))?.[0];
    const inactiveTab = html.match(new RegExp(`<button[^>]*id="${inactive}"[^>]*>`))?.[0];
    assert.ok(activeTab); assert.ok(inactiveTab); assert.match(activeTab, /aria-selected="true"/); assert.match(inactiveTab, /aria-selected="false"/);
    assert.match(activeTab, new RegExp(`aria-controls="delivery-${page}-pane"`));
    assert.match(html, /id="delivery-compose-pane"[^>]*role="tabpanel"[^>]*aria-labelledby="delivery-compose-tab"/);
    assert.match(html, /id="delivery-history-pane"[^>]*role="tabpanel"[^>]*aria-labelledby="delivery-history-tab"/);
    assert.match(html, /retained-compose-draft/); assert.match(html, /value="  未提交草稿  "/); assert.match(html, /retained-history/);
    const hidden = html.match(new RegExp(`<div[^>]*id="delivery-${page === 'compose' ? 'history' : 'compose'}-pane"[^>]*>`))?.[0];
    assert.ok(hidden); assert.match(hidden, /hidden=""/); assert.match(hidden, /inert=""/); assert.match(hidden, /aria-hidden="true"/);
  }
});

test('actual component delegates valid page callbacks without local state, draft changes or implicit actions', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const element = (type, props, ...children) => ({ type, props: { ...props, children } });
  const react = { createElement: element }; react.default = react;
  const shared = { Tabs: 'Tabs', TabsList: 'TabsList', TabsTrigger: 'TabsTrigger' }, module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(module, module.exports,
    name => name === 'react' ? react : name === '@mioon/ui/components/tabs' ? shared : assert.fail(`Unexpected dependency: ${name}`));
  const changes = [], supplied = Object.freeze({ marker: 'App-owned retained panes' });
  const tree = module.exports.default({ page: 'compose', onPage: value => changes.push(value), children: supplied });
  const tabs = tree.props.children.find(child => child?.type === 'Tabs');
  assert.ok(tabs); assert.equal(tabs.props.value, 'compose'); assert.deepEqual(changes, []);
  tabs.props.onValueChange('history'); tabs.props.onValueChange('compose'); tabs.props.onValueChange('foreign'); tabs.props.onValueChange(null);
  assert.deepEqual(changes, ['history', 'compose']); assert.equal(tabs.props.value, 'compose', 'Only App can change the controlled page');
  const content = tabs.props.children.find(child => child?.props?.['data-testid'] === 'delivery-workspace-content');
  assert.equal(content.props.children[0], supplied, 'Children are forwarded without mapping, replacing, or remounting');
  assert.doesNotMatch(source, /useState|useEffect|useLayoutEffect|useRef|\bfetch\s*\(|\brpc\s*\(|sessionStorage|localStorage|createPortal|Dialog|Modal/);
  assert.doesNotMatch(source, /icons\.jsx|AgentWorkspace\.jsx|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck/);
});

test('unique dock styles keep headings and tabs fixed while each existing pane scrolls independently', () => {
  const css = readFileSync(path.join(root, 'apps/web/src/styles.css'), 'utf8');
  assert.match(css, /\.delivery-workspace\{[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css, /\.delivery-workspace-heading\{[^}]*flex:none/);
  assert.match(css, /\.delivery-workspace-tablist\{[^}]*flex:none/);
  assert.match(css, /\.delivery-workspace-content\{[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css, /\.delivery-workspace-content>\.right-dock-page\{[^}]*overflow:auto[^}]*overscroll-behavior:contain/);
  assert.match(css, /\.delivery-workspace-content>\.right-dock-page\[hidden\]\{display:none\}/);
  assert.match(css, /\.delivery-workspace \.export-card\{[^}]*grid-template-columns:32px minmax\(0,1fr\)/);
  assert.match(css, /\.delivery-workspace \.export-detail strong\{[^}]*overflow-wrap:anywhere/);
});
