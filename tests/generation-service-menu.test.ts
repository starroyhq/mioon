import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {translate} from '../packages/i18n/src/index.ts';
import {defaultBoardGenerationOptions, generationServiceChoices, resolveBoardGenerationSelection} from '../apps/web/src/generation-service-choices.ts';
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
      import GenerationServiceMenu from './src/board-ui/GenerationServiceMenu.tsx';
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
  assert.match(board, /import GenerationServiceMenu from '\.\/GenerationServiceMenu.tsx'/u);
  assert.match(panel, /import GenerationServiceMenu from '\.\.\/board-ui\/GenerationServiceMenu.tsx'/u);
  for (const source of [board, panel]) assert.match(source, /<GenerationServiceMenu /u);
});

test('F2 default board service selection: sole service, else shot last-used if available, else unselected', () => {
  const minimax = provider('minimax', {connectionId: 'conn-mm', configurationRevision: 3, name: 'MiniMax', models: [model('hailuo-2.3')]});
  const kling = provider('kling', {connectionId: 'conn-kl', configurationRevision: 5, name: 'Kling', models: [model('kling-3.0')]});
  const mock = provider('mock', {mock: true, models: [model('mock-v1')]});
  const disabled = provider('vidu', {connectionId: 'conn-vd', enabled: false, status: 'disabled', models: [model('vidu-2')]});

  // Rule 1: only 1 available service -> select it by default
  const sole = resolveBoardGenerationSelection([disabled, minimax], {}, {id: 'shot-1'}, {shotId: 'shot-1', jobs: [], versions: []});
  assert.equal(sole.provider?.connectionId, 'conn-mm');
  assert.equal(sole.model, 'hailuo-2.3');
  assert.equal(sole.modelEntryId, 'entry-hailuo-2.3');

  // Rule 3: multiple available services (including Mock + real) with no shot history -> unselected (never auto-pick Mock)
  const freshMulti = resolveBoardGenerationSelection([mock, minimax], {}, {id: 'shot-1'}, {shotId: 'shot-1', jobs: [], versions: []});
  assert.equal(freshMulti.provider, undefined);
  assert.equal(freshMulti.model, '');

  // Rule 2: multiple available services + shot previously used Kling -> reuse Kling with current configurationRevision
  const historyJobs = [
    {
      shotId: 'shot-1',
      providerId: 'kling',
      model: 'kling-3.0',
      createdAt: '2026-11-24T12:00:00Z',
      snapshot: {executionBinding: {connectionId: 'conn-kl', providerId: 'kling', configurationRevision: 1, model: {id: 'entry-kling-3.0', modelId: 'kling-3.0'}}},
    },
    {
      shotId: 'shot-1',
      providerId: 'minimax',
      model: 'hailuo-2.3',
      createdAt: '2026-11-23T12:00:00Z',
      snapshot: {executionBinding: {connectionId: 'conn-mm', providerId: 'minimax', model: {id: 'entry-hailuo-2.3', modelId: 'hailuo-2.3'}}},
    },
  ];
  const lastUsed = resolveBoardGenerationSelection([minimax, kling], {}, {id: 'shot-1'}, {shotId: 'shot-1', jobs: historyJobs, versions: []});
  assert.equal(lastUsed.provider?.connectionId, 'conn-kl');
  assert.equal(lastUsed.provider?.configurationRevision, 5);
  assert.equal(lastUsed.model, 'kling-3.0');

  // Rule 2 -> Rule 3: last-used service was deleted/disabled while multiple other services remain -> unselected
  const deletedLast = defaultBoardGenerationOptions([mock, minimax, disabled], {
    shotId: 'shot-1',
    jobs: [{shotId: 'shot-1', providerId: 'vidu', createdAt: '2026-11-24T12:00:00Z', snapshot: {executionBinding: {connectionId: 'conn-vd', providerId: 'vidu'}}}],
  });
  assert.equal(deletedLast, null);

  // Explicit choice in session options overrides default
  const explicit = resolveBoardGenerationSelection([minimax, kling], {connectionId: 'conn-mm', providerId: 'minimax', model: 'hailuo-2.3', modelEntryId: 'entry-hailuo-2.3'}, {id: 'shot-1'}, {shotId: 'shot-1', jobs: historyJobs});
  assert.equal(explicit.provider?.connectionId, 'conn-mm');
});
