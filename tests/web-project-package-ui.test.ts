import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
interface BuiltHome {render(props: Record<string, unknown>): string}
let built: BuiltHome;
function ui() {
  if (built) return built;
  const fixture = `import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ProjectHome from './src/ProjectHome.tsx';
    export const render = props => renderToStaticMarkup(<ProjectHome {...props} />);`;
  const result = buildSync({ stdin: { contents: fixture, loader: 'tsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const module = { exports: {} };
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return built = module.exports as BuiltHome;
}
const none = () => {};
const base = { phase: 'home', busy: false, listBusy: false, page: 'projects', onPage: none, onOpen: none, onRetry: none, onRefresh: none, onCreate: async () => true, settings: null };
const projects = [{ id: 'p1', name: 'UI 走查项目', updatedAt: '2026-10-21T06:32:00.000Z', lastOpenedAt: '2026-10-21T06:32:00.000Z' }, { id: 'p2', name: 'UI 走查项目（2）', updatedAt: '2026-10-21T06:33:00.000Z' }];

test('home header puts "导入项目…" left of the single create button and tags just-imported cards', () => {
  const html = ui().render({ ...base, projects, onImport: none, justImported: ['p2'] });
  const header = html.match(/<header class="project-home-header">([\s\S]*?)<\/header>/)![1];
  assert.ok(header.indexOf('project-home-import') >= 0 && header.indexOf('project-home-import') < header.indexOf('project-home-create-toggle'));
  assert.match(header, /导入项目…/);
  assert.equal((html.match(/data-testid="project-home-create-toggle"/g) || []).length, 1);
  assert.match(html, /data-testid="project-home-just-imported-p2"[^>]*>刚导入</);
  assert.doesNotMatch(html, /project-home-just-imported-p1/);
  assert.match(html, /class="project-home-recent"/);
});

test('empty home keeps a bare header and offers "或导入项目文件" under the primary button', () => {
  const html = ui().render({ ...base, projects: [], onImport: none });
  const header = html.match(/<header class="project-home-header">([\s\S]*?)<\/header>/)![1];
  assert.doesNotMatch(header, /project-home-import|project-home-create-toggle/);
  const empty = html.slice(html.indexOf('data-testid="project-home-empty"'));
  assert.ok(empty.indexOf('project-home-create-toggle') < empty.indexOf('project-home-import-empty'));
  assert.match(empty, /或导入项目文件/);
  assert.doesNotMatch(ui().render({ ...base, projects: [] }), /project-home-import/, 'no entry without an import handler (restored workspace)');
});

test('workbench project menu adds import, duplicate and export while new project stays last', () => {
  const app = read('apps/web/src/App.tsx');
  const start = app.indexOf('<DropdownMenuContent align="start" className="workbench-project-menu">');
  const menu = app.slice(start, app.indexOf('</DropdownMenuContent>', start));
  const order = ['projects.openWorkspace', 'project-menu-import', 'project-menu-duplicate', 'project-menu-export', 'panels-menu', 'export-button', 'new-project-menu'].map(token => menu.indexOf(token));
  assert.ok(order.every(index => index > 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(menu.lastIndexOf('<DropdownMenuItem') < menu.indexOf('new-project-menu'), 'new project remains the last menu item');
  assert.match(menu, /openExport\(\{ id: data\.project\.id, name: data\.project\.name \}, \{ unsaved: saveIsDirty \}\)/);
  assert.match(app, /<ProjectPackageLayer place="workbench"/);
});

test('home card menu inserts duplicate and export after rename and before delete', () => {
  const screen = read('apps/web/src/ProjectHomeScreen.tsx');
  const order = ["'redesign.projects.rename'", 'project-home-duplicate-', 'project-home-export-', '<DropdownMenuSeparator />', "'redesign.projects.delete'"].map(token => screen.indexOf(token));
  assert.ok(order.every(index => index > 0)); assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(screen, /<ProjectPackageLayer place="home"/);
  assert.match(screen, /project-home-drop-overlay/);
});

test('project file layer uses shared controls, a hidden file Input and no close button while running', () => {
  const layer = read('apps/web/src/ProjectPackageLayer.tsx');
  assert.doesNotMatch(layer, /<(?:button|textarea|select|input)\b/);
  assert.match(layer, /<Input ref=\{fileInput\} type="file" accept="\.mioon"/);
  assert.match(layer, /showCloseButton=\{!running\}/);
  assert.match(layer, /size="standard"/);
  for (const id of ['project-package-export-dialog', 'project-package-import-dialog', 'project-package-duplicate-dialog', 'project-package-toast']) assert.match(layer, new RegExp(id));
  assert.doesNotMatch(read('apps/web/src/ProjectHome.tsx'), /ProjectPackage|project-package-flow/);
});
