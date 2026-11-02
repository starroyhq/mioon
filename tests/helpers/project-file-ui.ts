import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import type { Locale } from '../../packages/i18n/src/index.ts';

/** Server rendering of the project file scene table (U1), for CI. Same scenes
 * as the screenshot gallery; Base UI dialogs and menus and the I18nProvider are
 * replaced by in-place stand-ins (tests/fixtures/project-file-ui/ssr-*.tsx). */
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = join(root, 'tests/fixtures/project-file-ui');
export type ProjectFileSceneGroup = 'home' | 'media' | 'versions-pack' | 'rules';
export interface ProjectFileSceneInfo {
  readonly id: string;
  readonly group: ProjectFileSceneGroup;
  readonly design: string;
  readonly state: string;
  readonly capture: 'page' | 'dialog' | 'frame';
}
export interface ProjectFileScenes {
  readonly list: readonly ProjectFileSceneInfo[];
  render(id: string, locale: Locale): string;
}
// esbuild runs the filters as Go regular expressions, which take no flags.
const standIns: Plugin = {
  name: 'project-file-ui-ssr',
  setup(build) {
    build.onResolve({ filter: /^@mioon\/ui\/components\/(?:dialog|dropdown-menu)$/ }, () => ({ path: join(fixtures, 'ssr-overlays.tsx') }));
    build.onResolve({ filter: /\/i18n\/I18nProvider\.tsx$/ }, () => ({ path: join(fixtures, 'ssr-i18n.tsx') }));
  },
};
let built: Promise<ProjectFileScenes> | undefined;
/** The sample data's clock is in +08:00 and the screenshots are taken in this
 * zone, so dates and "today" read the same on every machine. Each test file runs
 * in its own process, so pinning it here touches no other test. */
export const SCENE_TIME_ZONE = 'Asia/Shanghai';
/** Bundled once per process. Plugins need esbuild's asynchronous API. */
export function projectFileScenes(): Promise<ProjectFileScenes> {
  process.env.TZ = SCENE_TIME_ZONE;
  return built ??= bundle();
}
async function bundle(): Promise<ProjectFileScenes> {
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
    import { scenes } from ${JSON.stringify(join(fixtures, 'scenes.tsx'))};
    import { setLocale } from ${JSON.stringify(join(fixtures, 'ssr-i18n.tsx'))};
    export const list = scenes.map(({ id, group, design, state, capture }) => ({ id, group, design, state, capture }));
    export function render(id, locale) {
      const scene = scenes.find(item => item.id === id);
      if (!scene) throw new Error('Unknown scene: ' + id);
      setLocale(locale);
      return renderToStaticMarkup(scene.render());
    }`;
  const result = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: join(root, 'apps/web') }, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, nodePaths: [join(root, 'apps/web/node_modules')], plugins: [standIns] });
  const module = { exports: {} };
  Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports as ProjectFileScenes;
}

interface CapturedScene { readonly id: string; readonly design: string; readonly file: string; readonly bytes: number; readonly errors: readonly string[] }
export const SCREENSHOT_MAX_BYTES = 95_000;
/** The committed screenshots of a group match the scene table: one file per
 * scene, each under the size limit and captured without errors, nothing else
 * in the folder, and the README names every preview and file. */
export async function assertGroupEvidence(group: ProjectFileSceneGroup): Promise<void> {
  const directory = join(root, 'docs/verification/project-file-ui', group);
  const results = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')) as { group: string; scenes: CapturedScene[] };
  assert.equal(results.group, group);
  const expected = (await projectFileScenes()).list.filter(scene => scene.group === group).map(scene => scene.id).sort();
  assert.deepEqual(results.scenes.map(scene => scene.id).sort(), expected, `${group}: screenshots and scene table differ`);
  for (const scene of results.scenes) {
    const size = statSync(join(directory, scene.file)).size;
    assert.equal(size, scene.bytes, scene.file);
    assert.ok(size < SCREENSHOT_MAX_BYTES, `${scene.file}: ${size} bytes`);
    assert.deepEqual(scene.errors, [], scene.id);
  }
  const allowed = new Set(['README.md', 'results.json', ...results.scenes.map(scene => scene.file)]);
  assert.deepEqual(readdirSync(directory).filter(name => !allowed.has(name)), [], `${group}: unlisted files`);
  const readme = readFileSync(join(directory, 'README.md'), 'utf8');
  for (const scene of results.scenes) {
    assert.ok(readme.includes(scene.file), `README lacks ${scene.file}`);
    assert.ok(readme.includes(scene.design), `README lacks ${scene.design}`);
  }
}

/** The opening tag of the element with this `data-testid`, or null. */
export function tagOf(html: string, testId: string): string | null {
  return new RegExp(`<[a-z][a-z0-9]*\\b[^>]*\\bdata-testid="${testId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"[^>]*>`, 'u').exec(html)?.[0] ?? null;
}
/** Text as `renderToStaticMarkup` escapes it. */
export function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#x27;');
}
