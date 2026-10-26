import type {UiPreferencesResponse} from '../packages/contracts/src/ui-preferences.ts';
import type {RootFailure} from './helpers/strict-root-error-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiPreferencesClient } from '../apps/web/src/ui-preferences-client.ts';
import { DEFAULT_UI_PREFERENCES } from '../packages/contracts/src/ui-preferences.ts';

const id = '11111111-1111-4111-8111-111111111111';
const envelope = (patch: Partial<UiPreferencesResponse> = {}) => ({ revision: 2, preferences: { ...DEFAULT_UI_PREFERENCES }, recentOpened: {}, recoveredDefaults: false, writable: true, ...patch });
const response = (data: unknown) => Response.json({ ok: true, data });

test('private preference reads and writes use cookie authentication and validate exact acknowledgements', async () => {
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  const client = createUiPreferencesClient(async (url, options) => {
    calls.push([url, options]);
    return response(envelope());
  });
  assert.equal((await client.get()).revision, 2);
  const input = { expectedRevision: 1, requestId: 'fixed-preference-request', preferences: { ...DEFAULT_UI_PREFERENCES } };
  await client.put(input); await client.put(input);
  assert.deepEqual(calls.map(([url, options]) => [url, (options)!.method, (options)!.credentials]), [
    ['/api/ui-preferences', 'GET', 'same-origin'], ['/api/ui-preferences', 'PUT', 'same-origin'], ['/api/ui-preferences', 'PUT', 'same-origin'],
  ]);
  assert.equal((calls[1][1])!.body, (calls[2][1])!.body);
  assert.deepEqual(JSON.parse((calls[1][1])!.body as string), input);
  assert.equal((calls[0][1])!.cache, 'no-store');
  assert.ok(calls.every(([, options]) => (options)!.signal instanceof AbortSignal));
});

test('invalid writes never reach HTTP and malformed or unrelated acknowledgements fail closed', async () => {
  let calls = 0;
  const client = createUiPreferencesClient(async () => { calls++; return response(envelope()); });
  const input = { expectedRevision: 1, requestId: 'fixed-preference-request', preferences: { ...DEFAULT_UI_PREFERENCES } };
  for (const value of [{ ...input, preferences: { ...input.preferences, scalePercent: 200 } }, { ...input, extra: true }, { ...input, requestId: '' }]) await assert.rejects(client.put(value), { code: 'UI_PREFERENCES_VALIDATION' });
  await assert.rejects(client.opened('not-a-project'), { code: 'UI_PREFERENCES_VALIDATION' });
  assert.equal(calls, 0);
  for (const data of [envelope({ revision: 1 }), envelope({ revision: 3 }), envelope({ preferences: { ...DEFAULT_UI_PREFERENCES, density: 'compact' } }), envelope({ writable: false }), envelope({ recoveredDefaults: true }), { ...envelope(), secret: 'synthetic' }]) {
    const invalid = createUiPreferencesClient(async () => response(data));
    await assert.rejects(invalid.put(input), { code: 'UI_PREFERENCES_PROTOCOL' });
  }
});

test('recent-opened requests require the requested UUID in the response and do not change display preferences', async () => {
  const input = envelope({ recentOpened: { [id]: '2026-10-19T00:00:00.000Z' } });
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  const client = createUiPreferencesClient(async (url, options) => { calls.push([url, options]); return response(input); });
  assert.deepEqual((await client.opened(id)).preferences, DEFAULT_UI_PREFERENCES);
  assert.equal(calls[0][0], '/api/ui-preferences/opened');
  assert.equal((calls[0][1])!.method, 'POST'); assert.deepEqual(JSON.parse((calls[0][1])!.body as string), { projectId: id });
  await assert.rejects(createUiPreferencesClient(async () => response(envelope())).opened(id), { code: 'UI_PREFERENCES_PROTOCOL' });
});

test('untrusted failures expose only bounded codes and oversized responses are rejected', async () => {
  const client = createUiPreferencesClient(async () => Response.json({ ok: false, error: { code: 'UI_PREFERENCES_CONFLICT', message: '/private/synthetic-secret' } }, { status: 409 }));
  await assert.rejects(client.get(), error => (error as RootFailure).code === 'UI_PREFERENCES_CONFLICT' && !(error as RootFailure).message.includes('private'));
  await assert.rejects(createUiPreferencesClient(async () => new Response('x'.repeat(1024 * 1024 + 1))).get(), { code: 'UI_PREFERENCES_PROTOCOL' });
  await assert.rejects(createUiPreferencesClient(async () => { throw new Error('secret diagnostic'); }).get(), { code: 'UI_PREFERENCES_NETWORK' });
});
