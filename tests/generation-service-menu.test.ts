import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {translate} from '../packages/i18n/src/index.ts';
import {generationServiceChoices} from '../apps/web/src/generation-service-choices.ts';
import type {GenerationProvider} from '../apps/web/src/generation-settings.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const t = (key: string, params?: Record<string, unknown>) => translate('zh-Hans', key as never, params as never);
const model = (id: string, name = id) => ({id, name, modelEntryId: `entry-${id}`});
const provider = (id: string, extra: Partial<GenerationProvider> = {}): GenerationProvider => ({id,
  status: 'available', enabled: true, configured: true, models: [model(`${id}-model`)], ...extra});

test('only available generation services appear; duplicates use the connection name', () => {
  const providers: GenerationProvider[] = [
    provider('minimax', {models: [model('minimax-built-in')]}),
    provider('minimax', {connectionId: 'connection-one', name: 'MiniMax', models: [model('minimax-connection')]}),
    provider('minimax', {connectionId: 'connection-two', name: 'MiniMax', models: [model('minimax-second')]}),
    provider('runway'),
    provider('minimax', {connectionId: 'connection-off', name: 'Off', status: 'not_configured'}),
    provider('mock', {mock: true, models: [model('mock-model')]}),
  ];
  const choices = generationServiceChoices(providers, t);
  assert.deepEqual([...new Set(choices.map(choice => choice.provider.id))].sort(), ['minimax', 'mock']);
  assert.equal(choices.some(choice => choice.provider.id === 'runway'
    || choice.provider.connectionId === 'connection-off'), false);
  const minimax = choices.filter(choice => choice.provider.id === 'minimax');
  assert.equal(new Set(minimax.map(choice => choice.label)).size, minimax.length);
  assert.ok(minimax.some(choice => choice.label.includes('内置服务')));
  assert.ok(minimax.some(choice => choice.label.includes('连接：MiniMax')));
  assert.ok(choices.some(choice => choice.provider.id === 'mock'
    && choice.label.includes(translate('zh-Hans', 'generation.provider.localSimulation'))));
});

test('a service with no usable model cannot appear as an empty dropdown entry', () => {
  assert.deepEqual(generationServiceChoices([{id: 'minimax', status: 'available', enabled: true,
    configured: true, models: []}], t), []);
});

interface Render { menu(locale: string, providers: GenerationProvider[]): string }
let loaded: Promise<Render> | undefined;
function renderer(): Promise<Render> {
  return loaded ??= (async () => {
    const entry = `import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {I18nProvider,createLanguageStore} from './src/i18n/I18nProvider.tsx';
      import GenerationServiceMenu from './src/GenerationServiceMenu.tsx';
      export function menu(locale, providers){
        return renderToStaticMarkup(<I18nProvider store={createLanguageStore({systemLanguages:[locale]})}>
          <GenerationServiceMenu providers={providers} menuClassName="menu" menuTestId="menu" itemTestIdPrefix="choice"
            onChoose={()=>{}} onOpenSettings={()=>{}}/></I18nProvider>);
      }`;
    const result = await build({stdin: {contents: entry, loader: 'tsx', resolveDir: path.join(root, 'apps/web')},
      bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic',
      loader: {'.css': 'empty'}, define: {'process.env.NODE_ENV': '"production"'}});
    const module = {exports: {}};
    Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
    return module.exports as Render;
  })();
}
test('an empty available-service list offers only the settings entry', async () => {
  const html = (await renderer()).menu('zh-Hans', []);
  assert.match(html, /data-testid="choice-open-settings"/u);
  assert.match(html, /去设置生成服务/u);
  assert.doesNotMatch(html, /data-testid="choice-minimax/u);
});


test('the board and 21-09 panel use the same service menu component', () => {
  const board = readFileSync(new URL('../apps/web/src/board-ui/BoardInspector.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../apps/web/src/edit-ui/GenerateInEditingPanel.tsx', import.meta.url), 'utf8');
  for (const source of [board, panel]) {
    assert.match(source, /import GenerationServiceMenu from '..\/GenerationServiceMenu.tsx'/u);
    assert.match(source, /<GenerationServiceMenu /u);
  }
});
