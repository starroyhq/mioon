import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builderConfig from '../apps/desktop/builder-config.cjs';
import { secureWebPreferences } from '../apps/desktop/src/security.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const bytes = name => readFile(path.join(root, name));
const text = async name => (await bytes(name)).toString('utf8');

test('brand PNG dimensions and alpha intent match their fixed local consumers', async () => {
  for (const [name, size, colourType] of [
    ['apps/web/src/assets/mioon-mark.png', 1254, 6],
    ['apps/web/public/favicon.png', 256, 2],
    ['apps/desktop/resources/icon.png', 1024, 2],
  ]) {
    const data = await bytes(name);
    assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(data.toString('ascii', 12, 16), 'IHDR');
    assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
    assert.equal(data[25], colourType);
  }
  assert.deepEqual(await bytes('apps/web/src/assets/mioon-mark.png'), await bytes('output/imagegen/mioon-icon-transparent.png'));
  const component = await text('apps/web/src/BrandMark.tsx');
  assert.match(component, /new URL\('\.\/assets\/mioon-mark\.png', import\.meta\.url\)/);
  assert.match(component, /alt="" width=\{1254\} height=\{1254\} draggable=\{false\}/);
  const app = await text('apps/web/src/App.tsx');
  assert.equal((app.match(/<span className="brand-mark"><BrandMark \/>/g) || []).length, 1, 'loading keeps the local PNG mark');
  assert.match(app, /className="boot-page"[\s\S]*?<span className="brand-mark"><BrandMark \/>/);
  assert.match(app, /<WorkbenchTopbar brand=\{<a[^>]+className="brand"[\s\S]*?<span className="brand-name">Mioon<\/span>/);
  assert.doesNotMatch(app, /<span className="brand-mark"><Icon/);
  assert.match(await text('apps/web/index.html'), /<link rel="icon" type="image\/png" href="\/favicon\.png" \/>/);
});

test('Mac ICNS remains structurally bounded and its largest PNG equals the desktop source', async () => {
  const data = await bytes('apps/desktop/resources/icon.icns');
  assert.equal(data.toString('ascii', 0, 4), 'icns'); assert.equal(data.readUInt32BE(4), data.length);
  let offset = 8, largest = null;
  while (offset < data.length) {
    assert.ok(offset + 8 <= data.length);
    const type = data.toString('ascii', offset, offset + 4), size = data.readUInt32BE(offset + 4);
    assert.ok(size >= 8 && offset + size <= data.length);
    if (type === 'ic10') { assert.equal(largest, null); largest = data.subarray(offset + 8, offset + size); }
    offset += size;
  }
  assert.equal(offset, data.length); assert.ok(largest);
  assert.deepEqual(largest, await bytes('apps/desktop/resources/icon.png'));
});

test('both desktop channels package brand assets without dropping preload or isolation', async () => {
  for (const channel of ['production', 'development']) {
    const config = builderConfig(channel);
    assert.equal(config.directories.buildResources, 'resources');
    assert.equal(config.icon, path.join(root, 'apps/desktop/resources/icon.png'));
    assert.equal(config.mac.icon, path.join(root, 'apps/desktop/resources/icon.icns'));
    assert.ok(config.files.includes('preload.cjs')); assert.ok(config.files.includes('icons/**/*'));
    assert.ok(config.files.includes('!node_modules/**/*')); assert.equal(config.publish, null);
  }
  const build = await text('apps/desktop/scripts/build.ts');
  assert.match(build, /await cp\(path\.join\(desktop, 'resources\/icon\.png'\), path\.join\(output, 'icons\/icon\.png'\)\)/);
});

test('actual shared window factory adds the local icon while retaining the secure preload and owned session', async () => {
  const source = await text('apps/desktop/src/main.ts');
  const factory = source.match(/createWindow: (\(\) => new BrowserWindow\(\{[\s\S]+?\}\)),\n\s+prepareWindow:/)?.[1];
  assert.ok(factory);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const session = {}, appRoot = '/synthetic/mioon-stage';
    const makeWindow = Function('BrowserWindow', 'identity', 'path', 'app', 'process', 'windowChromeOptions', 'secureWebPreferences', 'context', `return (${factory});`)(
      class { constructor(config) { this.config = config; } }, { productName: 'Mioon' }, path,
      { getAppPath: () => appRoot }, { platform }, () => ({}), secureWebPreferences, { session, appearance:{backgroundColor:()=>'#f6f6f6'} });
    const { config } = makeWindow();
    assert.equal(config.icon, path.join(appRoot, 'icons/icon.png'));
    assert.equal(config.backgroundColor, '#f6f6f6');
    assert.equal(config.webPreferences.preload, path.join(appRoot, 'preload.cjs'));
    assert.equal(config.webPreferences.session, session); assert.equal(config.webPreferences.sandbox, true);
    assert.equal(config.webPreferences.contextIsolation, true); assert.equal(config.webPreferences.nodeIntegration, false);
  }
  const dock = source.match(/^\s*(if \(process\.platform === 'darwin'\) app\.dock\?\.setIcon\([^\n]+;)$/m)?.[1];
  assert.ok(dock);
  assert.ok(source.indexOf(dock) > source.indexOf('app.whenReady().then(async () => {'));
  assert.ok(source.indexOf(dock) < source.indexOf('languageHost = createAppLanguageHost('));
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    Function('app', 'path', 'process', dock)({ getAppPath: () => '/synthetic/mioon-stage', dock: { setIcon: value => calls.push(value) } }, path, { platform });
    assert.deepEqual(calls, platform === 'darwin' ? [path.join('/synthetic/mioon-stage', 'icons/icon.png')] : []);
    assert.doesNotThrow(() => Function('app', 'path', 'process', dock)({ getAppPath: () => '/synthetic/mioon-stage' }, path, { platform }));
  }
});

test('current package inspection accepts icons while frozen historical V3 still rejects them', async () => {
  const source = await text('apps/desktop/scripts/inspect-package.ts');
  const selection = source.slice(source.indexOf('const allowed = new Set('), source.indexOf('for (const file of files)'));
  for (const historicalV3 of [false, true]) {
    const allowed = Function('historicalV3', `${selection}; return allowed;`)(historicalV3);
    assert.equal(allowed.has('icons'), !historicalV3); assert.equal(allowed.has('preload.cjs'), !historicalV3);
    for (const name of ['node_modules', 'workspace', 'data', '.env']) assert.equal(allowed.has(name), false);
  }
  assert.match(source, /historicalV3 \? \[\] : \[[^\]]*'preload\.cjs'[^\]]*'icons\/icon\.png'/);
  assert.match(source, /Packaged \$\{file\} must equal verified staging/);
});
