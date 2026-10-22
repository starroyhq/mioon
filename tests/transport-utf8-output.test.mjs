import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSchema } from '@mioon/client';
import { transformSync } from 'esbuild';

// The same stdout += chunk collector idiom used by transport tests. Pipe write
// boundaries do not promise character boundaries; setEncoding retains residual
// bytes across data events without changing schema/output assertions.
async function collect(chunks, continuous) {
  const stream = new PassThrough();
  if (continuous) stream.setEncoding('utf8');
  let output = '';
  stream.on('data', chunk => { output += chunk; });
  const ended = once(stream, 'end');
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await ended;
  return output;
}

test('legacy chunk coercion deterministically corrupts split Chinese and emoji despite valid JSON syntax', async () => {
  for (const symbol of ['可', '🎬']) {
    const expected = JSON.stringify({description: `列出不${symbol}变生成版本`}) + '\n';
    const bytes = Buffer.from(expected), start = bytes.indexOf(Buffer.from(symbol));
    for (let offset = 1; offset < Buffer.byteLength(symbol); offset++) {
      const actual = await collect([bytes.subarray(0, start + offset), bytes.subarray(start + offset)], false);
      assert.notEqual(actual, expected, `old collector must reproduce the ${offset}-byte boundary defect`);
      assert.match(actual, /\uFFFD/);
      assert.notDeepEqual(JSON.parse(actual), JSON.parse(expected), 'valid JSON alone cannot establish exact discovery parity');
    }
  }
});

test('continuous UTF-8 preserves exact bytes and JSON at every interior multibyte split and byte-wise delivery', async () => {
  for (const symbol of ['可', '🎬']) {
    const expected = JSON.stringify({description: `列出不${symbol}变生成版本`}) + '\n';
    const bytes = Buffer.from(expected), start = bytes.indexOf(Buffer.from(symbol));
    const deliveries = Array.from({length: Buffer.byteLength(symbol) - 1}, (_, offset) => [bytes.subarray(0, start + offset + 1), bytes.subarray(start + offset + 1)]);
    deliveries.push(Array.from(bytes, byte => Buffer.from([byte])));
    for (const chunks of deliveries) {
      const actual = await collect(chunks, true);
      assert.deepEqual(Buffer.from(actual), bytes);
      assert.deepEqual(JSON.parse(actual), JSON.parse(expected));
      assert.equal(actual.includes('\uFFFD'), false);
    }
  }
});

test('actual full shared catalog survives the reproduced version-list description boundary exactly', async () => {
  const catalog = discoverSchema(), expected = JSON.stringify({ok: true, data: catalog}) + '\n';
  const bytes = Buffer.from(expected), phrase = Buffer.from('列出不可变生成版本'), start = bytes.indexOf(phrase);
  assert.ok(start >= 0, 'the real failing public description remains covered');
  const cut = start + Buffer.byteLength('列出不') + 1;
  const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
  assert.notDeepEqual(JSON.parse(await collect(chunks, false)).data, catalog, 'legacy collector reproduces the full-catalog equality failure');
  const actual = await collect(chunks, true);
  assert.deepEqual(Buffer.from(actual), bytes);
  assert.deepEqual(JSON.parse(actual).data, catalog, 'no schema field, authority, limit, or effect is normalized away');
});

// Explicit data-flow inventory: every direct stdout/stderr data listener and
// every aliased stream listener in test/QA sources is classified. Counts are per
// registration site, not per file or callback-variable name. Backend helpers in
// the same file are counted separately. SDK-owned stdout has no such listener:
// the SDK concatenates its protocol Buffers before decoding complete messages.
const textSites = {
  // Agent CLI JSON/progress and public secret-test diagnostics are UTF-8 text.
  'tests/cli-agent.test.mjs': 2,
  // The v2 HTTP test also exercises the real CLI; both pipe collectors decode
  // continuously before collecting stdout JSON and stderr diagnostics.
  'tests/agent-task-http-v2.test.ts': 2,
  'tests/headless-agent-secret-public-native.test.mjs': 2,
  // Native CLI smoke parses stdout; stderr is counted as raw bytes below.
  'tests/windows-node-host-smoke.test.mjs': 1,
  'tests/client-version-source.test.ts': 1,
  'tests/comfy-module-http.test.mjs': 2,
  'tests/desktop-exit-recovery.test.mjs': 1,
  'tests/desktop-lut-recovery-restart.test.mjs': 2,
  'tests/i18n-command-presentation.test.mjs': 1,
  'tests/timeline-audio-continuous-transports.test.mjs': 1,
  // Two CLI collectors plus official MCP stderr; all continuously decode UTF-8.
  'tests/timeline-audio-preview-transports.test.mjs': 3,
  'tests/float-capability-http-cancel.test.mjs': 1,
  // CLI stdout/stderr loop and official SDK stderr only; SDK stdout stays protocol-owned.
  'tests/float-checked-export-transports.test.mjs': 2,
  // CLI JSON/stdout, CLI stderr and SDK stderr; each has continuous decoding before data.
  'tests/export-sample-peak-transports.test.mjs': 3,
  // One explicit loop listener covers stdout JSON and stderr text, both decoded before data.
  'tests/agent-timeline-gain-preservation.test.mjs': 1,
  'tests/selected-range-transports.test.mjs': 2,
  'tests/local-shot-text-process-recovery.test.mjs': 2,
  'tests/local-delivery-process-recovery.test.mjs': 2,
  'tests/last-project-transports.test.mjs': 1,
  'tests/local-drafts-transports.test.mjs': 1,
  // Existing actual CLI/MCP text collectors also belong to the full inventory.
  'tests/lut-resources-transports.test.mjs': 2,
  'tests/timeline-image-transports.test.mjs': 2,
  'tests/timeline-jpeg-transports.test.mjs': 2,
  "tests/named-delivery-transports.test.mjs": 2,
  "tests/typecheck-runtime.test.mjs": 1,
  "tests/workspace-restore-transports.test.mjs": 2,
  "tests/helpers/workspace-restore-offline-fixture.ts": 2,
  "tests/workspace-origin-transports.test.mjs": 2,
  "tests/workspace-backup-cli.test.mjs": 2,
  "tests/opacity-candidate-backup-cli.test.mjs": 2,
  "tests/workspace-backup-inspection-transports.test.mjs": 3,
  "tests/agent-chat-durable-crash.test.mjs": 1,
  // The v2 crash harness collects only continuously decoded child stderr.
  'tests/agent-task-crash-v2.test.ts': 1,
  "tests/agent-edit-scope.test.mjs": 1,
  "tests/agent-tool-journal-crash.test.mjs": 2,
  "tests/asset-disposition-transports.test.mjs": 2,
  "tests/asset-dispositions.test.mjs": 1,
  "tests/cli-mcp-key-recovery-transport.test.mjs": 3,
  "tests/cli-v4.test.mjs": 2,
  "tests/comfy-transports.test.mjs": 2,
  "tests/custom-image-transports.test.mjs": 2,
  "tests/desktop-media-shutdown.test.mjs": 2,
  "tests/dual-workspace-server.mjs": 2,
  "tests/edit-task-process-recovery.test.mjs": 1,
  "tests/timeline-loudness-process-recovery.test.mjs": 1,
  "tests/workspace-schema26.test.mjs": 2,
  "tests/edit-tasks-http.test.mjs": 2,
  "tests/export-preflight-http-observer.test.mjs": 2,
  "tests/export-settings-transports.test.mjs": 3,
  "tests/frame-recovery.test.mjs": 1,
  "tests/frame-transports.test.mjs": 3,
  "tests/generation-input-transports.test.mjs": 4,
  "tests/helpers/agent-edit-wire-lifecycle.ts": 3,
  "tests/helpers/inspection-wire-lifecycle.ts": 1,
  "tests/helpers/agent-edit-wire-lifecycle-cases.ts": 1,
  "tests/helpers/edit-tasks-http-fixture.ts": 1,
  "tests/http-file-shutdown.test.mjs": 2,
  "tests/image-activation-transports.test.mjs": 2,
  "tests/image-generation-recovery.test.mjs": 2,
  "tests/image-generation-transports.test.mjs": 5,
  "tests/image-edit-transports.test.mjs": 5,
  "tests/image-profile-discovery.test.mjs": 3,
  "tests/inspection-wire.test.mjs": 3,
  "tests/integration.test.mjs": 2,
  "tests/keychain-timeout-audit.test.mjs": 1,
  "tests/mcp.test.mjs": 3,
  "tests/media-runtime-bounds.test.mjs": 1,
  "tests/mutation-wire.test.mjs": 3,
  "tests/private-storage-transports.test.mjs": 2,
  "tests/project-specifications-transports.test.mjs": 2,
  "tests/reference-recovery-transports.test.mjs": 1,
  "tests/reference-transports.test.mjs": 4,
  "tests/source-range-transports.test.mjs": 2,
  "tests/source-ranges.test.mjs": 1,
  "tests/subject-recovery-transports.test.mjs": 2,
  "tests/subtitles-transports.test.mjs": 2,
  "tests/timeline-fades-transports.test.mjs": 5,
  "tests/timeline-history-transports.test.mjs": 4,
  "tests/timeline-mcp.test.mjs": 3,
  "tests/timeline-media.test.mjs": 2,
  "tests/timeline-preflight-transports.test.mjs": 3,
  "tests/timeline-recovery-transports.test.mjs": 1,
  "tests/timeline-replacement-transports.test.mjs": 4,
  "tests/timeline-split-media.test.mjs": 2,
  "tests/timeline-split-transports.test.mjs": 4,
  "tests/waveforms-transports.test.mjs": 2,
  "tests/workspace-preferences-http.test.mjs": 2,
  "tests/subject-video-transports.test.mjs": 5,
  "tests/video-first-last-transports.test.mjs": 5,
  'tests/export-loudness-transports.test.mjs': 3,
  // CLI JSON stdout/stderr + SDK stderr continuously decode; SDK stdout remains protocol-owned.
  'tests/timeline-mix-loudness-transports.test.mjs': 3,
  'tests/timeline-clip-loudness-transports.test.mjs': 3,
  // One shared stdout/stderr loop site plus the official MCP stderr site.
  // Typed rewrite consolidated the two per-stream registrations into one loop after
  // setting UTF-8 encoding on both streams; one listener site covers both.
  // CLI stdout/stderr loop plus official MCP stderr, including typed casts.
  'tests/asset-annotation-transports.test.mjs': 2,
  // Actual CLI stdout/stderr and official MCP stderr are bounded UTF-8 text.
  'tests/timeline-loudness-apply-transports.test.mjs': 3,
  // Only SDK stderr has a direct listener; CLI execFile owns UTF-8 decoding, SDK owns JSON stdout.
  'tests/timeline-mix-loudness-real-transports.test.mjs': 1,
  'tests/opacity-upgrade-cli.test.mjs': 2,
  'tests/timeline-audio-role-transports.test.mjs': 5,
  'tests/timeline-ripple-transports.test.mjs': 2,
};
// Byte-preserving passthrough forwarders: no text concatenation or decoding.
const passthroughSites = {
  'tests/fixtures/workspace-restore-electron/main.ts': 2,
};
// These two new SDK stderr drains deliberately discard bytes: no conversion,
// concatenation, parsing or text assertion occurs in their exact empty listener.
const discardedSites = {
  'tests/task-disposition-transports.test.ts': "transport.stderr?.on('data',()=>{});",
  'tests/workspace-configuration-transports.test.mjs': "transport.stderr?.on('data',()=>{});",
};
const binarySites = {
  'tests/http-streams-qa-native.mjs': 1,
  'tests/mutation-qa-native.mjs': 1,
  'tests/workspace-preferences-native-launch.mjs': 1,
  'tests/inspection-qa-native.mjs': 1,
  'tests/agent-settings-qa-native.mjs': 1,
  'tests/media-runtime-qa-native.mjs': 1,
  'tests/agent-edits-qa-native.mjs': 1,
  'tests/dockable-panels-qa-native.mjs': 1,
  'tests/private-storage-qa-native.mjs': 1,
  'tests/agent-chat-qa-native.mjs': 1,
};
// These are not appendFile loggers or streaming text decoders. Keep each exact
// Buffer collection and final sink explicit: no directory/file-wide exemption.
const bufferedSites = {
  'tests/project-lifecycle-transports.test.mjs': {
    count: 1, kind: 'diagnostic-string',
    registration: "child.stderr.on('data',chunk=>{stderr+=chunk;});",
    sink: "assert.equal(outcome[1],'SIGKILL',stderr);",
  },
  'tests/desktop-exit-backend.test.mjs': {
    count: 1, kind: 'complete-message',
    registration: "child.stdout.on('data', chunk => chunks.push(chunk))",
    sink: "const output = Buffer.concat(chunks).toString('utf8');",
  },
  'tests/desktop-lut-recovery-qa-native.mjs': {
    count: 1, kind: 'bounded-diagnostic',
    registration: "child.stderr.on('data', part => {\n      if (errors.length < stderrLimit) errors = Buffer.concat([errors, part.subarray(0, stderrLimit - errors.length)]);\n    })",
    sink: "${errors.toString('utf8')}",
  },
  'tests/fixtures/timeline-audio-continuous/launch.mjs': {
    count: 1, kind: 'buffered-file',
    registration: "stream.on('data',bytes=>{if(logs.reduce((n,b)=>n+b.length,0)<2*1024*1024)logs.push(Buffer.from(bytes));})",
    sink: "await writeFile(path.join(root,'electron.log'),Buffer.concat(logs),{mode:0o600});",
  },
  'tests/fixtures/timeline-audio-continuous/origin-sweep.mjs': {
    count: 1, kind: 'buffered-file',
    registration: "stream.on('data', bytes => {if (logBytes < 1024 * 1024) {logs.push(Buffer.from(bytes)); logBytes += bytes.length;}})",
    sink: "await writeFile(path.join(root, 'electron.log'), Buffer.concat(logs), {mode: 0o600});",
  },
};
// Some native workers only count diagnostics, without decoding or retaining
// them. Classify each exact listener so a mixed text/byte file is not exempted.
const byteCountSites = {
  'tests/windows-node-host-smoke.test.mjs': {
    'child.stderr': {counter:'stderrBytes',registration:"child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;});",sink:'assert.ok(stderrBytes<8192)'},
  },
  'tests/windows-private-storage-races.test.mjs': {
    'child.stdout': {counter:'outputBytes',registration:"child.stdout.on('data',bytes=>{outputBytes+=bytes.length;});",sink:"assert.ok(outputBytes<8192,'Worker diagnostic output must remain bounded')"},
    'child.stderr': {counter:'outputBytes',registration:"child.stderr.on('data',bytes=>{outputBytes+=bytes.length;});",sink:"assert.ok(outputBytes<8192,'Worker diagnostic output must remain bounded')"},
  },
};
const root = fileURLToPath(new URL('..', import.meta.url));
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (entry.isFile() && /\.(?:mjs|ts)$/u.test(entry.name)) files.push(target);
  }
  return files.sort();
}
const registrationPattern = /(?<receiver>\b[A-Za-z_$][\w$]*\.(?:stdout|stderr)|\b(?:stream|stderrStream))(?<assertion>!)?(?<access>\?\.|\.)(?<decode>setEncoding\(['"]utf8['"]\)\.)?on\(['"]data['"]/g;

// The migration renames tested files from `.test.mjs` to `.test.ts` wave by wave.
// Inventory keys are canonicalized by dropping the final source extension so the
// reviewed per-file classification survives renames without central key churn.
const canonicalInventoryName = name => name.replace(/\.(?:mjs|ts|jsx|tsx)$/u, '');
const canonicalInventory = map => new Map(Object.entries(map).map(([name, value]) => [canonicalInventoryName(name), value]));
const canonicalTextSites = canonicalInventory(textSites), canonicalBinarySites = canonicalInventory(binarySites),
  canonicalPassthroughSites = canonicalInventory(passthroughSites), canonicalBufferedSites = canonicalInventory(bufferedSites),
  canonicalDiscardedSites = canonicalInventory(discardedSites), canonicalByteCountSites = canonicalInventory(byteCountSites);
test('every inventoried test/QA text collector configures continuous decoding at its actual listener, before delivery', async () => {
  const found = {};
  for (const file of await sourceFiles(path.join(root, 'tests'))) {
    const name = path.relative(root, file).split(path.sep).join('/');
    // This file deliberately exercises both the broken historical collector and
    // the repaired collector above. Immutable historical fixtures are JSON, not
    // executable source included in this scan, and remain hash-verified elsewhere.
    if (canonicalInventoryName(name) === 'tests/transport-utf8-output.test') continue;
    const original = await readFile(file, 'utf8');
    const inventoryName = canonicalInventoryName(name);
    // Audit the actual JavaScript registration in typed text collectors. Type
    // assertions and parentheses must neither hide a listener nor a decoder.
    const source = file.endsWith('.ts') && canonicalTextSites.has(inventoryName)
      ? transformSync(original, {loader:'ts', format:'esm', target:'esnext'}).code : original;
    const sites = [...source.matchAll(registrationPattern)];
    if (!sites.length) continue;
    assert.equal(Object.hasOwn(found, inventoryName), false, `${name}: duplicate canonical inventory name during migration`);
    found[inventoryName] = sites.length;
    assert.ok(canonicalTextSites.has(inventoryName) || canonicalBinarySites.has(inventoryName) || canonicalPassthroughSites.has(inventoryName) || canonicalBufferedSites.has(inventoryName) || canonicalDiscardedSites.has(inventoryName) || canonicalByteCountSites.has(inventoryName), `${name}: classify each newly introduced stream consumer`);
    if (canonicalDiscardedSites.has(inventoryName)) {
      assert.equal(sites.length, 1, name);
      assert.ok(source.startsWith(canonicalDiscardedSites.get(inventoryName), sites[0].index), `${name}: retain the exact empty byte drain`);
      assert.equal(sites[0].groups.decode, undefined, `${name}: no text collector is exempted`);
      continue;
    }
    if (canonicalBufferedSites.has(inventoryName)) {
      const specification = canonicalBufferedSites.get(inventoryName);
      assert.equal(sites.length, specification.count, name);
      assert.ok(source.includes(specification.sink), `${name}: retain the audited ${specification.kind} sink`);
      for (const site of sites) {
        assert.equal(site.groups.decode, undefined, `${name}: retain Buffer bytes until the final sink`);
        assert.ok(source.startsWith(specification.registration, site.index), `${name}: exact audited Buffer collector, not per-chunk string coercion`);
      }
      continue;
    }
    if (canonicalPassthroughSites.has(inventoryName)) {
      assert.equal(sites.length, canonicalPassthroughSites.get(inventoryName), name);
      for (const site of sites) assert.equal(site.groups.decode, undefined, `${name}: keep raw byte passthrough`);
      continue;
    }
    if (canonicalBinarySites.has(inventoryName)) {
      assert.equal(sites.length, canonicalBinarySites.get(inventoryName), name);
      assert.match(source, /appendFile\(/, `${name}: raw file logging preserves Buffer bytes`);
      for (const site of sites) assert.equal(site.groups.decode, undefined, `${name}: keep raw byte writer binary`);
      continue;
    }
    const byteCounters = canonicalByteCountSites.get(inventoryName) ?? {};
    assert.equal(sites.length, (canonicalTextSites.get(inventoryName) ?? 0) + Object.keys(byteCounters).length, `${name}: all helper instances remain covered`);
    for (const site of sites) {
      const location = `${name}:${source.slice(0, site.index).split('\n').length}`;
      const stream = new PassThrough();
      const receiver = site.groups.receiver;
      const variable = receiver.split('.')[0];
      const owner = receiver === 'stream' || receiver === 'stderrStream' ? stream : {stdout: stream, stderr: stream};
      const counter = byteCounters[receiver];
      if (counter) {
        assert.equal(site.groups.decode, undefined, `${location}: byte counts must retain raw Buffers`);
        assert.ok(source.startsWith(counter.registration,site.index), `${location}: retain the exact byte-only counter`);
        assert.ok(source.includes(counter.sink), `${location}: retain the bounded diagnostic sink`);
        const register = new Function(variable, `let ${counter.counter}=0;${counter.registration}return ()=>${counter.counter};`);
        const count = register(owner), ended = once(stream,'end');
        const expected = Buffer.concat([Buffer.from('中🎬'),Buffer.from([0xff])]);
        for (const byte of expected) stream.write(Buffer.from([byte]));
        stream.end();await ended;
        assert.equal(stream.readableEncoding,null,location);
        assert.equal(count(),expected.length,`${location}: split UTF-8 and non-text bytes are counted exactly`);
        continue;
      }
      assert.ok(site.groups.decode, `${location}: configure decoder on this stream before registering its listener`);
      let actual = '';
      // Execute only the audited registration expression, not a helper, subprocess
      // or callback body. This proves its exact ordering and optional-chain shape.
      // A TypeScript non-null assertion has no runtime behavior. Remove only
      // that captured assertion before executing the actual registration.
      const registration = site.groups.assertion ? receiver + site[0].slice(receiver.length + 1) : site[0];
      const register = new Function(variable, 'listener', `return ${registration}, listener);`);
      register(owner, chunk => {assert.equal(typeof chunk, 'string', location); actual += chunk;});
      assert.equal(stream.readableEncoding, 'utf8', location);
      const ended = once(stream, 'end');
      const expected = '列出不可变生成版本🎬';
      for (const byte of Buffer.from(expected)) stream.write(Buffer.from([byte]));
      stream.end(); await ended;
      assert.equal(actual, expected, location);
      if (site.groups.access === '?.') assert.doesNotThrow(() => register(receiver.includes('.') ? {} : undefined, () => {}), location);
    }
  }
  const expectedSites = {...Object.fromEntries(canonicalTextSites), ...Object.fromEntries(canonicalBinarySites), ...Object.fromEntries(canonicalPassthroughSites), ...Object.fromEntries([...canonicalBufferedSites].map(([name, value]) => [name, value.count])), ...Object.fromEntries([...canonicalDiscardedSites.keys()].map(name => [name, 1]))};
  for (const [name,counters] of canonicalByteCountSites) expectedSites[name]=(expectedSites[name]??0)+Object.keys(counters).length;
  assert.deepEqual(found, Object.fromEntries(Object.entries(expectedSites).sort(([a], [b]) => a.localeCompare(b))), 'all inventoried helper and raw-file sites are present');
});
