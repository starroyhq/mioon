import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {BOARD_STATIC_EDGE_ZOOM_THRESHOLD, shouldUseStaticBoardEdges} from '../apps/web/src/board-ui/edge-motion.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

test('board static-edge threshold activates at or below 25% zoom and restores animations above 25%', () => {
  assert.equal(BOARD_STATIC_EDGE_ZOOM_THRESHOLD, 0.25);
  for (const zoom of [0.05, 0.135537, 0.2, 0.2499, 0.25]) {
    assert.equal(shouldUseStaticBoardEdges(zoom), true, `zoom ${zoom} should use static edges`);
  }
  for (const zoom of [0.2501, 0.26, 0.5, 0.75, 1, 1.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(shouldUseStaticBoardEdges(zoom), false, `zoom ${zoom} should keep animated edges`);
  }
});

test('edges.css stops animations under data-board-static-edges while preserving labels, dots, hit areas and compositor defaults', () => {
  const css = readFileSync(path.join(root, 'apps/web/src/board-ui/edges.css'), 'utf8');
  assert.match(css, /\[data-board-static-edges="true"\]\s*\.board-sequence-dot\s*,\s*\[data-board-static-edges="true"\]\s*\.board-reference-line\s*\{[^}]*animation:\s*none!important/u);
  assert.doesNotMatch(css, /\[data-board-static-edges="true"\][^{]*\.board-reference-label/u,
    'reference edge labels must remain visible at overview zoom');
  assert.doesNotMatch(css, /\[data-board-static-edges="true"\][^{]*visibility:\s*hidden/u,
    'static overview edges must not hide dots or labels');
  assert.doesNotMatch(css, /will-change:\s*transform/u,
    'avoid compositor promotion that regressed large-board pan performance');

  const boardCss = readFileSync(path.join(root, 'apps/web/src/board-ui/board-ui.css'), 'utf8');
  assert.doesNotMatch(boardCss, /will-change:\s*transform/u);

  const staticBoardSrc = readFileSync(path.join(root, 'apps/web/src/board-ui/BoardUiStatic.tsx'), 'utf8');
  assert.match(staticBoardSrc, /useStore\(state => shouldUseStaticBoardEdges\(state\.transform\[2\]\)\)/u,
    'subscribe only to the boolean threshold crossing so panning does not re-render');
  assert.match(staticBoardSrc, /data-board-static-edges=\{staticEdges \? 'true' : undefined\}/u);
});

test('BoardUiStatic omits data-board-static-edges at default 100% zoom and preserves all edge markup', async () => {
  const entry = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {I18nProvider, createLanguageStore} from './src/i18n/I18nProvider.tsx';
    import BoardUiStatic from './src/board-ui/BoardUiStatic.tsx';
    import {boardScene} from '../../tests/fixtures/board-ui-static/scenes.ts';
    export function renderStatic(reduceMotion = false) {
      const scene = boardScene();
      return renderToStaticMarkup(
        <I18nProvider store={createLanguageStore({systemLanguages: ['zh-Hans']})}>
          <BoardUiStatic
            projection={scene.projection}
            nodes={scene.nodes}
            edges={scene.edges}
            positions={scene.positions}
            reduceMotion={reduceMotion}
            onConnect={() => undefined}
            onAddShot={() => undefined}
          />
        </I18nProvider>,
      );
    }`;
  const result = await build({
    stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')},
    bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic',
    loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}, logLevel: 'silent',
  });
  const mod = {exports: {}};
  Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
  const {renderStatic} = mod.exports as {renderStatic(reduceMotion?: boolean): string};

  const normal = renderStatic(false);
  assert.ok(normal.includes('data-testid="board-ui-static"'));
  assert.equal(normal.includes('data-board-static-edges="true"'), false);
  const reduced = renderStatic(true);
  assert.ok(reduced.includes('data-reduce-motion="true"'));
});
