import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createImageHttp} from '../apps/server/src/image-http.ts';
import {createImageSettings, createCustomImageSettings} from '../packages/business/src/images/settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION, DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image'};
const SENTINEL = 'synthetic-http-private-key';
const memory = (): {load(): Promise<unknown>; save(value: unknown): Promise<void>} => { let stored: unknown = null; return {load: async () => structuredClone(stored), save: async (value: unknown) => { stored = structuredClone(value); }}; };
interface HttpBody {data?: {configuration?: Record<string, unknown>; secret?: {storage?: unknown; [key: string]: unknown}; [key: string]: unknown}; error?: {code?: string}; [key: string]: unknown}
interface FixtureResponse {headers: Record<string, unknown>; code: number|null; text: string|null; handled?: boolean; body: HttpBody|null}
interface HttpRequestOptions {method?: string; input?: unknown; bytes?: Buffer; headers?: Record<string, string>}
async function fixture(t: unknown) {
  const settings = await createImageSettings({persistence: memory() as never}), customSettings = await createCustomImageSettings({persistence: memory() as never});
  (t as {after(callback: ()=>Promise<void>): void}).after(async () => { await settings.close(); await customSettings.close(); });
  const route = createImageHttp({settings, customSettings, approve: () => assert.fail('Not an approval route'), reject: () => assert.fail('Not a rejection route')});
  return {settings, customSettings, async request(path = '/api/images/custom-settings', {method = 'GET', input, bytes, headers = {}}: HttpRequestOptions = {}): Promise<FixtureResponse> {
    const req = Readable.from(bytes ? [bytes] : input === undefined ? [] : [Buffer.from(JSON.stringify(input))]) as Readable & {url?: string; method?: string; headers?: Record<string, unknown>};
    req.url = path; req.method = method; req.headers = {'content-type': 'application/json', ...headers};
    const result: FixtureResponse = {headers: {}, code: null, text: null, body: null};
    const res = {setHeader(key: string, value: unknown) { result.headers[key] = value; }, writeHead(code: number, headers: Record<string, unknown>) { result.code = code; Object.assign(result.headers, headers); },
      end(text?: string) { result.text = text ?? null; }, destroy() { assert.fail('Unexpected response destruction'); }};
    result.handled = await (route as unknown as (a: unknown, b: unknown, c: URL)=>Promise<boolean>)(req, res, new URL(path, 'http://localhost'));
    result.body = result.text ? JSON.parse(result.text) as HttpBody : null;
    return result;
  }};
}

test('custom HTTP GET/PUT targets only its slot, strips all secrets, and leaves official endpoint DTO unchanged', async t => {
  const f = await fixture(t), officialBefore = await f.request('/api/images/settings');
  assert.deepEqual(officialBefore.body?.data?.configuration, DEFAULT_IMAGE_CONFIGURATION);
  const initial = await f.request(); assert.deepEqual(initial.body?.data?.configuration, DEFAULT_CUSTOM_IMAGE_CONFIGURATION);
  assert.equal(initial.headers['Cache-Control'], 'no-store');
  const saved = await f.request(undefined, {method: 'PUT', input: {expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: SENTINEL}}});
  assert.equal(saved.code, 200); assert.equal(saved.body?.data?.secret?.storage, 'session'); assert.equal(saved.text?.includes(SENTINEL), false);
  assert.deepEqual((await f.request('/api/images/settings')).body, officialBefore.body);
  const stale = await f.request(undefined, {method: 'PUT', input: {expectedRevision: 0, configuration, secret: {action: 'remove'}}});
  assert.equal(stale.code, 409); assert.equal(stale.body?.error?.code, 'IMAGE_SETTINGS_CONFLICT');
  const cross = await f.request('/api/images/settings', {method: 'PUT', input: {expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: SENTINEL}}});
  assert.equal(cross.code, 400); assert.equal(cross.text?.includes(SENTINEL), false);
  assert.deepEqual((await f.request('/api/images/settings')).body, officialBefore.body);
});

test('custom HTTP route shares strict methods, query/body/encoding/size guards and sanitized failures', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/images/custom-settings/')).code, 404);
  assert.equal((await f.request('/api/images/custom-settings?apiKey=' + SENTINEL)).code, 400);
  const method = await f.request(undefined, {method: 'POST'}); assert.equal(method.code, 405); assert.equal(method.headers.Allow, 'GET, PUT');
  const invalidOptions: HttpRequestOptions[] = [{headers: {'content-type': 'text/plain'}, input: {}}, {headers: {'content-encoding': 'gzip'}, input: {}},
    {headers: {'content-length': '01'}, input: {}}, {bytes: Buffer.from([0xff])}, {input: []}, {input: {apiKey: SENTINEL}}];
  for (const options of invalidOptions) {
    const result = await f.request(undefined, {method: 'PUT', ...options}); assert.equal(result.code, 400); assert.equal(result.text?.includes(SENTINEL), false);
  }
  const largeOptions: HttpRequestOptions[] = [{headers: {'content-length': '16385'}}, {bytes: Buffer.from('x'.repeat(16385))}];
  for (const options of largeOptions) {
    const result = await f.request(undefined, {method: 'PUT', ...options}); assert.equal(result.code, 413); assert.equal(result.headers.Connection, 'close');
  }
  assert.equal((await f.customSettings.get()).revision, 0);
  assert.equal((await f.request('/not-images')).handled, false);
});
