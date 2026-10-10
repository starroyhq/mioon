import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {operationEffects} from '../packages/contracts/src/operation-effects.mjs';

// Static documentation checks only. Do not import transports/business services,
// execute documented commands, resolve credentials, or open media/fixture files.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFileSync(path.join(root, name), 'utf8');
const documentPath = 'docs/AGENT-QUICKSTART-AUDIT.md';
const document = read(documentPath);
const cli = read('apps/cli/src/index.mjs');
const client = read('packages/client/src/index.mjs');
const contracts = read('packages/contracts/src/index.mjs');
const images = read('packages/contracts/src/images.mjs');
const reviews = read('packages/contracts/src/image-reviews.mjs');
const inspection = read('packages/contracts/src/inspection.mjs');
const preflight = read('packages/contracts/src/export-preflight.mjs');
const quotedWords = source => [...source.matchAll(/'([^']+)'/gu)].map(match => match[1]);
const valueOptions = new Set(quotedWords(cli.match(/const valueOptions = new Set\(\[([^\]]+)\]\)/u)[1]));
const switches = new Set(quotedWords(cli.match(/const switches = new Set\(\[([^\]]+)\]\)/u)[1]));
const watchOperations = quotedWords(cli.match(/const watch = \[([^\]]+)\]\.includes/u)[1]);
const downloadOperations = quotedWords(cli.match(/download = \[([^\]]+)\]\.includes/u)[1]);
const blocks = [...document.matchAll(/<!-- quickstart ([\w-]+) ([\w-]+) -->\n```sh\n([\s\S]*?)\n```/gu)];

function parseExample(line, id, effect) {
  const prefix = 'node apps/cli/src/index.mjs ';
  assert.ok(line.startsWith(prefix), `${id}: expected a literal CLI draft`);
  const command = line.slice(prefix.length);
  // The drafts deliberately use literal single-quoted JSON/path arguments.
  // This is not a shell interpreter and never expands variables or runs code.
  const matches = [...command.matchAll(/'([^']*)'|([^\s']+)/gu)];
  let consumed = 0;
  const argv = matches.map(match => {
    assert.match(command.slice(consumed, match.index), /^\s*$/u);
    consumed = match.index + match[0].length;
    return match[1] ?? match[2];
  });
  assert.match(command.slice(consumed), /^\s*$/u);
  const words = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {words.push(value); continue;}
    const name = value.slice(2);
    assert.ok(valueOptions.has(name) || switches.has(name), `${id}: unsupported flag ${value}`);
    assert.equal(Object.hasOwn(options, name), false, `${id}: duplicate flag`);
    options[name] = switches.has(name) ? true : argv[++i];
    assert.notEqual(options[name], undefined, `${id}: missing option value`);
  }
  assert.equal(options['input-file'], undefined, 'Examples must remain inspectable without reading request files');
  const input = options.input === undefined ? {} : JSON.parse(options.input);
  if (options['request-id'] !== undefined) {
    assert.ok(input.requestId === undefined || input.requestId === options['request-id']);
    input.requestId = options['request-id'];
  }
  return {id, effect, options, words, operation: (words[0] === 'rpc' ? words.slice(1) : words).join('.'), input};
}
const examples = blocks.flatMap(([, id, effect, contents]) => contents.split('\n').map(line => parseExample(line, id, effect)));
const example = operation => {
  const found = examples.find(item => item.operation === operation);
  assert.ok(found, `Missing draft: ${operation}`);
  return found;
};

// A deliberately limited source-shape reader, not an alternative Zod validator.
// It checks field presence/optional markers and explicit spreads in the current
// literal declarations; numeric bounds and refinements remain outside this test.
function objectAfter(source, marker) {
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `Missing source declaration: ${marker}`);
  const start = source.indexOf('{', markerAt + marker.length);
  assert.notEqual(start, -1);
  let depth = 0, quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {if (c === '\\') i++; else if (c === quote) quote = null; continue;}
    if (c === "'" || c === '"' || c === '`') {quote = c; continue;}
    if (c === '{') depth++;
    if (c === '}') {depth--; if (depth === 0) return source.slice(start + 1, i);}
  }
  assert.fail(`Unclosed source shape: ${marker}`);
}
function properties(body) {
  const result = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {if (c === '\\') i++; else if (c === quote) quote = null; continue;}
    if (c === "'" || c === '"' || c === '`') {quote = c; continue;}
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {result.push(body.slice(start, i).trim()); start = i + 1;}
  }
  result.push(body.slice(start).trim());
  return result.filter(Boolean);
}
function shape(source, marker, spreads = {}) {
  return Object.fromEntries(properties(objectAfter(source, marker)).flatMap(property => {
    if (property.startsWith('...')) {
      const name = property.slice(3).trim();
      assert.ok(spreads[name], `Unreviewed schema spread: ${name}`);
      return Object.entries(spreads[name]);
    }
    const match = /^(\w+)(?:\s*:\s*([\s\S]+))?$/u.exec(property);
    assert.ok(match, `Unreviewed source shape: ${property}`);
    return [[match[1], !/\.(?:optional|default)\(/u.test(match[2] || '')]];
  }));
}
function assertShape(input, fields, label) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), label);
  for (const key of Object.keys(input)) assert.ok(Object.hasOwn(fields, key), `${label}: unknown field ${key}`);
  for (const [key, required] of Object.entries(fields)) if (required) assert.ok(Object.hasOwn(input, key), `${label}: missing ${key}`);
}
const generationFields = shape(images, 'const generation=');
// The audited examples use the pre-Comfy providers. Verify their branch still
// participates in the public union before inspecting that branch's fields.
assert.ok(images.includes('const generate=z.union([legacyGenerate,comfyGenerate])'));
const generateFields = shape(images, 'const legacyGenerate=z.object(', {generation: generationFields});
const imagePage = shape(images, 'const page=');
const timelineMutation = shape(contracts, 'const timelineMutation=');
const clipFields = shape(contracts, 'const clipFields=');
const inspectionPage = shape(inspection, 'const page =');
const inspectionProject = shape(inspection, 'schema.extend(');
function fieldsFor(operation) {
  if (operation === 'image.generate') return generateFields;
  if (operation === 'timeline.clip.add') return shape(contracts, `'${operation}':z.object(`, {timelineMutation, clipFields});
  if (operation === 'timeline.render') return shape(contracts, `'${operation}':z.object(`, {timelineMutation});
  if (operation.endsWith('.inspect')) return {...(/^(?:asset|shot)\./u.test(operation) ? inspectionPage : {}), ...inspectionProject};
  if (operation === 'timeline.export.preflight') return shape(preflight, `'${operation}': z.object(`);
  if (operation.startsWith('image.review.')) return shape(reviews, `'${operation}': z.object(`);
  if (operation.startsWith('image.')) return shape(images, `'${operation}':z.object(`, {page: imagePage});
  return shape(contracts, `'${operation}':z.object(`);
}
const catalogKeys = source => [...source.matchAll(/^\s*'([\w.]+)':/gmu)].map(match => match[1]);
const publicOperations = new Set([
  ...catalogKeys(contracts.slice(contracts.indexOf('export const schemas='), contracts.indexOf('// A new operation'))),
  ...catalogKeys(images.slice(images.indexOf('export const imageSchemas='), images.indexOf('export const imageSnapshotSchema='))),
  ...catalogKeys(reviews.slice(reviews.indexOf('export const imageReviewSchemas'), reviews.indexOf('// Deliberately not part'))),
  ...catalogKeys(inspection), ...catalogKeys(preflight),
]);

// The actual public source map must still include each audited schema family.
for (const name of ['imageSchemas', 'imageReviewSchemas', 'inspectionSchemas', 'exportPreflightSchemas'])
  assert.ok(contracts.includes(`...${name},`), `Public schema family is no longer included: ${name}`);

test('every CLI draft uses real public operations, flags and the documented input layer', () => {
  assert.ok(examples.length >= 25);
  assert.equal(new Set(blocks.map(match => match[1])).size, blocks.length);
  assert.equal(examples.length, [...document.matchAll(/^node apps\/cli\/src\/index\.mjs /gmu)].length);
  for (const item of examples) {
    const {operation, options, words} = item;
    if (item.effect === 'offline') {
      assert.ok(options.help || options.version || words[0] === 'schema');
      if (words[0] === 'schema') assert.ok(publicOperations.has(words.slice(1).join('.')));
      continue;
    }
    assert.ok(publicOperations.has(operation) || ['doctor', 'capabilities', ...watchOperations, ...downloadOperations].includes(operation), operation);
    if (options.file !== undefined) assert.equal(operation, 'asset.import');
    if (options.output !== undefined) assert.ok(downloadOperations.includes(operation));
    if (options['interval-ms'] !== undefined) assert.ok(watchOperations.includes(operation));
    if (options['timeout-ms'] !== undefined) assert.ok([...watchOperations, ...downloadOperations].includes(operation));
    assert.equal(Object.hasOwn(item.input, 'operation'), false, 'CLI --input must not wrap the HTTP envelope');
  }
});

test('literal draft fields follow current source shapes without third-party runtime imports', () => {
  for (const item of examples.filter(item => publicOperations.has(item.operation))) {
    // --file supplies these two metadata fields and base64 from the authorized
    // local file at real execution time. No file is opened in this static test.
    const input = item.operation === 'asset.import' && item.options.file
      ? {...item.input, name:'example.png', mimeType:'image/png', dataBase64:''} : item.input;
    assertShape(input, fieldsFor(item.operation), item.operation);
    if (item.operation === 'image.review.prepare') assertShape(input.input, generateFields, 'nested generation');
  }
  assert.throws(() => assertShape({...example('image.review.prepare').input, requestId:'wrong-level'}, fieldsFor('image.review.prepare'), 'prepare'), /unknown field requestId/u);
  assert.throws(() => assertShape({projectId:'x', versionId:'x'}, fieldsFor('version.list'), 'version'), /unknown field projectId/u);
});

test('read/write labels agree with the actual effect catalog, including lazy reads and preflight', () => {
  for (const item of examples) {
    if (item.effect === 'offline' || item.effect === 'local-write') continue;
    const operation = ['doctor','capabilities'].includes(item.operation) ? 'provider.list'
      : watchOperations.includes(item.operation) ? item.operation.replace(/\.watch$/u, '.get') : item.operation;
    const effects = operationEffects[operation];
    assert.ok(effects, operation);
    assert.equal(effects.readOnly, item.effect !== 'write', operation);
    if (item.effect === 'read') assert.equal(effects.localProcess, false, `${operation}: not a metadata-only read`);
    if (item.effect === 'read-local-process') assert.equal(effects.localProcess, true, operation);
  }
  assert.equal(example('timeline.get').effect, 'write');
  assert.equal(example('timeline.export.preflight').effect, 'read-local-process');
  assert.equal(example('export.download').effect, 'local-write');
  assert.match(read('packages/client/src/download.mjs'), /open\(destination, 'wx', 0o600\)/u);
  assert.equal(operationEffects['image.review.prepare'].paidGeneration, false);
  assert.equal(operationEffects['image.review.prepare'].externalIO, false);
});

test('image drafts retain fixed options, nested stable identity and only Mock direct generation', () => {
  const fixed = Object.fromEntries(properties(objectAfter(images, 'IMAGE_FIXED_OPTIONS=Object.freeze(')).map(field => {
    const [key, value] = field.split(':').map(part => part.trim());
    return [key, value.startsWith("'") ? value.slice(1,-1) : Number(value)];
  }));
  for (const item of examples.filter(item => ['image.generate', 'image.review.prepare'].includes(item.operation))) {
    const input = item.operation === 'image.generate' ? item.input : item.input.input;
    assert.deepEqual(input.options, fixed);
    assert.ok(objectAfter(images, 'IMAGE_MODELS=Object.freeze(').includes(`${input.providerId}:'${input.model}'`), 'Model must match its declared provider');
    assert.equal(typeof input.requestId, 'string');
    assert.ok(input.requestId.length >= 8 && input.requestId.length <= 200);
    assert.equal(Object.hasOwn(input, 'groupId'), Object.hasOwn(input, 'expectedRevision'));
    if (item.operation === 'image.generate') assert.equal(input.providerId, 'mock');
    else {
      assert.equal(Object.hasOwn(item.input, 'requestId'), false);
      assert.equal(item.options['request-id'], undefined);
      assert.ok(Number.isSafeInteger(item.input.settingsRevision) && item.input.settingsRevision > 0);
    }
  }
});

test('external examples cannot expose private settings or approval; UI handoff remains explicit', () => {
  const publicReviews = [...publicOperations].filter(name => name.startsWith('image.review.')).sort();
  assert.deepEqual(publicReviews, ['image.review.get','image.review.list','image.review.prepare']);
  assert.ok(![...publicOperations].some(name => /^image\.(?:settings|review\.(?:approve|reject))/u.test(name)));
  assert.ok(images.includes('export const imageProfileResponseSchema=z.union([legacyProfileResponseSchema,'));
  assert.equal(Object.hasOwn(shape(images, 'const legacyProfileResponseSchema=z.object('), 'revision'), false);
  assert.match(document, /用户从对应 Images 设置槽交接/u);
  assert.match(document, /亲自点击“批准并付费生成”/u);
  assert.match(document, /image request get` 为 null 是正常的/u);
  for (const [, , , body] of blocks) assert.doesNotMatch(body, /\/api\/images\//u);
});

test('MCP names preserve actual dot mapping and case, without inventing watch tools', () => {
  assert.ok(client.includes("toolName: operation.replaceAll('.', '_')"));
  const rows = [...document.matchAll(/^\| `([\w.]+)` \| `([\w]+)` \|$/gmu)];
  assert.ok(rows.length >= 6);
  for (const [, operation, tool] of rows) {
    assert.ok(publicOperations.has(operation), operation);
    assert.equal(tool, operation.replaceAll('.', '_'));
  }
  assert.deepEqual(watchOperations, ['job.watch','export.watch']);
  assert.match(document, /没有 `image watch` \/ `image task watch`/u);
});

test('audit links resolve inside this checkout and every code fence is closed', () => {
  for (const [, target] of document.matchAll(/\]\(([^)]+)\)/gu)) {
    assert.equal(/^https?:/u.test(target), false, 'This audit cites repository evidence only');
    const file = path.resolve(root, 'docs', target.split('#')[0]);
    assert.ok(!path.relative(root, file).startsWith('..'));
    assert.ok(statSync(file).isFile(), target);
  }
  assert.equal((document.match(/^```/gmu) || []).length % 2, 0);
});
