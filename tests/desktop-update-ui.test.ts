import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DESKTOP_UPDATE_RELEASES} from '../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateOffer, DesktopUpdateState, DesktopUpdateView} from '../packages/contracts/src/desktop-update.ts';
import {escapeHtml, tagOf} from './helpers/project-file-ui.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'tests/fixtures/project-file-ui');
const web = path.join(root, 'apps/web');
const result = await build({
  stdin: {resolveDir: web, loader: 'tsx', contents: `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {DesktopUpdateDialog} from './src/DesktopUpdate.tsx';
    export function render(view, feedback) {
      const noop = () => {};
      return renderToStaticMarkup(<DesktopUpdateDialog view={view} feedback={feedback ?? null} pending={new Set()}
        dismiss={noop} check={noop} download={noop} cancel={noop} install={noop} />);
    }`},
  platform: 'node', format: 'cjs', bundle: true, write: false, jsx: 'automatic',
  nodePaths: [path.join(web, 'node_modules')],
  loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'},
  plugins: [{
    name: 'desktop-update-ssr',
    setup(build) {
      build.onResolve({filter: /^@mioon\/ui\/components\/dialog$/}, () => ({path: path.join(fixtures, 'ssr-overlays.tsx')}));
      build.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: path.join(fixtures, 'ssr-i18n.tsx')}));
    },
  }],
});
const module = {exports: {}};
Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
const {render} = module.exports as {render(view: DesktopUpdateView, feedback?: string): string};
const offer: DesktopUpdateOffer = {currentVersion: '0.2.0', version: '0.2.1', releaseDate: '2026-11-20T12:00:00Z', sizeBytes: 240_000_000,
  notes: ['修复画布整理', '<b>不是 HTML</b>', '改进设置速度', '第四条仅在完整说明显示']};
const quiet = {exports: false, generations: false};
const view = (state: DesktopUpdateState, activity = quiet): DesktopUpdateView => ({revision: 1, currentVersion: offer.currentVersion, state, notice: null, activity});

test('available renders actual version, metadata, bounded escaped notes and the exact Release URL', () => {
  const html = render(view({kind: 'available', offer}));
  assert.match(html, /Mioon 0\.2\.1 可以更新了/);
  assert.match(html, /当前 0\.2\.0.+11月20日发布.+约 240 MB/);
  assert.match(html, /修复画布整理/);
  assert.ok(html.includes(escapeHtml(offer.notes[1]!)));
  assert.doesNotMatch(html, /<b>|第四条仅/);
  assert.match(html, /稍后.+下载并安装/);
  const link = tagOf(html, 'desktop-update-full-notes');
  assert.ok(link?.includes(`href="${DESKTOP_UPDATE_RELEASES}/tag/v0.2.1"`) && link.includes('target="_blank"') && link.includes('rel="noreferrer"'));
  const invalid = render(view({kind: 'available', offer: {...offer, version: '0.2.1?unsafe'}}));
  assert.equal(tagOf(invalid, 'desktop-update-full-notes'), null);
});

test('downloading renders exact progress, remaining time, cancel and continue in background', () => {
  const html = render(view({kind: 'downloading', offer, percent: 46.7, secondsRemaining: 60, transferredBytes: 112_000_000, totalBytes: 240_000_000}));
  assert.match(html, /正在下载 Mioon 0\.2\.1/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="46\.7"/);
  assert.match(html, /112 \/ 240 MB · 46%/);
  assert.match(html, /还要约 1 分钟/);
  assert.match(html, /取消下载.+在后台下载/);
  const unknown = render(view({kind: 'downloading', offer, percent: 4, secondsRemaining: null}));
  assert.match(unknown, />4%</);
  assert.doesNotMatch(unknown, /还要约| NaN| MB/);
});

test('downloaded with no active work offers install on quit and restart without an interruption warning', () => {
  const html = render(view({kind: 'ready', offer, installOnQuit: false}));
  assert.match(html, /Mioon 0\.2\.1 已准备好/);
  assert.match(html, /项目会自动重新打开/);
  assert.match(html, /退出时安装.+立即重启/);
  assert.doesNotMatch(html, /正在导出|仍然重启|生成任务/);
});

test('downloaded warns about running exports and distinguishes resumable provider generation', () => {
  const html = render(view({kind: 'ready', offer, installOnQuit: false}, {exports: true, generations: true}));
  assert.match(html, /正在导出，现在重启会中断导出/);
  assert.match(html, /生成任务不受影响，重启后会接着取结果/);
  assert.match(html, /退出时安装.+仍然重启/);
  const unsaved = render(view({kind: 'ready', offer, installOnQuit: false}), 'notSaved');
  assert.match(unsaved, /role="alert".+请先保存打开项目中的编辑/);
});

test('manual check renders checking, current version and safe check failure actions', () => {
  assert.match(render(view({kind: 'checking'})), /正在检查更新…/);
  assert.match(render(view({kind: 'idle'})), /已是最新版本.+Mioon 0\.2\.0 是目前最新的正式版/);
  const failure = render(view({kind: 'failed', stage: 'check'}));
  assert.match(failure, /检查更新失败.+连不上 GitHub/);
  assert.match(failure, /去网站下载.+重试/);
  assert.ok(tagOf(failure, 'desktop-update-website')?.includes(`href="${DESKTOP_UPDATE_RELEASES}/latest"`));
});

test('download failure renders checksum guidance, retry and the fixed website instead of a downloaded URL', () => {
  const html = render(view({kind: 'failed', stage: 'download', offer}));
  assert.match(html, /下载没有完成.+校验不通过/);
  assert.match(html, /去网站下载.+重试/);
  assert.ok(tagOf(html, 'desktop-update-website')?.includes(`href="${DESKTOP_UPDATE_RELEASES}/latest"`));
  assert.equal(tagOf(html, 'desktop-update-full-notes'), null);
});

test('disabled update capability renders no modal', () => {
  assert.equal(render(view({kind: 'disabled'})), '');
});
