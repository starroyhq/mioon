import {testEnv} from './helpers/test-env.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('provider settings show real selection and only disclose legacy setup on the web', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ProviderSettings from './ProviderSettings.tsx';
    const capabilities = { id: 'local-model', name: 'Local model', inputModes: ['text'], durations: [4, 8], aspectRatios: ['9:16'] };
    const base = { id: 'example', name: 'Example', modelCapabilities: [capabilities], configuration: {
      missing: ['EXAMPLE_API_KEY', 'EXAMPLE_OUTPUT_HOSTS', 'EXAMPLE_API_KEY', ' EXAMPLE_OUTPUT_HOSTS '],
      requirements: ['Long server-only setup instructions', 'Long server-only setup instructions'],
    } };
    const render = (provider, showEnvironmentSetup) => renderToStaticMarkup(<ProviderSettings providers={[base]} provider={provider} model={provider ? capabilities.id : ''} showEnvironmentSetup={showEnvironmentSetup} onChange={() => {}} />);
    export const markup = {
      unselected: render(null, true),
      desktopIncomplete: render({...base, status: 'not_configured'}, false),
      webIncomplete: render({...base, status: 'not_configured'}, true),
      webDisabled: render({...base, status: 'disabled'}, true),
      webReady: render({...base, status: 'available'}, true),
      mock: render({...base, status: 'available', mock: true}, true),
      connection: render({...base, status: 'not_configured', connectionId: 'configured'}, true),
    };
  `;
  const script = `
    import { build } from 'esbuild';
    const { outputFiles } = await build({
      stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(resolve(root, 'apps/web/src'))} },
      bundle: true, format: 'esm', platform: 'browser', write: false, loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '\"production\"' }, logLevel: 'silent',
    });
    const { markup } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    process.stdout.write(JSON.stringify(markup));
    process.exit(0);
  `;
  const markup = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { env: testEnv(), cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }));
  for (const html of Object.values(markup) as string[]) {
    assert.match(html, /data-testid="provider-select"/);
    assert.doesNotMatch(html, /Long server-only setup instructions|EXAMPLE_API_KEY|API 密钥仅在服务器配置|服务器管理员|生成可能产生费用|type="password"/);
  }
  assert.match(markup.unselected, /选择生成服务商/);
  assert.doesNotMatch(markup.unselected, /data-testid="model-select"|generation-input-summary|provider-details-toggle|配置未完成/);
  for (const html of [markup.webIncomplete, markup.webDisabled]) {
    assert.match(html, /data-testid="provider-details-toggle"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /查看环境变量/);
  }
  for (const html of [markup.webReady, markup.desktopIncomplete, markup.connection, markup.mock]) {
    assert.match(html, /data-testid="model-select"/);
    assert.doesNotMatch(html, /provider-details-toggle|查看环境变量/);
  }
  assert.match(markup.mock, /aria-label="输出为测试图案"/);
  assert.match(markup.mock, /data-testid="generation-input-summary"/);
});
