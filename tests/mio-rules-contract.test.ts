import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {
  RULES_MAX_BYTES, rulesTextProblem, rulesTextSchema, projectRulesToolInputSchema,
  projectRulesSaveInputSchema, projectRulesEnableInputSchema, userRulesSaveInputSchema,
  projectRulesSnapshotSchema, projectRulesRequestLookupSchema, userRulesSnapshotSchema,
  userRulesRequestLookupSchema,
} from '../packages/contracts/src/mio-rules.ts';

const projectId = randomUUID(), requestId = randomUUID(), hash = 'a'.repeat(64);
const snapshot = {projectId, file: 'AGENTS.md', exists: true, text: '', hash, trust: 'trusted', maxBytes: 8192, readError: null, pendingWrites: false};

test('rules preserve exact CRLF, Unicode and empty text at the UTF-8 boundary', () => {
  for (const text of ['', '\t\n\r\r\n', '\ufeff# rules\r\n', 'e\u0301', '🙂'.repeat(2048), '界'.repeat(2730) + 'ab', 'a\r\n'.repeat(2730) + 'ab']) {
    assert.equal(rulesTextProblem(text), null); assert.equal(rulesTextSchema.parse(text), text);
  }
  assert.equal(RULES_MAX_BYTES, 8192);
  for (const text of ['a'.repeat(8193), '🙂'.repeat(2048) + 'a', '界'.repeat(2731), 'a\r\n'.repeat(2731)]) {
    assert.equal(rulesTextProblem(text), 'tooLong'); assert.equal(rulesTextSchema.safeParse(text).success, false);
  }
  for (const code of [...Array.from({length: 32}, (_, i) => i).filter(i => ![9, 10, 13].includes(i)), ...Array.from({length: 33}, (_, i) => i + 127), 0xd800, 0xdc00]) {
    const text = 'before' + String.fromCharCode(code) + 'after';
    assert.equal(rulesTextProblem(text), 'invalid', code.toString(16)); assert.equal(rulesTextSchema.safeParse(text).success, false);
  }
});

test('U1 uses the same byte limit and CRLF/plain-text validator without rewriting text', async () => {
  const entry = fileURLToPath(new URL('../apps/web/src/project-file/ProjectRules.tsx', import.meta.url));
  const result = await build({stdin: {contents: `export {rulesProblem,rulesBytes} from ${JSON.stringify(entry)};`, resolveDir: fileURLToPath(new URL('../apps/web', import.meta.url))}, bundle: true, platform: 'node', format: 'cjs', write: false, loader: {'.css': 'empty'}, jsx: 'automatic'});
  const loaded = {exports: {}};
  Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), loaded, loaded.exports);
  const ui = loaded.exports as {rulesProblem: typeof rulesTextProblem; rulesBytes(text: string): number};
  for (const text of ['', 'a\r\n'.repeat(2730) + 'ab', '🙂'.repeat(2048), '🙂'.repeat(2048) + 'a', '\r\0', '\ud800']) {
    assert.equal(ui.rulesProblem(text, 8192), rulesTextProblem(text)); assert.equal(ui.rulesBytes(text), Buffer.byteLength(text));
  }
});

test('save, enable and model proposals reject caller-authored authority and paths', () => {
  const values = [
    [projectRulesSaveInputSchema, {requestId, expectedHash: null, text: '\r\n'}],
    [projectRulesEnableInputSchema, {requestId, expectedHash: hash}],
    [projectRulesToolInputSchema, {expectedHash: hash, proposedText: ''}],
    [userRulesSaveInputSchema, {requestId, expectedRevision: 0, text: ''}],
  ] as const;
  for (const [schema, input] of values) {
    assert.deepEqual(schema.parse(input), input);
    for (const extra of [{approved: true}, {trust: 'trusted'}, {path: '../AGENTS.md'}, {projectId}, {file: 'OTHER.md'}]) assert.equal(schema.safeParse({...input, ...extra}).success, false);
  }
  assert.equal(projectRulesEnableInputSchema.safeParse({requestId, expectedHash: null}).success, false);
  assert.equal(projectRulesSaveInputSchema.safeParse({requestId, text: ''}).success, false);
  assert.equal(projectRulesEnableInputSchema.safeParse({requestId, expectedHash: hash + '\n'}).success, false);
  for (const id of ['invalid\ud800', 'invalid\0']) assert.equal(projectRulesSaveInputSchema.safeParse({requestId: id, expectedHash: null, text: ''}).success, false);
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(userRulesSaveInputSchema.safeParse({requestId, expectedRevision, text: ''}).success, false);
});

test('strict snapshots distinguish absent, unavailable and pending from trusted content', () => {
  assert.deepEqual(projectRulesSnapshotSchema.parse(snapshot), snapshot);
  for (const value of [
    {...snapshot, exists: false, text: null, hash: null, trust: 'absent'},
    {...snapshot, text: null, hash: null, trust: 'unavailable', readError: 'invalid_utf8'},
    {...snapshot, exists: false, text: null, hash: null, trust: 'pending', pendingWrites: true},
  ]) assert.equal(projectRulesSnapshotSchema.safeParse(value).success, true);
  for (const patch of [{text: null}, {hash: null}, {exists: false}, {pendingWrites: true}, {trust: 'unavailable'}, {readError: 'private /path'}, {path: '/private/project'}, {text: 'x'.repeat(8193)}]) assert.equal(projectRulesSnapshotSchema.safeParse({...snapshot, ...patch}).success, false);
  const user = {text: '', revision: 0, updatedAt: null, maxBytes: 8192};
  assert.deepEqual(userRulesSnapshotSchema.parse(user), user);
  assert.equal(userRulesSnapshotSchema.safeParse({...user, credential: 'private'}).success, false);
});

test('lookup exposes bounded write states and binds applied receipts to their project', () => {
  const identity = {projectId, requestId};
  for (const value of [
    {...identity, status: 'not_applied', state: null, result: null},
    {...identity, status: 'not_applied', state: 'not_applied', result: null},
    {...identity, status: 'applied', state: 'completed', result: snapshot},
    ...['prepared', 'publication_unknown', 'published', 'trust_pending'].map(state => ({...identity, status: 'uncertain', state, result: null})),
  ]) assert.equal(projectRulesRequestLookupSchema.safeParse(value).success, true);
  assert.equal(projectRulesRequestLookupSchema.safeParse({...identity, status: 'applied', state: 'completed', result: {...snapshot, projectId: randomUUID()}}).success, false);
  assert.equal(projectRulesRequestLookupSchema.safeParse({...identity, status: 'uncertain', state: 'completed', result: snapshot}).success, false);
  assert.equal(projectRulesRequestLookupSchema.safeParse({...identity, status: 'uncertain', state: 'prepared', result: null, backup: '/private'}).success, false);
  assert.equal(userRulesRequestLookupSchema.safeParse({requestId, status: 'uncertain', result: null}).success, false);
});
