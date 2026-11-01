import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PANEL_BOUNDS } from '../apps/web/src/workspace-layout.ts';
import { timelineVisibleTracks } from '../apps/web/src/timeline-view-geometry.ts';
import type { PathLike } from 'fs';

const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');
const px = (pattern: RegExp, label: string) => { const value = css.match(pattern)?.[1]; assert.ok(value, `Missing ${label}`); return Number(value); };

test('the default timeline panel shows all four default tracks (subtitle, two video, audio) without scrolling', () => {
  const editing = read('timeline-editing.css');
  const tokens = readFileSync(new URL('../packages/ui/src/styles/globals.css', import.meta.url), 'utf8');
  const token = (name: string) => {const value = tokens.match(new RegExp(`--wb-${name}: (\\d+)px;`))?.[1]; assert.ok(value, `Missing ${name}`); return Number(value);};
  const toolbar = Number(editing.match(/\.edit-timeline-toolbar\{height:(\d+)px;/)?.[1]);
  const footnote = Number(editing.match(/\.timeline-footnote\{height:(\d+)px;/)?.[1]);
  assert.equal(toolbar, 36); assert.equal(footnote, 24);
  const video = token('track-video'), audio = token('track-audio'), subtitle = token('track-subtitle'), ruler = token('ruler');
  assert.deepEqual([video, audio, subtitle, ruler], [52, 44, 32, 24]);
  for (const kind of ['video', 'audio', 'subtitle']) assert.match(editing, new RegExp(`height:var\\(--wb-track-${kind}\\)`));
  assert.match(editing, /\.timeline-clip\{top:4px;height:calc\(100% - 8px\)/);
  assert.match(editing, /\.timeline-clip\.subtitle-cue\{[^}]*height:24px/);
  assert.ok(4 * 2 + 24 <= subtitle, 'Subtitle cues must fit inside the shortest row');
  // The toolbar replaces the old separate header; retain all populated lanes.
  const borders = 4, fullHeight = toolbar + ruler + subtitle + 2 * video + audio + footnote + borders;
  assert.ok(fullHeight <= PANEL_BOUNDS.timelineHeight.default, `${fullHeight}px exceeds the default panel height`);
  const tracks = [{id:'v2',kind:'video'}, {id:'v1',kind:'video'}, {id:'a1',kind:'audio'}];
  assert.strictEqual(timelineVisibleTracks(tracks, false), tracks, 'Saved/custom lanes must remain available after editing');
  assert.deepEqual(timelineVisibleTracks(tracks, true).map(track => track.id), ['v1', 'a1']);
  const empty = Number(editing.match(/\.edit-timeline-empty\{[^}]*min-height:(\d+)px;/)?.[1]);
  assert.ok(toolbar + ruler + video + audio + empty + footnote + borders <= PANEL_BOUNDS.timelineHeight.default, 'The pristine drop zones and empty prompt must also fit');
  assert.match(read('Timeline.tsx'), /const pristineEmpty = !timeline\?\.clips\?\.length && historyState\?\.length === 0/);
  assert.match(read('Timeline.tsx'), /timeline && !pristineEmpty && <SubtitleLane/);
});

test('the library search uses a drawn icon that cannot collide with the placeholder', () => {
  const library = read('AssetLibrary.tsx'), icons = read('icons.tsx');
  assert.match(library, /<Input aria-label=\{t\('assets.search'\)\}[\s\S]*?\/><Icon name="search" size=\{14\} \/>/);
  assert.doesNotMatch(library, /⌕/);
  assert.match(icons, /\n  search: </);
  assert.match(css, /\.asset-search>svg\{position:absolute;left:10px;top:50%;margin-top:-7px;[^}]*pointer-events:none\}/);
  // Input text starts after the icon (10px + 14px) with room to spare.
  assert.ok(px(/\.asset-search input\{padding:8px 9px 8px (\d+)px/, 'search input padding') >= 10 + 14 + 2);
});

test('the redesigned top bar keeps one explicit 44px row and puts language in settings', () => {
  assert.match(css, /\.shell-redesign \.workbench-topbar \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\); grid-template-rows: 1fr;/);
  assert.match(css, /\.workbench\.workbench-v2\.dock-workbench\.shell-redesign \{ grid-template-rows: var\(--wb-topbar\) minmax\(0, 1fr\)/);
  const shell = read('WorkbenchShell.tsx');
  assert.match(shell, /workbench-topbar-project/); assert.match(shell, /workbench-topbar-mode/);
  assert.doesNotMatch(shell, /LanguageControl/);
  assert.match(read('ProjectHomeConnections.tsx'), /<LanguageControl/);
});

test('no stylesheet or utility class sets text below the 10px floor', () => {
  const directory = new URL('../apps/web/src/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.css'))) {
    const text = readFileSync(new URL(file, directory), 'utf8');
    const small = [...text.matchAll(/(?<![\w-])font(?:-size)?\s*:\s*(\d*\.?\d+)px/g)].filter(match => Number(match[1]) < 10).map(match => match[0]);
    assert.deepEqual((small as unknown), [], `${file} sets text below 10px`);
  }
  for (const root of ['../apps/web/src/', '../packages/ui/src/']) {
    const walk = (url: URL): URL[] => readdirSync(url, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(new URL(`${entry.name}/`, url)) : /\.(jsx|tsx)$/.test(entry.name) ? [new URL(entry.name, url)] : []);
    for (const file of walk(new URL(root, import.meta.url))) {
      const small = [...readFileSync(file, 'utf8').matchAll(/text-\[(\d*\.?\d+)px\]/g)].filter(match => Number(match[1]) < 10).map(match => match[0]);
      assert.deepEqual((small as unknown), [], `${file.pathname} uses a utility text size below 10px`);
    }
  }
});

test('small controls keep 24px pointer targets, growing an invisible hit area where the visual stays smaller', () => {
  for (const rule of [/\.library-view-tabs button \{ min-height: 24px; \}/, /\.asset-tabs button \{ min-width: 24px; min-height: 24px;/, /\.asset-disposition-summary \.text-button \{ min-width: 24px; min-height: 24px; \}/,
    /\.asset-disposition-buttons > button,\n[^{]*\.asset-disposition-controls \.text-button \{ min-height: 24px; \}/, /\.track-label \[role="switch"\]::after \{ content: ""; position: absolute; inset: -6px -4px; \}/, /\.track-label \.subtitle-add::after \{ content: ""; position: absolute; inset: -2px -4px; \}/]) assert.match(css, rule);
  // The marks buttons are wrapped by a tooltip trigger that replaces data-slot="button", so their rules must not depend on it.
  const disposition = read('asset-disposition.css');
  assert.match(disposition, /\.asset-disposition-buttons > button \{/); assert.doesNotMatch(disposition, /\.asset-disposition-buttons \[data-slot="button"\]/);
});

test('image provider choices wrap at their separator rather than inside a word', () => {
  assert.match(css, /\.image-generation-provider-tabs > button \{ word-break: keep-all; \}/);
});
