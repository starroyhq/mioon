import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('packages/ui/src/styles/globals.css', root), 'utf8');
const controls = readFileSync(new URL('packages/ui/src/styles/workbench.css', root), 'utf8');
const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
const color = key => {
  const value = tokens.get(key);
  assert.ok(value, `Missing token ${key}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? color(alias[1]) : value;
};
const luminance = value => {
  assert.match(value, /^#[\da-f]{6}$/i);
  return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
};
const contrast = (foreground, background) => {
  const values = [luminance(color(foreground)), luminance(color(background))].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
};

test('white action tokens remain separate from shadcn hover semantics', () => {
  assert.equal(color('--primary'), '#F2F3F5');
  assert.equal(color('--primary-foreground'), '#0B0C0E');
  assert.equal(tokens.get('--accent'), 'var(--wb-hover)');
  assert.equal(color('--accent'), '#2A2D33');
  assert.equal(color('--ring'), '#FFFFFF');
  assert.equal(tokens.get('--wb-control-compact'), '24px');
  assert.equal(tokens.get('--wb-control'), '28px');
  assert.equal(tokens.get('--wb-control-large'), '36px');
  assert.equal(tokens.get('--wb-topbar'), '44px');
  assert.equal(tokens.get('--wb-action-bar'), '48px');
  assert.equal(tokens.get('--wb-assets-width'), '260px');
  assert.equal(tokens.get('--wb-inspector-width'), '320px');
  assert.equal(tokens.get('--wb-timeline-height'), '300px');
  assert.equal(tokens.get('--wb-panel-rail'), '44px');
  assert.equal(tokens.get('--wb-panel-gap'), '6px');
  assert.doesNotMatch(css, /@media[^}]*prefers-color-scheme:\s*light/);
});

test('body, secondary and primary/danger action text meet contrast requirements', () => {
  for (const background of ['--wb-bg', '--wb-panel', '--wb-card', '--wb-raised']) {
    for (const foreground of ['--wb-text', '--wb-soft']) assert.ok(contrast(foreground, background) >= 4.5, `${foreground} / ${background}`);
  }
  assert.ok(contrast('--wb-accent-foreground', '--wb-accent') >= 4.5);
  assert.ok(contrast('--wb-danger-foreground', '--wb-danger-fill') >= 4.5);
  for (const media of ['video', 'image', 'audio', 'subtitle']) assert.ok(contrast('--wb-media-text', `--wb-${media}`) >= 9, media);
});

test('application styles use shared color tokens and all referenced wb tokens exist', () => {
  const directory = new URL('apps/web/src/', root);
  for (const file of readdirSync(directory).filter(file => file.endsWith('.css'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b/i, `${file} contains a private palette`);
    for (const [, name] of source.matchAll(/var\((--wb-[\w-]+)/g)) assert.ok(tokens.has(name), `${file}: ${name}`);
  }
  for (const [, name] of controls.matchAll(/var\((--wb-[\w-]+)/g)) assert.ok(tokens.has(name), name);
});

test('application button styling survives tooltip trigger slots and reduced motion', () => {
  assert.match(css, /@import "\.\/workbench.css"/);
  assert.match(controls, /\.wb-button\s*\{/);
  assert.doesNotMatch(controls, /\[data-slot="button"\]/);
  assert.match(controls, /\.wb-button:focus-visible/);
  assert.match(controls, /prefers-reduced-motion: reduce/);
  assert.match(controls, /\.wb-spinner \{ animation: none; \}/);
});


test('approved light tokens preserve readable text and semantic media colors', () => {
  const preview = readFileSync(new URL('packages/ui/src/styles/light.css', root), 'utf8');
  assert.match(preview, /:root\.light\s*\{/);
  assert.doesNotMatch(preview, /prefers-color-scheme/);
  const light = new Map([...tokens, ...[...preview.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()])]);
  const ratio = (foreground, background) => { const values = [luminance(light.get(foreground)), luminance(light.get(background))].sort((a,b)=>b-a); return (values[0]+.05)/(values[1]+.05); };
  for (const background of ['--wb-bg','--wb-panel','--wb-card','--wb-raised','--wb-selected']) for (const foreground of ['--wb-text','--wb-soft','--wb-muted']) assert.ok(ratio(foreground,background)>=4.5, `${foreground}/${background}`);
  assert.ok(ratio('--wb-accent-foreground','--wb-accent')>=4.5);assert.ok(ratio('--wb-danger-foreground','--wb-danger-fill')>=4.5);
  for(const media of ['video','image','audio','subtitle'])assert.ok(ratio('--wb-media-text',`--wb-${media}`)>=9,media);
});
