import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createImageSettingsFile} from '../packages/business/src/images/settings-file.ts';
import {createCustomImageSettingsV2File} from '../packages/business/src/images/custom-settings-v2-file.ts';
import {createGenerationImageServicesClient,createGenerationImageServicesOwner} from '../apps/web/src/generation-image-services-settings.ts';
import {createImageHttp} from '../apps/server/src/image-http.ts';
import {createImageSettings} from '../packages/business/src/images/settings.ts';
import {createCustomImageSettingsV2} from '../packages/business/src/images/custom-settings-v2.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, CUSTOM_IMAGE_SETTINGS_V2_LIMITS} from '../packages/contracts/src/generation-image-settings.ts';
const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: 'custom-image'};
const SENTINEL = 'synthetic-http-private-key';
const memory = (): {load(): Promise<unknown>; save(value: unknown): Promise<void>} => { let stored: unknown = null; return {load: async () => structuredClone(stored), save: async (value: unknown) => { stored = structuredClone(value); }}; };
interface HttpBody {data?: {configuration?: Record<string, unknown>; connections?: Array<{connectionId:string;configurationRevision:number;secret:{storage:string}}>; [key: string]: unknown}; error?: {code?: string}; [key: string]: unknown}
interface FixtureResponse {headers: Record<string, unknown>; code: number|null; text: string|null; handled?: boolean; body: HttpBody|null}
interface HttpRequestOptions {method?: string; input?: unknown; bytes?: Buffer; headers?: Record<string, string>}
async function fixture(t: unknown, {probeFetch, directory}: {probeFetch?: typeof fetch; directory?: string} = {}) {
  const settings = await createImageSettings({persistence: directory ? createImageSettingsFile({directory}) : memory()});
  const customSettings = await createCustomImageSettingsV2({persistence: directory ? createCustomImageSettingsV2File({directory}) : memory()});
  (t as {after(callback: ()=>Promise<void>): void}).after(async () => { await settings.close(); await customSettings.close(); });
  const route = createImageHttp({settings, customSettings, probeFetch, approve: () => assert.fail('Not an approval route'), reject: () => assert.fail('Not a rejection route')});
  return {settings, customSettings, async request(path = '/api/images/custom-settings', {method = 'GET', input, bytes, headers = {}}: HttpRequestOptions = {}): Promise<FixtureResponse> {
    const req = Readable.from(bytes ? [bytes] : input === undefined ? [] : [Buffer.from(JSON.stringify(input))]) as Readable & {url?: string; method?: string; headers?: Record<string, unknown>};
    req.url = path; req.method = method; req.headers = {'content-type': 'application/json', ...headers};
    const result: FixtureResponse = {headers: {}, code: null, text: null, body: null};
    const res = Object.assign(new EventEmitter(), {setHeader(key: string, value: unknown) { result.headers[key] = value; }, writeHead(code: number, headers: Record<string, unknown>) { result.code = code; Object.assign(result.headers, headers); },
      end(text?: string) { result.text = text ?? null; }, destroy() { assert.fail('Unexpected response destruction'); }});
    result.handled = await (route as unknown as (a: unknown, b: unknown, c: URL)=>Promise<boolean>)(req, res, new URL(path, 'http://localhost'));
    result.body = result.text ? JSON.parse(result.text) as HttpBody : null;
    return result;
  }};
}

test('custom HTTP GET/PUT targets only its slot, strips all secrets, and leaves official endpoint DTO unchanged', async t => {
  const f = await fixture(t), officialBefore = await f.request('/api/images/settings');
  assert.deepEqual(officialBefore.body?.data?.configuration, DEFAULT_IMAGE_CONFIGURATION);
  const initial = await f.request(); assert.deepEqual(initial.body?.data?.connections, []);
  assert.equal(initial.headers['Cache-Control'], 'no-store');
  const connectionId=randomUUID();
  const saved = await f.request(undefined, {method: 'PUT', input: {action:'create',expectedRevision: 0,connectionId,name:'Custom A',configuration, secret: {action: 'replace', storage: 'session', value: SENTINEL}}});
  assert.equal(saved.code, 200); assert.equal(saved.body?.data?.connections?.[0].secret.storage, 'session'); assert.equal(saved.text?.includes(SENTINEL), false);
  assert.deepEqual((await f.request('/api/images/settings')).body, officialBefore.body);
  const stale = await f.request(undefined, {method: 'PUT', input: {action:'put',expectedRevision: 0,connectionId,expectedConfigurationRevision:1,name:'Custom A',configuration, secret: {action: 'remove'}}});
  assert.equal(stale.code, 409); assert.equal(stale.body?.error?.code, 'IMAGE_SETTINGS_CONFLICT');
  const cross = await f.request('/api/images/settings', {method: 'PUT', input: {expectedRevision: 0, configuration, secret: {action: 'replace', storage: 'session', value: SENTINEL}}});
  assert.equal(cross.code, 400); assert.equal(cross.text?.includes(SENTINEL), false);
  assert.deepEqual((await f.request('/api/images/settings')).body, officialBefore.body);
  for(const input of [{expectedRevision:1,configuration,secret:{action:'keep'}},{action:'restoreCredential',expectedRevision:1,connectionId}])assert.equal((await f.request(undefined,{method:'PUT',input})).code,400);
  const changed=await f.request(undefined,{method:'PUT',input:{action:'batch',expectedRevision:1,operations:[{action:'put',connectionId,expectedConfigurationRevision:1,name:'Custom A',configuration:{...configuration,model:'next-model'},secret:{action:'keep'}}]}});
  assert.equal(changed.code,200);assert.equal(changed.body?.data?.connections?.[0].configurationRevision,2);
  const removed=await f.request(undefined,{method:'PUT',input:{action:'remove',expectedRevision:2,connectionId,expectedConfigurationRevision:2}});
  assert.equal(removed.code,200);assert.deepEqual(removed.body?.data?.connections,[]);
});

test('custom HTTP route shares strict methods, query/body/encoding/size guards and sanitized failures', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/images/custom-settings/')).code, 404);
  assert.equal((await f.request('/api/images/custom-settings?apiKey=' + SENTINEL)).code, 400);
  const method = await f.request(undefined, {method: 'PATCH'}); assert.equal(method.code, 405); assert.equal(method.headers.Allow, 'GET, PUT, POST');
  assert.equal((await f.request(undefined, {method: 'POST', input: {}})).code, 400);
  const invalidOptions: HttpRequestOptions[] = [{headers: {'content-type': 'text/plain'}, input: {}}, {headers: {'content-encoding': 'gzip'}, input: {}},
    {headers: {'content-length': '01'}, input: {}}, {bytes: Buffer.from([0xff])}, {input: []}, {input: {apiKey: SENTINEL}}];
  for (const options of invalidOptions) {
    const result = await f.request(undefined, {method: 'PUT', ...options}); assert.equal(result.code, 400); assert.equal(result.text?.includes(SENTINEL), false);
  }
  const largeOptions: HttpRequestOptions[] = [{headers: {'content-length': String(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes+1)}}, {bytes: Buffer.from('x'.repeat(CUSTOM_IMAGE_SETTINGS_V2_LIMITS.updateBytes+1))}];
  for (const options of largeOptions) {
    const result = await f.request(undefined, {method: 'PUT', ...options}); assert.equal(result.code, 413); assert.equal(result.headers.Connection, 'close');
  }
  assert.equal((await f.customSettings.get()).revision, 0);
  assert.equal((await f.request('/not-images')).handled, false);
});

test('official and custom settings probe the current field without saving and require a fresh key for a new destination', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-image-draft-probe-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const original = 'synthetic-image-old-key';
  const proposed = 'synthetic-image-draft-key';
  const alternative = 'synthetic-image-other-draft';
  const requests: Array<[string, string | null]> = [];
  let remoteFailure = false, badPayload = false;
  const f = await fixture(t, {directory, probeFetch: async (url, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    const auth = new Headers(init.headers).get('authorization');
    requests.push([String(url), auth]);
    if (remoteFailure) throw Error('synthetic-image-draft-key');
    if (badPayload) return new Response('<html>synthetic-image-draft-key</html>');
    return Response.json({data: [{id: 'model-a'}, {id: 'model-a'}, {id: auth?.slice(7)}, {id: 'model-b', name: proposed}]});
  }});
  const customId = randomUUID();
  await f.settings.put({expectedRevision: 0, configuration: DEFAULT_IMAGE_CONFIGURATION, secret: {action: 'replace', storage: 'session', value: original}});
  await f.customSettings.create({expectedRevision: 0, connectionId: customId, name: 'Custom', configuration, secret: {action: 'replace', storage: 'session', value: original}});

  for (const kind of ['official', 'custom'] as const) {
    const route = kind === 'official' ? '/api/images/settings' : '/api/images/custom-settings';
    const id = kind === 'official' ? 'image:official' : customId;
    const responses: string[] = [], states: unknown[] = [];
    const client = createGenerationImageServicesClient(kind, async (request, init) => {
      assert.equal(String(request), route);
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      const result = await f.request(route, {method: init?.method, ...(init?.body ? {input: JSON.parse(String(init.body))} : {})});
      responses.push(result.text!);
      return new Response(result.text, {status: result.code!});
    });
    const owner = createGenerationImageServicesOwner(kind, {client, onChange: state => states.push(state)});
    t.after(() => owner.dispose());
    await owner.load();
    const initial = (await f.request(route)).body;
    const disk = path.join(directory, kind === 'official' ? 'settings.json' : 'custom-settings.json');
    const bytes = await readFile(disk, 'utf8');
    const field = {value: proposed};
    owner.registerKey(id, field);
    owner.keyChanged(id);
    assert.equal(owner.isDirty(id), true);
    const endpoint = kind === 'official' ? 'https://api.openai.com/v1' : configuration.baseUrl;
    assert.deepEqual(await owner.checkCredential(id, 'check'), {result: 'ok'});
    assert.deepEqual(await owner.checkCredential(id, 'models'), {result: 'ok', models: [{id: 'model-a'}, {id: 'model-b'}]});
    assert.deepEqual(requests.slice(-2), [[endpoint + '/models', 'Bearer ' + proposed], [endpoint + '/models', 'Bearer ' + proposed]]);
    assert.equal(field.value, proposed, 'checking keeps the form value for an explicit Save');
    remoteFailure = true;
    assert.deepEqual(await owner.checkCredential(id, 'models'), {result: 'unreachable'});
    remoteFailure = false;
    badPayload = true;
    assert.deepEqual(await owner.checkCredential(id, 'check'), {result: 'failed'});
    badPayload = false;
    assert.deepEqual((await f.request(route)).body, initial);
    assert.equal(await readFile(disk, 'utf8'), bytes);

    owner.discard();
    assert.equal(field.value, '');
    assert.equal(owner.isDirty(id), false);
    assert.deepEqual(await owner.checkCredential(id, 'check'), {result: 'ok'});
    assert.deepEqual(requests.at(-1), [endpoint + '/models', 'Bearer ' + original]);

    if (kind === 'custom') {
      const changed = 'https://other.example.com/new';
      const before = requests.length;
      assert.equal(owner.edit(id, {}, {baseUrl: changed}), true);
      assert.equal(owner.canProbe(id), false);
      assert.equal(await owner.checkCredential(id, 'check'), null);
      const rejected = await f.request(route, {method: 'POST', input: {operation: 'check', baseUrl: changed, credential: {
        source: 'saved', connectionId: id, configurationRevision: 1,
      }}});
      assert.equal(rejected.code, 409);
      assert.equal(requests.length, before);
      field.value = alternative;
      owner.keyChanged(id);
      assert.deepEqual(await owner.checkCredential(id, 'check'), {result: 'ok'});
      assert.deepEqual(requests.at(-1), [changed + '/models', 'Bearer ' + alternative]);
      owner.discard();
    }

    field.value = proposed;
    owner.keyChanged(id);
    const ticket = owner.prepareSave()!;
    assert.equal(await ticket.run(), 'saved');
    ticket.dispose();
    assert.equal(field.value, '');
    assert.deepEqual(await owner.checkCredential(id, 'check'), {result: 'ok'});
    assert.deepEqual(requests.at(-1), [endpoint + '/models', 'Bearer ' + proposed]);
    assert.doesNotMatch(await readFile(disk, 'utf8') + JSON.stringify([states,responses]), /synthetic-image-(?:old-key|draft-key|other-draft)/);
  }
});
