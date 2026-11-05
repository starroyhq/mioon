import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, writeFileSync, lstatSync, rmSync, linkSync, symlinkSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createProjectTrashBroker, createProjectTrashClient} from '../apps/desktop/src/project-trash-broker.ts';
import {BackendSupervisor} from '../apps/desktop/src/supervisor.ts';
import type {BackendUtilityProcess} from '../apps/desktop/src/supervisor.ts';
import type {ProjectTrashNativeOptions} from '../apps/desktop/src/project-trash-broker.ts';
import {ProjectTrashRefusedError, projectTrashFileGenerationSchema, projectTrashRequestSchema} from '../packages/contracts/src/project-trash-native.ts';
import type {ProjectTrashRequest} from '../packages/contracts/src/project-trash-native.ts';
import {nativeText, setNativeLanguageReader} from '../apps/desktop/src/app-language-text.ts';
import type {Locale} from '../packages/i18n/src/types.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Port extends EventEmitter {sent: unknown[] = []; postMessage(_value: unknown): void {}}
function generation(file: string): ProjectTrashRequest['fileIdentity'] {
  const info = lstatSync(file, {bigint: true});
  return {dev: String(info.dev), ino: String(info.ino), size: Number(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), birthtimeNs: String(info.birthtimeNs)};
}
function fixture(t: test.TestContext, options: {native?: boolean; busy?: boolean; timeout?: number; reservationTimeout?: number; trashItem?(): Promise<void>} = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mioon-trash-broker-'))), file = path.join(root, 'project.mioon');
  writeFileSync(file, 'synthetic ordinary project bytes');
  const port = new Port(), replies: unknown[] = [], actions = new Set<string>();
  let active = true, drop = false, calls = 0, releases = 0;
  const native: ProjectTrashNativeOptions | undefined = options.native === false ? undefined : {
      reserveClosedProjectAction(projectId) {
        if (options.busy || actions.has(projectId)) return null;
        actions.add(projectId); let released = false;
        return {isCurrent: () => active && !released, release() {if (!released) {released = true; actions.delete(projectId); releases++;}}};
      },
      async trashItem() {calls++; await options.trashItem?.();},
    };
  const broker = createProjectTrashBroker({native,
    send: data => {replies.push(data); if (!drop) port.emit('message', {data});},
    isActive: () => active, reservationTimeout: options.reservationTimeout,
  });
  port.postMessage = value => {port.sent.push(value); broker.handle(value);};
  const client = createProjectTrashClient({port, timeout: options.timeout});
  const input = {requestId: randomUUID(), projectId: randomUUID()};
  const request = (): ProjectTrashRequest => ({...input, projectFile: file, fileIdentity: generation(file)});
  t.after(() => {client.close(); broker.close(); rmSync(root, {recursive: true, force: true});});
  return {root, file, port, replies, broker, client, input, request, actions, native,
    get calls() {return calls;}, get releases() {return releases;}, setActive(value: boolean) {active = value;}, dropReplies() {drop = true;}};
}
const refused = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProjectTrashRefusedError); assert.equal(error.code, code); return true;
};
const unknown = (error: unknown) => {
  assert.ok(error instanceof Error); assert.equal((error as Error & {code: string}).code, 'PROJECT_TRASH_UNCONFIRMED');
  assert.equal(error instanceof ProjectTrashRefusedError, false); assert.doesNotMatch(error.message, /private|mioon-trash-broker|secret/u); return true;
};

test('trash generation and command contracts preserve exact bigint metadata and reject extra fields', t => {
  const f = fixture(t), request = f.request();
  assert.deepEqual(projectTrashRequestSchema.parse(request), request);
  assert.equal(projectTrashFileGenerationSchema.safeParse({...request.fileIdentity, mtimeNs: '-1', birthtimeNs: '-500'}).success, true);
  for (const identity of [{...request.fileIdentity, dev: '-1'}, {...request.fileIdentity, ino: '01'}, {...request.fileIdentity, size: Number.MAX_SAFE_INTEGER + 1}, {...request.fileIdentity, ctimeNs: '1.5'}]) assert.equal(projectTrashFileGenerationSchema.safeParse(identity).success, false);
  assert.equal(projectTrashRequestSchema.safeParse({...request, confirmPermanentDeletion: true}).success, false);
  assert.equal(projectTrashRequestSchema.safeParse({...request, projectFile: '../project.mioon'}).success, false);
});

test('a reserved exact project file invokes OS once and releases only after actual settlement', async t => {
  const gate = Promise.withResolvers<void>(), f = fixture(t, {trashItem: () => gate.promise});
  const lease = await f.client.reserve(f.input), pending = lease.trash(f.request());
  assert.equal(f.calls, 1); assert.equal(f.actions.size, 1);
  const second = lease.trash(f.request()); await assert.rejects(second, unknown); assert.equal(f.calls, 1);
  lease.release(); lease.release(); assert.equal(f.actions.size, 1);
  // Release withdraws the ACK, rather than pretending to cancel native work.
  const rejected = assert.rejects(pending, unknown); f.client.close(); f.broker.close();
  gate.resolve(); await tick(); await rejected;
  assert.equal(f.actions.size, 0); assert.equal(f.releases, 1); assert.equal(f.calls, 1);
});

test('normal native success is acknowledged and later lease reuse never calls OS again', async t => {
  const f = fixture(t), lease = await f.client.reserve(f.input);
  await lease.trash(f.request()); await tick();
  assert.equal(f.calls, 1); assert.equal(f.releases, 1);
  await assert.rejects(lease.trash(f.request()), unknown);
  await assert.rejects(f.client.reserve(f.input), unknown);
  assert.equal(f.calls, 1); lease.release();
});

test('window busy and missing native capability refuse before any native call', async t => {
  for (const options of [{busy: true}, {native: false}]) {
    const f = fixture(t, options);
    await assert.rejects(f.client.reserve(f.input), refused(options.busy ? 'PROJECT_HOST_BUSY' : 'PROJECT_TRASH_UNAVAILABLE'));
    assert.equal(f.calls, 0); assert.equal(f.actions.size, 0);
  }
});

test('an explicit pre-dispatch refusal permits a fresh reservation of the same action key', async t => {
  const f = fixture(t), lease = await f.client.reserve(f.input), changed = f.request();
  changed.fileIdentity.ctimeNs = String(BigInt(changed.fileIdentity.ctimeNs) + 1n);
  await assert.rejects(lease.trash(changed), refused('PROJECT_TRASH_SOURCE_CHANGED')); lease.release();
  const retry = await f.client.reserve(f.input); await retry.trash(f.request()); await tick();
  assert.equal(f.calls, 1); assert.equal(f.actions.size, 0); retry.release();
});

for (const change of ['generation', 'hardlink', 'symlink', 'parent-symlink', 'journal', 'wal', 'shm'] as const) {
  test(`main rejects ${change} metadata before dispatch without opening or removing project files`, async t => {
    const f = fixture(t), request = f.request(), lease = await f.client.reserve(f.input);
    if (change === 'generation') request.fileIdentity.birthtimeNs = String(BigInt(request.fileIdentity.birthtimeNs) + 1n);
    if (change === 'hardlink') {linkSync(f.file, path.join(f.root, 'alias.mioon')); request.fileIdentity = generation(f.file);}
    if (change === 'symlink') {const target = path.join(f.root, 'target.mioon'); writeFileSync(target, 'target'); rmSync(f.file); symlinkSync(target, f.file);}
    if (change === 'parent-symlink') {const actual = path.join(f.root, 'actual'), alias = path.join(f.root, 'alias'); mkdirSync(actual); const target = path.join(actual, 'project.mioon'); writeFileSync(target, 'target'); symlinkSync(actual, alias); request.projectFile = path.join(alias, 'project.mioon'); request.fileIdentity = generation(target);}
    if (['journal', 'wal', 'shm'].includes(change)) writeFileSync(f.file + '-' + change, 'sidecar');
    await assert.rejects(lease.trash(request), refused('PROJECT_TRASH_SOURCE_CHANGED'));
    assert.equal(f.calls, 0); assert.equal(f.actions.size, 0); assert.equal(lstatSync(f.file).size > 0, true); lease.release();
  });
}

test('even a native rejection carrying RefusedError becomes unconfirmed once OS was invoked', async t => {
  const f = fixture(t, {trashItem: async () => {throw new ProjectTrashRefusedError('PROJECT_TRASH_SOURCE_CHANGED');}});
  const lease = await f.client.reserve(f.input);
  await assert.rejects(lease.trash(f.request()), unknown); await tick();
  assert.equal(f.calls, 1); assert.equal(f.actions.size, 0); lease.release();
});

test('a closed child loses replies while its native work keeps the shared project fence until settlement', async t => {
  const gate = Promise.withResolvers<void>(), f = fixture(t, {trashItem: () => gate.promise});
  const lease = await f.client.reserve(f.input), promise = lease.trash(f.request()), rejected = assert.rejects(promise, unknown);
  f.setActive(false); f.broker.close(); f.client.close();
  assert.equal(f.actions.size, 1); const replyCount = f.replies.length;
  gate.resolve(); await tick(); await rejected;
  assert.equal(f.actions.size, 0); assert.equal(f.calls, 1); assert.equal(f.replies.length, replyCount);
});

test('a lost native ACK times out as unknown without retry or cancellation messages', async t => {
  const f = fixture(t, {timeout: 10}), lease = await f.client.reserve(f.input);
  f.dropReplies(); await assert.rejects(lease.trash(f.request()), unknown);
  assert.equal(f.calls, 1);
  assert.equal(f.port.sent.filter(value => (value as {type: string}).type === 'project-trash:trash').length, 1);
  assert.equal(f.port.sent.some(value => /cancel/u.test((value as {type: string}).type)), false);
  lease.release(); f.client.close();
});

test('real trash errors and lost-ACK deadlines use exact native messages in all four languages without retrying or disclosing native details', async t => {
  const messages: readonly (readonly [Locale, string])[] = [
    ['zh-Hans', '项目文件是否已移到废纸篓尚不明确，未重复操作。'],
    ['zh-Hant', '專案檔案是否已移到垃圾桶尚不明確，未重複操作。'],
    ['en', 'It is unclear whether the project file was moved to the Trash. The operation was not repeated.'],
    ['ja', 'プロジェクトファイルがゴミ箱に移動されたか確認できません。操作は繰り返していません。'],
  ];
  const privateDetail = 'synthetic-private-secret-/Users/private/project.mioon';
  try {
    for (const [locale, message] of messages) {
      setNativeLanguageReader(() => locale);
      const exactUnknown = (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error instanceof ProjectTrashRefusedError, false);
        assert.equal((error as Error & {code: string}).code, 'PROJECT_TRASH_UNCONFIRMED');
        assert.equal((error as Error & {status: number}).status, 409); assert.equal(error.message, message);
        assert.doesNotMatch(error.message, /synthetic-private|secret|\/Users\/|mioon-trash-broker/u); return true;
      };
      const failed = fixture(t, {trashItem: async () => {throw new Error(privateDetail);}}), lease = await failed.client.reserve(failed.input);
      await assert.rejects(lease.trash(failed.request()), exactUnknown); await tick();
      await assert.rejects(lease.trash(failed.request()), exactUnknown);
      assert.equal(failed.calls, 1); assert.equal(JSON.stringify(failed.replies).includes(privateDetail), false);
      lease.release(); failed.client.close(); failed.broker.close();
      const lost = fixture(t, {timeout: 10}), lostLease = await lost.client.reserve(lost.input);
      lost.dropReplies(); await assert.rejects(lostLease.trash(lost.request()), exactUnknown);
      assert.equal(lost.calls, 1);
      assert.equal(lost.port.sent.filter(value => (value as {type: string}).type === 'project-trash:trash').length, 1);
      assert.equal(lost.port.sent.some(value => /cancel/u.test((value as {type: string}).type)), false);
      lostLease.release(); lost.client.close(); lost.broker.close();
    }
  } finally {setNativeLanguageReader(() => 'zh-Hans');}
  assert.equal(nativeText('native.projectTrashUnconfirmed'), messages[0][1]);
});

test('undispatched reservations release on expiration and close while stale messages cannot dispatch', async t => {
  const f = fixture(t, {reservationTimeout: 5}), lease = await f.client.reserve(f.input);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.actions.size, 0);
  await assert.rejects(lease.trash(f.request()), refused('PROJECT_TRASH_UNAVAILABLE'));
  assert.equal(f.calls, 0); lease.release();
  const other = await f.client.reserve({...f.input, requestId: randomUUID()});
  assert.equal(f.actions.size, 1); f.broker.close(); assert.equal(f.actions.size, 0); assert.doesNotThrow(() => other.release());
});

test('bounded completed IDs are retained and capacity refuses new work rather than evicting executed keys', async t => {
  const f = fixture(t);
  for (let i = 0; i < 256; i++) {const lease = await f.client.reserve({...f.input, requestId: randomUUID()}); lease.release();}
  await assert.rejects(f.client.reserve({...f.input, requestId: randomUUID()}), refused('PROJECT_TRASH_UNAVAILABLE'));
  assert.equal(f.calls, 0); assert.equal(f.releases, 256);
});

test('strict private envelopes and non-current children cannot access the native method', t => {
  const f = fixture(t), command = {type: 'project-trash:reserve', version: 1, messageId: randomUUID(), deadline: Date.now() + 10000, input: f.input};
  assert.equal(f.broker.handle({...command, renderer: true}), true);
  assert.equal(f.broker.handle({...command, messageId: randomUUID(), input: {...f.input, projectFile: f.file}}), true);
  assert.equal(f.broker.handle({type: 'other'}), false);
  assert.equal(f.actions.size, 0); assert.equal(f.calls, 0);
  const count = f.replies.length; f.setActive(false); f.broker.handle({...command, messageId: randomUUID()});
  assert.equal(f.replies.length, count); assert.equal(f.actions.size, 0);
});

test('the real supervisor binds trash to its exact child and retains OS fences across child replacement', async t => {
  const gate = Promise.withResolvers<void>(), f = fixture(t, {trashItem: () => gate.promise});
  const children: Array<BackendUtilityProcess & EventEmitter & {port: Port; sent: Record<string, unknown>[]}> = [];
  const clients: ReturnType<typeof createProjectTrashClient>[] = [];
  t.after(() => {for (const client of clients) client.close(); for (const child of children) child.emit('exit', 0); gate.resolve();});
  const supervisor = new BackendSupervisor({modulePath: '/synthetic/backend.cjs', environment: {}, projectTrash: f.native,
    fork() {
      const port = new Port(), sent: Record<string, unknown>[] = [];
      const child = Object.assign(new EventEmitter(), {pid: 40000 + children.length, port, sent,
        kill: () => true,
        postMessage(raw: unknown) {
          const message = raw as Record<string, unknown>; sent.push(message);
          if (message.type === 'start') queueMicrotask(() => child.emit('message', {type: 'ready', url: 'http://127.0.0.1:43210', runtime: {pid: child.pid}}));
          else port.emit('message', {data: message});
        },
      });
      port.postMessage = message => {port.sent.push(message); child.emit('message', message);};
      children.push(child); return child;
    },
  });
  const config = {dataDir: f.root, cacheDir: f.root, projectsDir: f.root, distDir: f.root, subtitleResourcesDir: f.root, token: 'synthetic-trash-owner'};
  await supervisor.start(config); const old = children[0], oldClient = createProjectTrashClient({port: old.port});
  clients.push(oldClient);
  assert.equal(old.sent[0].projectTrashAvailable, true);
  const lease = await oldClient.reserve(f.input), pending = lease.trash(f.request()), rejected = assert.rejects(pending, unknown);
  old.emit('exit', 0); old.port.emit('close');
  await supervisor.start(config); const replacement = children[1], currentClient = createProjectTrashClient({port: replacement.port});
  clients.push(currentClient);
  await assert.rejects(currentClient.reserve({...f.input, requestId: randomUUID()}), refused('PROJECT_HOST_BUSY'));
  assert.equal(f.actions.size, 1); assert.equal(f.calls, 1);
  const count = old.sent.length; gate.resolve(); await tick(); await rejected;
  assert.equal(old.sent.length, count); assert.equal(f.actions.size, 0);
  const currentLease = await currentClient.reserve({...f.input, requestId: randomUUID()}); currentLease.release();
  oldClient.close(); currentClient.close(); replacement.emit('exit', 0);
  assert.equal(f.calls, 1); assert.equal(f.actions.size, 0);
});
