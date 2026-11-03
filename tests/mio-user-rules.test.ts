import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createMioUserRules, USER_RULES_SAVE_OPERATION} from '../packages/business/src/agent/mio-user-rules.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-user-rules-'));
  let library = openAppLibrary({dataDir: root}), service = createMioUserRules(library);
  t.after(() => {library.close(); rmSync(root, {recursive: true, force: true});});
  return {get library() {return library;}, get service() {return service;},
    reopen() {library.close(); library = openAppLibrary({dataDir: root}); service = createMioUserRules(library);},
    rows() {return {rules: library.db.prepare('SELECT * FROM user_rules').all(), receipts: library.db.prepare('SELECT * FROM app_operation_receipts ORDER BY operation,requestId').all()};},
    changes() {return library.db.prepare('SELECT total_changes() AS n').get()!.n;},
  };
}

test('B1 user rules default, exact CRLF/byte boundaries, CAS and original receipts survive reopening', t => {
  const f = fixture(t), requestId = randomUUID(), initial = {text: '', revision: 0, updatedAt: null, maxBytes: 8192};
  assert.deepEqual(f.service.read(), initial); assert.deepEqual(f.service.lookup(requestId), {requestId, status: 'not_applied', result: null});
  const firstInput = {requestId, expectedRevision: 0, text: 'a\r\n'.repeat(2730) + 'ab'}, first = f.service.save(firstInput);
  assert.equal(Buffer.byteLength(first.text), 8192); assert.equal(first.text, firstInput.text); assert.equal(first.revision, 1); assert.ok(first.updatedAt);
  const second = f.service.save({requestId: randomUUID(), expectedRevision: 1, text: ''}); assert.equal(second.revision, 2); assert.equal(second.text, '');
  const before = f.rows(), writes = f.changes();
  assert.deepEqual(f.service.save(firstInput), first); assert.deepEqual(f.rows(), before); assert.equal(f.changes(), writes);
  f.reopen(); const reopenedWrites = f.changes();
  assert.deepEqual(f.service.lookup(requestId), {requestId, status: 'applied', result: first}); assert.deepEqual(f.service.read(), second);
  assert.deepEqual(f.service.save(firstInput), first); assert.equal(f.changes(), reopenedWrites);
  assert.equal(f.library.db.prepare('SELECT count(*) AS n FROM app_operation_receipts WHERE operation=?').get(USER_RULES_SAVE_OPERATION)!.n, 2);
});

test('stale CAS and changed replay input reject without receipt or user-rule mutation', t => {
  const f = fixture(t), requestId = randomUUID(), input = {requestId, expectedRevision: 0, text: 'original'};
  f.service.save(input); const before = f.rows(), stale = randomUUID();
  assert.throws(() => f.service.save({...input, requestId: stale}), {code: 'MIO_RULES_CONFLICT'});
  for (const changed of [{...input, text: 'changed'}, {...input, expectedRevision: 1}]) assert.throws(() => f.service.save(changed), {code: 'MIO_RULES_REQUEST_CONFLICT'});
  assert.deepEqual(f.service.lookup(stale), {requestId: stale, status: 'not_applied', result: null}); assert.deepEqual(f.rows(), before);
});

test('receipt insertion failure rolls back the actual user-rule CAS in the same application transaction', t => {
  const f = fixture(t), input = {requestId: randomUUID(), expectedRevision: 0, text: 'never half committed'}, before = f.rows();
  f.library.db.exec(`CREATE TEMP TRIGGER fail_user_rule_receipt BEFORE INSERT ON app_operation_receipts WHEN NEW.operation='${USER_RULES_SAVE_OPERATION}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC receipt fault');END`);
  assert.throws(() => f.service.save(input), {code: 'MIO_RULES_UNAVAILABLE'}); assert.deepEqual(f.rows(), before);
  assert.deepEqual(f.service.lookup(input.requestId), {requestId: input.requestId, status: 'not_applied', result: null});
  f.library.db.exec('DROP TRIGGER fail_user_rule_receipt');
  assert.equal(f.service.save(input).revision, 1); f.reopen(); assert.equal(f.service.lookup(input.requestId).status, 'applied');
});

test('invalid authority/text and overflow cannot mutate B1, and an outer transaction cannot receive an uncommitted success', t => {
  const f = fixture(t), input = {requestId: randomUUID(), expectedRevision: 0, text: ''}, before = f.rows();
  for (const extra of [{approved: true}, {path: '/private'}, {text: '\ud800'}, {text: '🙂'.repeat(2048) + 'a'}, {expectedRevision: -1}]) assert.throws(() => f.service.save({...input, ...extra}), {code: 'MIO_RULES_INVALID'});
  f.library.tx(() => assert.throws(() => f.service.save(input), {code: 'MIO_RULES_UNAVAILABLE'})); assert.deepEqual(f.rows(), before);
  assert.throws(() => f.service.save({...input, expectedRevision: Number.MAX_SAFE_INTEGER}), {code: 'MIO_RULES_CONFLICT'}); assert.deepEqual(f.rows(), before);
});

test('lookup is read-only and scoped to user-rule receipts; shutdown and corrupt public receipt shapes fail closed', t => {
  const f = fixture(t), requestId = randomUUID();
  f.library.receipts.write({operation: 'project.rename', requestId, digest: 'a'.repeat(64), response: {name: 'other namespace'}, createdAt: new Date().toISOString()});
  const before = f.rows(), writes = f.changes();
  assert.deepEqual(f.service.lookup(requestId), {requestId, status: 'not_applied', result: null}); f.service.read(); assert.deepEqual(f.rows(), before); assert.equal(f.changes(), writes);
  f.library.receipts.write({operation: USER_RULES_SAVE_OPERATION, requestId, digest: 'b'.repeat(64), response: {path: '/private/synthetic'}, createdAt: new Date().toISOString()});
  assert.throws(() => f.service.lookup(requestId), {code: 'MIO_RULES_UNAVAILABLE'});
  const controller = new AbortController(), stopped = createMioUserRules(f.library, {signal: controller.signal}); controller.abort();
  assert.throws(() => stopped.save({requestId: randomUUID(), expectedRevision: 0, text: ''}), {code: 'MIO_RULES_UNAVAILABLE'});
  assert.throws(() => stopped.read(), {code: 'MIO_RULES_UNAVAILABLE'}); assert.throws(() => stopped.lookup(requestId), {code: 'MIO_RULES_UNAVAILABLE'});
});
