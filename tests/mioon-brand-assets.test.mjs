import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import builderConfig from '../apps/desktop/builder-config.ts';
import { secureWebPreferences } from '../apps/desktop/src/security.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const bytes = name => readFile(path.join(root, name));
const text = async name => (await bytes(name)).toString('utf8');

test('brand PNG dimensions and alpha intent match their fixed local consumers', async () => {
  for (const [name, size, colourType] of [
    ['apps/web/src/assets/mioon-mark.png', 1254, 6],
    ['apps/web/public/favicon.png', 256, 2],
    ['apps/desktop/resources/icon-source.png', 1024, 2],
    ['apps/desktop/resources/icon.png', 1024, 6],
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

test('shared desktop PNG has transparent padding and an opaque rounded backplate', async () => {
  const data = await bytes('apps/desktop/resources/icon.png');
  assert.equal(data[24], 8); assert.equal(data[25], 6); assert.equal(data[28], 0);
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20), chunks = [];
  for (let offset = 8; offset < data.length;) {
    const size = data.readUInt32BE(offset);
    assert.ok(offset + size + 12 <= data.length);
    if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4 + 1;
  assert.equal(raw.length, stride * height);
  const alpha = Array.from({ length: height }, () => Buffer.alloc(width));
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride]; assert.ok(filter <= 4);
    for (let x = 0; x < width; x++) {
      const left = x ? alpha[y][x - 1] : 0, up = y ? alpha[y - 1][x] : 0, corner = x && y ? alpha[y - 1][x - 1] : 0;
      const estimate = left + up - corner, distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : corner;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      alpha[y][x] = (raw[y * stride + 1 + x * 4 + 3] + predictor) & 255;
    }
  }
  assert.ok(alpha[0].every(value => value === 0)); assert.ok(alpha.at(-1).every(value => value === 0));
  for (const row of alpha) { assert.equal(row[0], 0); assert.equal(row.at(-1), 0); }
  const middleX = Math.floor(width / 2), middleY = Math.floor(height / 2);
  assert.equal(alpha[middleY][middleX], 255);
  assert.ok(alpha[Math.floor(height * 0.09)].every(value => value === 0), 'top padding stays transparent');
  assert.ok(alpha[Math.floor(height * 0.91)].every(value => value === 0), 'bottom padding stays transparent');
  for (const row of alpha) {
    assert.equal(row[Math.floor(width * 0.09)], 0, 'left padding stays transparent');
    assert.equal(row[Math.floor(width * 0.91)], 0, 'right padding stays transparent');
  }
  assert.equal(alpha[Math.floor(height * 0.125)][Math.floor(width * 0.125)], 0, 'backplate corners are rounded');
  assert.equal(alpha[Math.floor(height * 0.125)][middleX], 255, 'backplate top remains opaque inside the padding');
});

test('Mac ICNS remains structurally bounded and its largest PNG equals the shared desktop PNG', async () => {
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
    assert.equal(config.linux.icon, path.join(root, 'apps/desktop/resources/icon.png'));
    assert.ok(config.files.includes('preload.cjs')); assert.ok(config.files.includes('icons/**/*'));
    assert.ok(config.files.includes('!node_modules/**/*')); assert.equal(config.publish, null);
  }
  const build = await text('apps/desktop/scripts/build.ts');
  assert.match(build, /await cp\(path\.join\(desktop, 'resources\/icon\.png'\), path\.join\(output, 'icons\/icon\.png'\)\)/);
  assert.doesNotMatch(build, /icon-(?:macos|source)\.png/);
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
  assert.doesNotMatch(source, /icon-(?:macos|source)\.png/);
  assert.match(source, /Packaged \$\{file\} must equal verified staging/);
  const releaseInspection = await text('.github/scripts/inspect-desktop.ts');
  assert.match(releaseInspection, /for \(const name of \[[^\]]*'icons\/icon\.png'[^\]]*\]\) asar\.extractFile\(archive, name\)/);
  assert.doesNotMatch(releaseInspection, /icon-(?:macos|source)\.png/);
  assert.match(releaseInspection, /assert\.deepEqual\(asar\.extractFile\(archive, entry\), await readFile\(path\.join\(root, 'apps\/desktop\/build', entry\)\), 'ASAR_STAGING_MISMATCH'\)/);
});
