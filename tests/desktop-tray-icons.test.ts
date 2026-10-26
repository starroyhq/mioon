import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const resources = new URL('../apps/desktop/resources/tray/', import.meta.url);
const read = (name: string) => readFile(new URL(name, resources));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function decodePNG(bytes: Buffer) {
  assert.deepEqual(bytes.subarray(0, 8), signature);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && width <= 2048 && height > 0 && height <= 2048);
  assert.equal(bytes[24], 8, '8-bit pixel components');
  assert.equal(bytes[25], 6, 'RGBA, including real transparency');
  assert.equal(bytes[28], 0, 'non-interlaced pixels');
  const compressed: Buffer[] = [];
  let offset = 8, dpi: number | null = null, finished = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= bytes.length);
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'pHYs') {
      assert.equal(length, 9); assert.equal(bytes[offset + 16], 1);
      assert.equal(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      dpi = Math.round(bytes.readUInt32BE(offset + 8) * 0.0254);
    }
    offset += length + 12;
    if (type === 'IEND') { assert.equal(length, 0); finished = true; break; }
  }
  assert.equal(finished, true); assert.equal(offset, bytes.length);
  const stride = width * 4, raw = inflateSync(Buffer.concat(compressed)), pixels = Buffer.alloc(width * height * 4);
  assert.equal(raw.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= 4 ? pixels[index - 4] : 0, up = y ? pixels[index - stride] : 0;
      const corner = x >= 4 && y ? pixels[index - stride - 4] : 0;
      const estimate = left + up - corner, distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : corner;
      pixels[index] = (raw[y * (stride + 1) + x + 1] + [0, left, up, Math.floor((left + up) / 2), paeth][filter]) & 255;
    }
  }
  return { width, height, dpi, pixels, alpha: Buffer.from(Array.from({length: width * height}, (_, index) => pixels[index * 4 + 3])) };
}
type DecodedPNG = ReturnType<typeof decodePNG>;
function assertBody(image: DecodedPNG) {
  const {width, height, alpha} = image;
  const visible = [...alpha].filter(value => value > 16).length;
  assert.ok(visible > width * height * 0.2 && visible < width * height * 0.6, 'a body mask, without a solid app-icon tile');
  assert.equal(alpha[(height >> 1) * width + (width >> 1)], 0, 'the aperture stays transparent');
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) assert.equal(alpha[y * width + x], 0);
  const visibleColumns = Array.from({length: width}, (_, x) => x).filter(x => Array.from({length: height}, (_, y) => alpha[y * width + x]).some(value => value > 16));
  assert.ok(visibleColumns.length >= width * 0.75, 'the body uses its small canvas instead of retaining the large original padding');
  assert.ok([...alpha].some(value => value > 0 && value < 240), 'antialiased foreground edges are retained');
}

test('tray artwork derives only from the unchanged existing body PNG', async () => {
  const manifest = JSON.parse((await read('manifest.json')).toString('utf8'));
  const source = await readFile(new URL('../apps/web/src/assets/mioon-mark.png', import.meta.url));
  assert.equal(manifest.sourcePath, 'apps/web/src/assets/mioon-mark.png');
  assert.equal(manifest.sourceSHA256, createHash('sha256').update(source).digest('hex'));
  assert.equal(manifest.sourceSHA256, '6a752832ac662ed71dc6b4e5871dc8490b38435fb18667b4e6f71162a38d8191');
  assert.equal(manifest.sourceWidth, 1254); assert.equal(manifest.sourceHeight, 1254);
  assert.equal(manifest.connectivity, 8); assert.equal(manifest.componentAlphaGreaterThan, 4); assert.equal(manifest.antialiasFringePixels, 1);
  assert.equal(manifest.logicalSize, 18);
  assert.deepEqual((await readdir(resources)).sort(), ['README.md', 'manifest.json', 'tray-color.png', 'tray-color@2x.png', 'tray.ico', 'trayTemplate.png', 'trayTemplate@2x.png'].sort());
});

for (const [suffix, size, dpi] of [['', 18, 72], ['@2x', 36, 144]] as const) test(`macOS ${suffix || '1x'} template is black and uses exactly the color body's alpha`, async () => {
  const template = decodePNG(await read(`trayTemplate${suffix}.png`)), color = decodePNG(await read(`tray-color${suffix}.png`));
  assert.deepEqual([template.width, template.height, template.dpi], [size, size, dpi]);
  assert.deepEqual([color.width, color.height, color.dpi], [size, size, dpi]);
  assert.deepEqual(template.alpha, color.alpha, 'system tinting must not switch the body silhouette');
  for (let offset = 0; offset < template.pixels.length; offset += 4) assert.deepEqual([...template.pixels.subarray(offset, offset + 3)], [0, 0, 0]);
  assert.ok(color.pixels.some((value, index) => index % 4 !== 3 && value > 128), 'the Windows/Linux variant keeps actual brand colors');
  assertBody(template); assertBody(color);
});

test('Windows ICO contains real bounded color RGBA frames for common DPI scales', async () => {
  const bytes = await read('tray.ico'), sizes = [16, 20, 24, 32, 48, 64];
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 1); assert.equal(bytes.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(bytes[entry], size); assert.equal(bytes[entry + 1], size);
    assert.equal(bytes[entry + 2], 0); assert.equal(bytes[entry + 3], 0);
    assert.equal(bytes.readUInt16LE(entry + 4), 1); assert.equal(bytes.readUInt16LE(entry + 6), 32);
    const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset); assert.ok(length > 0 && offset + length <= bytes.length);
    const frame = decodePNG(bytes.subarray(offset, offset + length));
    assert.deepEqual([frame.width, frame.height], [size, size]); assertBody(frame);
    assert.ok(frame.pixels.some((value, channel) => channel % 4 !== 3 && value > 128));
    expectedOffset += length;
  }
  assert.equal(expectedOffset, bytes.length, 'no trailing or unreferenced ICO payload');
});
