import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('provider readiness uses compact, safe, collapsed Base UI controls for every status', () => {
  const fixture = `
    import * as React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server.browser';
    import ProviderSettings from './ProviderSettings.tsx';
    const capabilities = { id: 'local-model', name: 'Local model', inputModes: ['text'], durations: [4, 8], aspectRatios: ['9:16'] };
    const base = { id: 'example', name: 'Example', modelCapabilities: [capabilities], configuration: {
      missing: ['EXAMPLE_API_KEY', 'EXAMPLE_OUTPUT_HOSTS', 'EXAMPLE_API_KEY', ' EXAMPLE_OUTPUT_HOSTS '],
      requirements: ['Long server-only setup instructions', 'Long server-only setup instructions'],
    } };
    export const markup = Object.fromEntries(['not_configured', 'disabled', 'available', 'mock'].map(status => {
      const provider = { ...base, status: status === 'mock' ? 'available' : status, mock: status === 'mock' };
      return [status, renderToStaticMarkup(<ProviderSettings providers={[provider]} provider={provider} model={capabilities.id} capabilities={capabilities} onChange={() => {}} />)];
    }));
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
  const markup = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30_000 }));
  for (const status of ['not_configured', 'disabled', 'available']) {
    const html = markup[status];
    assert.match(html, /data-slot="collapsible"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /查看配置说明/);
    assert.doesNotMatch(html, /Long server-only setup instructions/);
    assert.match(html, /API 密钥仅在服务器配置；勿填入提示词或浏览器/);
    assert.equal((html.match(/class="config-name"/g) || []).length, 2);
    assert.match(html, /data-testid="provider-select"/);
    assert.match(html, /data-testid="model-select"/);
    assert.match(html, /data-testid="model-capabilities"/);
    assert.doesNotMatch(html, /type="password"/);
    assert.doesNotMatch(html, /MAX_GENERATIONS|生成次数上限/);
  }
  assert.match(markup.not_configured, /还需配置 2 项，完成后重启服务/);
  assert.match(markup.disabled, /真实调用未启用/);
  assert.match(markup.available, /真实生成可能计费/);
  assert.match(markup.mock, /不调用付费 AI 服务/);
  assert.match(markup.mock, /输出为测试图案，不会呈现参考图片或提示词描述的内容/);
  assert.match(markup.mock, /data-testid="generation-input-summary"/);
  assert.doesNotMatch(markup.mock, /查看配置说明|EXAMPLE_API_KEY/);
});
