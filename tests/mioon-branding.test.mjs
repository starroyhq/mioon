import { translate } from './helpers/i18n.ts';
import { LOCALES } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { identityForChannel } from '../apps/desktop/identity.ts';
import { resolveConnection, connectionSource } from '@mioon/client/connection';
import { COOKIE_NAME, sessionCookie } from '../apps/desktop/src/security.ts';
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('Mioon is the sole application identity while production and development data roots remain exact', () => {
  assert.deepEqual(identityForChannel('production'), { channel: 'production', appId: 'app.starroy.mioon', productName: 'Mioon', executableName: 'mioon' });
  assert.deepEqual(identityForChannel('development'), { channel: 'development', appId: 'app.starroy.mioon.dev', productName: 'Mioon Dev', executableName: 'mioon-dev' });
  assert.equal(COOKIE_NAME, 'mioon_session');
  assert.equal(sessionCookie('http://127.0.0.1:4318', 'a'.repeat(64)).name, 'mioon_session');
});

test('every workspace package uses @mioon and CLI publishes no old command alias', async () => {
  const root = JSON.parse(await read('package.json')); assert.equal(root.name, 'mioon');
  for (const base of ['apps', 'packages']) {
    for (const item of await readdir(new URL(`../${base}/`, import.meta.url), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const pkg = JSON.parse(await read(`${base}/${item.name}/package.json`));
      assert.match(pkg.name, /^@mioon\//);
      assert.equal(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => name.startsWith('@video-workbench/')), false);
    }
  }
  assert.deepEqual(JSON.parse(await read('apps/cli/package.json')).bin, { mioon: './src/index.mjs' });
});

test('login, loading, header and browser title display Mioon rather than prior branding', async () => {
  const app = await read('apps/web/src/App.tsx'), login = await read('apps/web/src/LoginScreen.tsx'), html = await read('apps/web/index.html');
  assert.match(app, /className="boot-page"[\s\S]*?<\/span>Mioon/);
  assert.match(app, /<WorkbenchTopbar brand=\{<a[\s\S]*?className="brand-name">Mioon/);
  assert.match(app, /import Login from '\.\/LoginScreen\.tsx';/);
  assert.match(app, /<Login onLogin=/);
  assert.match(login, /<h1 id="login-title">Mioon<\/h1>/);
  assert.match(app, /aria-label=\{t\('shell.title'\)\}/);
  for (const locale of LOCALES) { assert.match(translate(locale, 'shell.title'), /Mioon/); assert.match(translate(locale, 'app.title'), /Mioon/); }
  assert.equal(translate('zh-Hans', 'shell.title'), 'Mioon 影像工作台');
  assert.doesNotMatch(app, />frame|Frame 影像|Video Workbench|VideoWorkbench/);
  assert.doesNotMatch(login, />frame|Frame 影像|Video Workbench|VideoWorkbench/);
  assert.match(html, /<title>Mioon<\/title>/);
  assert.match(await read('apps/desktop/src/main.ts'), /title: identity\.productName/);
});

test('old connection environment names do not act as aliases; current names resolve explicitly', async () => {
  const old = { WB_TOKEN: 'synthetic-token-long-enough', WB_BASE_URL: 'http://127.0.0.1:4321' };
  assert.equal(connectionSource(old), 'unconfigured');
  await assert.rejects(resolveConnection(old), { code: 'CONNECTION_CONFIG_ERROR' });
  const current = { MIOON_TOKEN: 'synthetic-token-long-enough', MIOON_BASE_URL: 'http://127.0.0.1:4321' };
  assert.equal(connectionSource(current), 'environment-token');
  assert.deepEqual(await resolveConnection(current), { base: current.MIOON_BASE_URL, token: current.MIOON_TOKEN });
});
