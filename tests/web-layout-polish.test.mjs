import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PANEL_BOUNDS } from '../apps/web/src/workspace-layout.js';

const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');
const px = (pattern, label) => { const value = css.match(pattern)?.[1]; assert.ok(value, `Missing ${label}`); return Number(value); };

test('the default timeline panel shows all four default tracks (subtitle, two video, audio) without scrolling', () => {
  const header = px(/\.dock-workbench:not\(\.dock-narrow\) \.timeline-header \{ height: (\d+)px; \}/, 'dock timeline header height');
  const toolbar = px(/\.dock-workbench:not\(\.dock-narrow\) \.timeline-toolbar \{ height: (\d+)px;/, 'dock timeline toolbar height');
  const track = px(/\.dock-workbench:not\(\.dock-narrow\) \.timeline-track \{ height: (\d+)px; \}/, 'dock track height');
  const footnote = px(/\.dock-workbench:not\(\.dock-narrow\) \.timeline-footnote \{ height: (\d+)px; \}/, 'dock footnote height');
  const ruler = px(/\.timeline-ruler-row\{display:flex;height:(\d+)px/, 'ruler row height');
  const clip = css.match(/\.dock-workbench:not\(\.dock-narrow\) \.timeline-clip \{ top: (\d+)px; height: (\d+)px; \}/);
  assert.ok(clip, 'Missing dock clip geometry');
  assert.ok(Number(clip[1]) * 2 + Number(clip[2]) <= track + 1, 'A clip must fit inside its track row');
  // Header, toolbar, ruler and footnote each carry a one pixel rule; the panel itself has a top border.
  const borders = 4, tracks = 4;
  assert.ok(header + toolbar + ruler + tracks * track + footnote + borders <= PANEL_BOUNDS.timelineHeight.default,
    `${header} + ${toolbar} + ${ruler} + ${tracks}×${track} + ${footnote} exceeds the ${PANEL_BOUNDS.timelineHeight.default}px default`);
});

test('the library search uses a drawn icon that cannot collide with the placeholder', () => {
  const library = read('AssetLibrary.jsx'), icons = read('icons.jsx');
  assert.match(library, /<Input aria-label=\{t\('assets.search'\)\}[\s\S]*?\/><Icon name="search" size=\{14\} \/>/);
  assert.doesNotMatch(library, /⌕/);
  assert.match(icons, /\n  search: </);
  assert.match(css, /\.asset-search>svg\{position:absolute;left:10px;top:50%;margin-top:-7px;[^}]*pointer-events:none\}/);
  // Input text starts after the icon (10px + 14px) with room to spare.
  assert.ok(px(/\.asset-search input\{padding:8px 9px 8px (\d+)px/, 'search input padding') >= 10 + 14 + 2);
});

test('the narrow top bar keeps language and status in explicit rows without an implicit third row', () => {
  assert.match(css, /\.dock-workbench\.dock-narrow \.topbar \{ grid-template-columns: auto minmax\(0,1fr\) auto auto; grid-template-rows: 28px 30px;/);
  assert.match(css, /\.dock-workbench\.dock-narrow \.topbar-status \{ grid-row: 2; grid-column: 3;/);
  assert.match(css, /\.dock-workbench\.dock-narrow \.topbar > \.language-control \{ grid-row: 1; grid-column: 3 \/ span 2;/);
  // The geometry hook measures the header at a fixed 82px, so the narrow rows must not grow.
  assert.match(css, /\.workbench\.workbench-v2\.dock-workbench\.dock-narrow\{grid-template-rows:82px minmax\(0,1fr\) 42px\}/);
});

test('no stylesheet or utility class sets text below the 10px floor', () => {
  const directory = new URL('../apps/web/src/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.css'))) {
    const text = readFileSync(new URL(file, directory), 'utf8');
    const small = [...text.matchAll(/(?<![\w-])font(?:-size)?\s*:\s*(\d*\.?\d+)px/g)].filter(match => Number(match[1]) < 10).map(match => match[0]);
    assert.deepEqual(small, [], `${file} sets text below 10px`);
  }
  for (const root of ['../apps/web/src/', '../packages/ui/src/']) {
    const walk = url => readdirSync(url, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(new URL(`${entry.name}/`, url)) : /\.(jsx|tsx)$/.test(entry.name) ? [new URL(entry.name, url)] : []);
    for (const file of walk(new URL(root, import.meta.url))) {
      const small = [...readFileSync(file, 'utf8').matchAll(/text-\[(\d*\.?\d+)px\]/g)].filter(match => Number(match[1]) < 10).map(match => match[0]);
      assert.deepEqual(small, [], `${file.pathname} uses a utility text size below 10px`);
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
