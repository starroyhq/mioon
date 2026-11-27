import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('packages/ui/src/styles/globals.css', root), 'utf8');
const controls = readFileSync(new URL('packages/ui/src/styles/workbench.css', root), 'utf8');
const tokenMatcher = /(--[\w-]+):\s*([^;]+);/g;
const tokenPairs = (source: string): [string,string][] => [...source.matchAll(tokenMatcher)].map((match): [string,string] => [match[1] ?? '', (match[2] ?? '').trim()]);
const tokens = new Map<string,string>(tokenPairs(css));
const color = (key: string): string => {
  const value = tokens.get(key);
  assert.ok(value, `Missing token ${key}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? color(alias[1]!) : value;
};
const luminance = (value: string): number => {
  assert.match(value, /^#[\da-f]{6}$/i);
  return [1, 3, 5].map((index: number) => parseInt(value.slice(index, index + 2), 16) / 255)
    .map((channel: number) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum: number, channel: number, index: number) => sum + channel * [.2126, .7152, .0722][index]!, 0);
};
const contrast = (foreground: string, background: string): number => {
  const values = [luminance(color(foreground)), luminance(color(background))].sort((a: number, b: number) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
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
  const light = new Map<string,string>([...tokens, ...tokenPairs(preview)]);
  const ratio = (foreground: string, background: string): number => { const values = [luminance(light.get(foreground) ?? ''), luminance(light.get(background) ?? '')].sort((a: number,b: number)=>b-a); return (values[0]!+.05)/(values[1]!+.05); };
  for (const background of ['--wb-bg','--wb-panel','--wb-card','--wb-raised','--wb-selected']) for (const foreground of ['--wb-text','--wb-soft','--wb-muted']) assert.ok(ratio(foreground,background)>=4.5, `${foreground}/${background}`);
  assert.ok(ratio('--wb-accent-foreground','--wb-accent')>=4.5);assert.ok(ratio('--wb-danger-foreground','--wb-danger-fill')>=4.5);
  for(const media of ['video','image','audio','subtitle'])assert.ok(ratio('--wb-media-text',`--wb-${media}`)>=9,media);
});

test('icons use unified 1.5px stroke width via workbench-icons without bare Unicode icon glyphs', () => {
  const wbIcons = readFileSync(new URL('packages/ui/src/components/workbench-icons.tsx', root), 'utf8');
  const appIcons = readFileSync(new URL('apps/web/src/icons.tsx', root), 'utf8');
  const pfIcons = readFileSync(new URL('apps/web/src/project-file/project-file-icons.tsx', root), 'utf8');
  assert.match(wbIcons, /WORKBENCH_ICON_STROKE_WIDTH\s*=\s*1\.5/);
  assert.match(controls, /svg\.lucide\s*\{\s*stroke-width:\s*1\.5;/);
  assert.match(controls, /details\s*>\s*summary::-webkit-details-marker\s*\{\s*display:\s*none;/);
  assert.match(appIcons, /from '@mioon\/ui\/components\/workbench-icons'/);
  assert.match(pfIcons, /from '@mioon\/ui\/components\/workbench-icons'/);
  assert.doesNotMatch(appIcons, /strokeWidth=["']?(?:1\.65|2|3)/);
  assert.doesNotMatch(pfIcons, /strokeWidth=["']?(?:1\.65|2|3)/);
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(new URL(`${entry.name}/`, dir)) : /\.(?:tsx|css)$/.test(entry.name) ? [new URL(entry.name, dir)] : [],
  );
  const forbidden = /[▱⌄⌃▸▾ⓘ⋯]/u;
  for (const file of walk(new URL('apps/web/src/', root))) {
    const body = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(body, forbidden, `${file.pathname} still uses a bare Unicode icon glyph`);
  }
});

test('single global 1.5px focus-visible ring uses inset offset in tight containers without competing resets', () => {
  const styles = readFileSync(new URL('apps/web/src/styles.css', root), 'utf8');
  const light = readFileSync(new URL('packages/ui/src/styles/light.css', root), 'utf8');
  assert.match(controls, /outline:\s*1\.5px solid var\(--wb-accent-line\);[\s\S]*?outline-offset:\s*1px;/);
  assert.match(controls, /\.topbar,[\s\S]*?outline:\s*1\.5px solid var\(--wb-accent-line\);[\s\S]*?outline-offset:\s*-2px;/);
  assert.doesNotMatch(styles, /button:focus-visible,a:focus-visible\{outline:2px/);
  assert.doesNotMatch(light, /:focus-visible\s*\{[\s\S]*?outline:\s*2px/);
});
