import { rulerFrameForKey } from '../apps/web/src/timeline-keyboard.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ui = resolve(root, 'packages/ui');
const read = path => readFileSync(resolve(ui, path), 'utf8');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const manifest = JSON.parse(read('src/registry/base-nova/manifest.json'));
const component = name => read(`src/components/${name}.tsx`);

// Reproduce only the documented registry installation substitutions. This
// protects against replacing official shadcn components with local lookalikes.
function installRegistrySource(source) {
  let result = source
    .replaceAll('from "cn"', 'from "@video-workbench/ui/lib/utils"')
    .replaceAll('@/registry/base-nova/ui/', '@video-workbench/ui/components/');
  const icons = [...new Set([...result.matchAll(/lucide="([^"]+)"/g)].map(match => match[1]))].sort();
  if (icons.length) {
    result = result.replace(
      'import { IconPlaceholder } from "@/app/(create)/components/icon-placeholder"',
      `import { ${icons.join(', ')} } from "lucide-react"`,
    );
    result = result.replace(/<IconPlaceholder\b([\s\S]*?)\/>/g, (_, attributes) => {
      const name = attributes.match(/lucide="([^"]+)"/)[1];
      const rest = attributes.replace(/\s+(?:lucide|tabler|hugeicons|phosphor|remixicon)="[^"]+"/g, '');
      return rest.trim() ? `<${name}${rest} />` : `<${name} />`;
    });
  }
  return result;
}

test('all fifteen shadcn base-nova components match the pinned official source', async t => {
  assert.equal(manifest.style, 'base-nova');
  assert.equal(manifest.primitiveLibrary, '@base-ui/react');
  assert.match(manifest.hashDefinitions.registrySha256, /local serialized registry JSON/);
  assert.match(manifest.hashDefinitions.sourceSha256, /decoded embedded TSX/);
  assert.equal(manifest.components.length, 15);
  for (const item of manifest.components) {
    await t.test(item.name, () => {
      assert.equal(item.registryUrl, `https://ui.shadcn.com/r/styles/base-nova/${item.name}.json`);
      const raw = read(`src/registry/base-nova/${item.name}.json`);
      assert.equal(sha256(raw), item.registrySha256);
      const registry = JSON.parse(raw);
      const upstream = registry.files.find(file => file.path === item.upstreamPath)?.content;
      assert.ok(upstream, 'registry contains the original source file');
      assert.equal(sha256(upstream), item.sourceSha256);
      const installed = component(item.name);
      assert.equal(installed, installRegistrySource(upstream));
      assert.equal(sha256(installed), item.vendoredSha256);
      assert.doesNotMatch(installed, /IconPlaceholder|@\/registry\/|from "cn"|@radix-ui/);
    });
  }
});

test('behavioral components use real Base UI primitives', () => {
  const primitives = {
    button: 'button', input: 'input', select: 'select', dialog: 'dialog',
    'dropdown-menu': 'menu', tabs: 'tabs', switch: 'switch',
    collapsible: 'collapsible', tooltip: 'tooltip',
    'scroll-area': 'scroll-area', separator: 'separator', slider: 'slider',
  };
  for (const [name, primitive] of Object.entries(primitives)) {
    assert.ok(component(name).includes(`from "@base-ui/react/${primitive}"`), name);
  }
  assert.match(component('badge'), /@base-ui\/react\/use-render/);
  assert.match(component('badge'), /@base-ui\/react\/merge-props/);
  assert.match(component('label'), /<label/);
  assert.match(component('textarea'), /<textarea/);
});

test('dialog, select and menu preserve primitive portals and accessible composition', () => {
  assert.match(component('dialog'), /<DialogPrimitive\.Portal/);
  assert.match(component('dialog'), /<DialogPrimitive\.Title/);
  assert.match(component('dialog'), /<DialogPrimitive\.Description/);
  assert.match(component('dialog'), /<DialogPrimitive\.Close/);
  assert.match(component('dialog'), /className="sr-only">Close/);
  assert.match(component('select'), /<SelectPrimitive\.Portal/);
  assert.match(component('select'), /<SelectPrimitive\.ItemIndicator/);
  assert.match(component('dropdown-menu'), /<MenuPrimitive\.Portal/);
  assert.match(component('dropdown-menu'), /<MenuPrimitive\.RadioItem/);
  assert.match(component('tabs'), /<TabsPrimitive\.Tab/);
  assert.match(component('tabs'), /<TabsPrimitive\.Panel/);
  assert.match(component('switch'), /<SwitchPrimitive\.Thumb/);
  assert.match(component('tooltip'), /<TooltipPrimitive\.Portal/);
  assert.match(component('scroll-area'), /<ScrollAreaPrimitive\.Viewport/);
});

test('Tailwind scans both workspace components and renderer sources and maps Base UI state', () => {
  const css = read('src/styles/globals.css');
  assert.match(css, /@import "tailwindcss" source\(none\)/);
  assert.match(css, /@import "tw-animate-css"/);
  assert.match(css, /@source "\.\.\/components\/\*\*\/\*/);
  assert.match(css, /@source "\.\.\/\.\.\/\.\.\/\.\.\/apps\/web\/src\/\*\*\/\*/);
  assert.match(css, /@custom-variant data-horizontal .*data-orientation="horizontal"/);
  assert.match(css, /@custom-variant data-vertical .*data-orientation="vertical"/);
  for (const state of ['open', 'closed', 'checked', 'unchecked', 'disabled', 'active']) {
    assert.ok(css.includes(`@custom-variant data-${state} `));
  }
  assert.match(css, /--primary: #d7e6aa;/);
  assert.match(css, /--primary-foreground: #24291a;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('shared package config supports official Base UI registry installation', () => {
  const config = JSON.parse(read('components.json'));
  assert.equal(config.style, 'base-nova');
  assert.equal(config.rsc, false);
  assert.equal(config.tsx, true);
  assert.equal(config.iconLibrary, 'lucide');
  assert.equal(config.aliases.ui, '@video-workbench/ui/components');
  assert.equal(config.aliases.utils, '@video-workbench/ui/lib/utils');
  assert.equal(config.tailwind.css, 'src/styles/globals.css');
  assert.equal(config.tailwind.cssVariables, true);
  assert.match(read('src/lib/utils.ts'), /twMerge\(clsx\(inputs\)\)/);
  for (const file of readdirSync(resolve(ui, 'src/components'))) {
    if (file.endsWith('.tsx')) assert.doesNotMatch(read(`src/components/${file}`), /@radix-ui/);
  }
});

test('shadcn MIT copyright and permission notice travel with the vendored source', () => {
  const license = read('src/LICENSE.shadcn.md');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2023 shadcn/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('installed Base UI components render semantic controls with real runtime dependencies', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import { Button } from './src/components/button';
    import { Input } from './src/components/input';
    import { Label } from './src/components/label';
    import { Switch } from './src/components/switch';
    import { Tabs, TabsList, TabsTrigger, TabsContent } from './src/components/tabs';
    import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './src/components/collapsible';
    import { Slider } from './src/components/slider';
    export const html = renderToStaticMarkup(<div>
      <Button disabled aria-label="Save">Save</Button>
      <Label htmlFor="title">Title</Label><Input id="title" defaultValue="Example" />
      <Switch checked aria-label="Audio enabled" />
      <Tabs defaultValue="shots"><TabsList><TabsTrigger value="shots">Shots</TabsTrigger><TabsTrigger value="assets">Assets</TabsTrigger></TabsList><TabsContent value="shots">Shot panel</TabsContent><TabsContent value="assets">Asset panel</TabsContent></Tabs>
      <Collapsible defaultOpen><CollapsibleTrigger>Details</CollapsibleTrigger><CollapsibleContent>Open content</CollapsibleContent></Collapsible>
      <Slider value={[20]} aria-label="Zoom" />
    </div>);
  `;
  // A short-lived child avoids leaving React's browser-SSR scheduling handles
  // alive in node:test. No fixtures or build products are written into the repo.
  const script = `
    import { build } from 'esbuild';
    import assert from 'node:assert/strict';
    const { outputFiles } = await build({
      stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(ui)} },
      bundle: true, format: 'esm', platform: 'browser', write: false,
      define: { 'process.env.NODE_ENV': '\"production\"' },
    });
    const { html } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    for (const expected of [
      'aria-label="Save"', 'disabled=""', 'for="title"', 'id="title"',
      'role="switch"', 'aria-checked="true"', 'role="tablist"',
      'role="tab"', 'role="tabpanel"', 'aria-selected="true"',
      'aria-expanded="true"', 'type="range"', 'value="20"',
    ]) assert.ok(html.includes(expected), 'Missing primitive markup: ' + expected);
    process.stdout.write('Base UI runtime markup verified');
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ['--input-type=module'], {
    cwd: root, input: script, encoding: 'utf8', timeout: 30_000,
  });
  assert.match(output, /Base UI runtime markup verified/);
});

test('renderer uses shared components for ordinary controls and modal confirmations', () => {
  const renderer = resolve(root, 'apps/web/src');
  for (const name of readdirSync(renderer).filter(name => name.endsWith('.jsx'))) {
    const source = readFileSync(resolve(renderer, name), 'utf8');
    assert.doesNotMatch(source, /<(?:button|input|textarea|select)\b/, `${name} must consume shared controls`);
    assert.doesNotMatch(source, /window\.confirm\(/, `${name} must use the cancellable confirmation provider`);
  }
  const app = readFileSync(resolve(renderer, 'App.jsx'), 'utf8');
  const main = readFileSync(resolve(renderer, 'main.jsx'), 'utf8');
  assert.match(main, /<ConfirmationProvider>/);
  assert.match(app, /async function inspect\(/);
  assert.match(app, /async function selectClip\(/);
  assert.match(app, /if \(!await inspect\(shot\.id\)\) return;/);
  assert.match(app, /if \(await inspect\(job\.shotId/);
  assert.match(app, /<DialogTitle>生成任务<\/DialogTitle>/);
  assert.match(app, /<DropdownMenuContent/);
  assert.match(app, /<TabsContent value="canvas" keepMounted/);
  assert.match(app, /<TabsContent value="preview" keepMounted/);
  assert.match(app, /<CollapsibleContent keepMounted className="inspector-region-content"/);
});

test('confirmation dismissal and concurrent requests never imply approval', () => {
  const source = component('workbench-confirm');
  assert.match(source, /if \(pending\.current\) return Promise\.resolve\(false\)/);
  assert.match(source, /pending\.current\?\.\(false\)/);
  assert.match(source, /if \(!open\) settle\(false\)/);
  assert.match(source, /initialFocus=\{cancel\}/);
  assert.match(source, /ref=\{cancel\}[^>]+onClick=\{\(\) => settle\(false\)\}/);
  assert.match(source, /onClick=\{\(\) => settle\(true\)\} data-testid="confirm-action"/);
  assert.match(source, /pending\.current = null[\s\S]*resolve\?\.\(answer\)/);
  assert.doesNotMatch(source, /setTimeout|window\.confirm/);
});

test('timeline retains specialized positioning and accessible Base UI controls', () => {
  const source = readFileSync(resolve(root, 'apps/web/src/Timeline.jsx'), 'utf8');
  assert.match(source, /value=\{\[pixelsPerSecond\]\}/);
  assert.match(source, /aria-labelledby="timeline-zoom-label"/);
  assert.match(source, /<Switch[^>]+checked=\{!track\.hidden\}/);
  assert.match(source, /<Switch[^>]+checked=\{track\.muted\}/);
  assert.match(source, /left: clip\.startFrame \* pxFrame/);
  assert.match(source, /width: Math\.max\(8, clip\.durationFrames \* pxFrame\)/);
  assert.match(source, /setData\(CLIP_DRAG, JSON\.stringify\(\{ id: clip\.id, grabFrame \}\)\)/);
});


test('timeline ruler keyboard navigation stays inside integer-frame bounds', () => {
  for (const key of ['ArrowRight', 'ArrowUp']) assert.equal(rulerFrameForKey(key, 18000), 18000);
  for (const key of ['ArrowLeft', 'ArrowDown']) assert.equal(rulerFrameForKey(key, 0), 0);
  assert.equal(rulerFrameForKey('PageUp', 17990), 18000);
  assert.equal(rulerFrameForKey('PageDown', 12), 0);
  assert.equal(rulerFrameForKey('PageUp', 12), 42);
  assert.equal(rulerFrameForKey('PageDown', 100), 70);
  assert.equal(rulerFrameForKey('Home', 15000), 0);
  assert.equal(rulerFrameForKey('End', 1), 18000);
  assert.equal(rulerFrameForKey('ArrowRight', 11.7), 13);
  assert.equal(rulerFrameForKey('ArrowLeft', Number.NaN), 0);
  for (const key of ['Tab', 'Escape', 'Enter', 'a']) assert.equal(rulerFrameForKey(key, 100), null);
});


test('project menu labels are grouped for Base UI MenuGroupContext', () => {
  const app = readFileSync(resolve(root, 'apps/web/src/App.jsx'), 'utf8');
  assert.match(app, /<DropdownMenuGroup><DropdownMenuLabel>你的项目<\/DropdownMenuLabel>/);
  assert.match(app, /<\/DropdownMenuGroup><DropdownMenuSeparator/);
});


test('legacy button reset does not override shared semantic foreground colors', () => {
  const css = readFileSync(resolve(root, 'apps/web/src/styles.css'), 'utf8');
  assert.match(css, /button:not\(\[data-slot\]\)\{color:inherit\}/);
  assert.doesNotMatch(css, /(?:^|})button\{[^}]*color:inherit/);
});
