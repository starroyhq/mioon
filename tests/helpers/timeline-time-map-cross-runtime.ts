/** Regenerates or checks the committed cross-runtime fixture.
 *
 *   node --experimental-strip-types tests/helpers/timeline-time-map-cross-runtime.ts --write
 *   node --experimental-strip-types tests/helpers/timeline-time-map-cross-runtime.ts --check
 *
 * The table is the Chromium/Node equality gate: `--write` is only run after the
 * point sets, profile or tie rules are reviewed.
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildCrossRuntimePayload, crossRuntimeHash} from './timeline-time-map-vectors.ts';

const fixtureUrl = new URL('../fixtures/timeline-time-map/cross-runtime-v1.json', import.meta.url);
const payload = buildCrossRuntimePayload();
const document = {version: payload.version, profile: payload.profile, hash: crossRuntimeHash(payload), payload};
const text = `${JSON.stringify(document, null, 1)}\n`;

function main(): number {
  const mode = process.argv.slice(2).find(argument => argument === '--write' || argument === '--check');
  if (mode === '--write') {
    writeFileSync(fixtureUrl, text);
    process.stdout.write(`wrote ${fixtureUrl.pathname.split('/').slice(-2).join('/')} hash=${document.hash} rows=${payload.cases.length}\n`);
    return 0;
  }
  const committed = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {hash?: string; payload?: unknown};
  if (committed.hash !== document.hash || JSON.stringify(committed.payload) !== JSON.stringify(payload)) {
    process.stderr.write(`fixture mismatch: committed=${committed.hash} computed=${document.hash}\n`);
    return 1;
  }
  process.stdout.write(`fixture ok hash=${document.hash} rows=${payload.cases.length}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
