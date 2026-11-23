import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {LOCALES, translate} from '../packages/i18n/src/index.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

interface Scenes {
  render(kind: 'strip'|'overview'|'floating', locale: Locale, state?: 'collapsed'|'empty'|'unknown'|'partial'): string;
  clock(frames: number): string;
  video(locale: Locale): string;
}
const root = fileURLToPath(new URL('../', import.meta.url));
let loaded: Promise<Scenes> | undefined;
function scenes(): Promise<Scenes> {
  return loaded ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import {BoardFilmOverview,BoardFilmStrip,BoardFloatingLabel,boardFrameTime} from './src/board-ui/BoardFilmComponents.tsx';
      import {boardScene} from '../../tests/fixtures/board-ui-static/scenes.ts';
      export const clock=boardFrameTime;
      export function video(locale){
        const projection=boardScene().projection;
        const film=projection.films[0];
        const items=film.items.map((item,index)=>index===0?{...item,thumbnailKind:'video'}:item);
        return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}><BoardFilmStrip film={{...film,items}} open selectedNodeId="shot-1" onOpenChange={()=>{}} onLocateNode={()=>{}} onAddShot={()=>{}}/></I18nProvider>);
      }
      export function render(kind,locale,state){
        const projection=boardScene().projection;
        const film=projection.films[0];
        const shown=state==='empty'?{...film,items:[],shotCount:0,durationFrames:0}:state==='unknown'?{...film,durationFrames:null,items:film.items.map(item=>({...item,durationFrames:null}))}:
          state==='partial'?{...film,durationFrames:1,items:[{...film.items[0],durationFrames:1}],shotCount:1}:film;
        const content=kind==='strip'?<BoardFilmStrip film={shown} open={state!=='collapsed'} selectedNodeId="shot-3" onOpenChange={()=>{}} onLocateNode={()=>{}} onAddShot={()=>{}}/>:
          kind==='overview'?<BoardFilmOverview overview={projection.overview}/>:<BoardFloatingLabel/>;
        return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>{content}</I18nProvider>);
      }`;
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')}, bundle: true,
      format: 'cjs', platform: 'node', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}});
    const module = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    return module.exports as Scenes;
  })();
}

test('film strip follows the chain and labels all four ordered locations and their durations', async () => {
  const render = await scenes();
  for (const locale of LOCALES) {
    const html = render.render('strip', locale);
    const ids = [...html.matchAll(/data-testid="board-film-item-([^"]+)"/gu)].map(match => match[1]);
    assert.deepEqual(ids, ['shot-1', 'shot-2', 'shot-3', 'shot-4']);
    assert.ok(html.includes(translate(locale, 'boardUi.shotCount', {count: 4})));
    assert.ok(html.includes(translate(locale, 'boardUi.synced')));
    assert.ok(html.includes(locale === 'en' ? '>15 s<' : '>15 秒<'));
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /data-testid="board-film-item-shot-3"[^>]*aria-pressed="true"/);
    assert.ok(html.includes(translate(locale, 'boardUi.locate', {name: '霓虹特写'})));
    assert.match(html, /class="board-film-duration">4s<\/span>/);
    assert.match(html, /class="board-film-duration">5s<\/span>/);
  }
});

test('collapsed strip hides the list and keeps a discoverable expansion action', async () => {
  const html = (await scenes()).render('strip', 'en', 'collapsed');
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Expand film strip"/);
  assert.match(html, /<div[^>]*hidden=""[^>]*class="board-film-strip-body"/);
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls);
  assert.ok(html.includes(`id="${controls}"`));
});

test('empty and unknown film data remain distinct and do not invent a known duration', async () => {
  const render = await scenes();
  const empty = render.render('strip', 'zh-Hans', 'empty');
  assert.ok(empty.includes(translate('zh-Hans', 'boardUi.empty')));
  assert.match(empty, /data-testid="board-film-add"/);
  assert.doesNotMatch(empty, /board-film-item-/);
  const unknown = render.render('strip', 'zh-Hans', 'unknown');
  assert.ok(unknown.includes(translate('zh-Hans', 'boardUi.durationUnknown')));
  assert.doesNotMatch(unknown, />0 秒<|>0s</);
});

test('seconds labels preserve a duration shorter than a second', async () => {
  const html = (await scenes()).render('strip', 'zh-Hans', 'partial');
  assert.match(html, />0\.03 秒<\/span>/);
  assert.match(html, /class="board-film-duration">0\.03s<\/span>/);
});

test('overview counts film shots and only flags the unconnected annotation as detached', async () => {
  const render = await scenes();
  for (const locale of LOCALES) {
    const html = render.render('overview', locale);
    const values = [...html.matchAll(/<dd>([^<]+)<\/dd>/gu)].map(match => match[1]);
    assert.deepEqual(values, ['4', '2', '1', '1', '1', '0:15']);
    assert.ok(html.includes(translate(locale, 'boardUi.overview.shots')));
    assert.ok(html.includes(translate(locale, 'boardUi.overview.duration')));
    assert.ok(render.render('floating', locale).includes(translate(locale, 'boardUi.floating')));
  }
});

test('frame clocks retain partial frames rather than rounding short clips to zero seconds', async () => {
  const {clock} = await scenes();
  assert.equal(clock(0), '0:00');
  assert.equal(clock(1), '0:00:01');
  assert.equal(clock(59), '0:01:29');
  assert.equal(clock(1800), '1:00');
});


test('video film thumbnails render through a video element instead of a broken image', async () => {
  const html = (await scenes()).video('zh-Hans');
  assert.match(html, /<video[^>]*src="data:image\/svg\+xml,/u);
  assert.match(html, /<video[^>]*muted=""[^>]*playsInline=""/u);
});
