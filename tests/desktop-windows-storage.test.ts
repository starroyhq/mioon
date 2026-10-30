import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeDesktopPrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {getStoragePrivacyCapability} from '../packages/contracts/src/private-storage.ts';
import {privateStorageHelperFile, storageFailureDialog, utilityEnvironment} from '../apps/desktop/src/config.ts';
import {setNativeLanguageReader} from '../apps/desktop/src/app-language-text.ts';
import {appendWindowsDiagnostic, type WindowsDiagnosticStorage} from '../apps/desktop/src/diagnostic-append-windows.ts';
import type {Locale} from '../packages/i18n/src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const bootstrapUrl = new URL('../packages/node-host/src/private-storage-bootstrap.ts', import.meta.url).href;
const storageUrl = new URL('../packages/contracts/src/private-storage.ts', import.meta.url).href;

test('the desktop helper entry does nothing on POSIX', {skip: process.platform === 'win32'}, () => {
  const before = getStoragePrivacyCapability();
  initializeDesktopPrivateStorage('/not/a/helper.node');
  assert.deepEqual(getStoragePrivacyCapability(), before, 'POSIX never loads a Windows helper');
});

test('the desktop helper entry fails closed on Windows without a usable helper (synthetic platform)', () => {
  const missing = path.join(root, 'apps/desktop/build/native/absent-helper.node');
  const script = `Object.defineProperty(process,'platform',{value:'win32'});
const {initializeDesktopPrivateStorage}=await import(${JSON.stringify(bootstrapUrl)});const storage=await import(${JSON.stringify(storageUrl)});
const outcome=file=>{try{initializeDesktopPrivateStorage(file);return 'registered';}catch(error){return error.code+'/'+error.reason;}};
const results={outsideElectron:outcome(${JSON.stringify(missing)})};
Object.defineProperty(process.versions,'electron',{value:'44.7.0',enumerable:true});
Object.assign(results,{relative:outcome('native/mioon_private_storage.node'),notNode:outcome(${JSON.stringify(missing.replace(/\.node$/u, '.dll'))}),missing:outcome(${JSON.stringify(missing)})});
let closed=false;try{storage.ensurePrivateDirectory(${JSON.stringify(path.join(root, 'never-created'))},{create:true});}catch(error){closed=error.code==='STORAGE_PRIVACY_UNAVAILABLE';}
results.closed=closed;results.capability=storage.getStoragePrivacyCapability('win32').available;
process.stdout.write(JSON.stringify(results));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    outsideElectron: 'STORAGE_PRIVACY_UNAVAILABLE/WINDOWS_HELPER_UNAVAILABLE',
    relative: 'STORAGE_PRIVACY_UNAVAILABLE/WINDOWS_HELPER_UNAVAILABLE',
    notNode: 'STORAGE_PRIVACY_UNAVAILABLE/WINDOWS_HELPER_UNAVAILABLE',
    missing: 'STORAGE_PRIVACY_UNAVAILABLE/WINDOWS_HELPER_UNAVAILABLE',
    closed: true, capability: false,
  });
});

test('main names the shipped helper and only hands it to the Windows backend', () => {
  assert.equal(privateStorageHelperFile({isPackaged: true, getAppPath: () => '/app/resources/app.asar'}, '/app/resources'),
    path.join('/app/resources', 'native', 'mioon_private_storage.node'));
  assert.equal(privateStorageHelperFile({isPackaged: false, getAppPath: () => '/repo/apps/desktop/build'}, '/unused'),
    path.join('/repo/apps/desktop/build', 'native', 'mioon_private_storage.node'));
  const tools = {ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe'};
  assert.equal(Object.hasOwn(utilityEnvironment({}, tools), 'MIOON_DESKTOP_PRIVATE_STORAGE_HELPER'), false);
  assert.equal(utilityEnvironment({MIOON_DESKTOP_PRIVATE_STORAGE_HELPER: 'C:\\planted.node'}, tools).MIOON_DESKTOP_PRIVATE_STORAGE_HELPER, undefined,
    'the parent environment never names the helper');
  assert.equal(utilityEnvironment({}, tools, 'C:\\Mioon\\resources\\native\\mioon_private_storage.node').MIOON_DESKTOP_PRIVATE_STORAGE_HELPER,
    'C:\\Mioon\\resources\\native\\mioon_private_storage.node');
});

test('a missing Windows helper gets its own fatal copy; the generic privacy copy stays', () => {
  try {
    for (const [locale, message, recovery] of ([
      ['zh-Hans', '缺少 Windows 存储保护组件', '请重新安装 Mioon'], ['zh-Hant', '缺少 Windows 儲存保護元件', '請重新安裝 Mioon'],
      ['en', 'The Windows storage protection component is missing', 'Reinstall Mioon'], ['ja', 'Windows のストレージ保護コンポーネントが見つかりません', 'Mioon を再インストール'],
    ] as [Locale, string, string][])) {
      setNativeLanguageReader(() => locale);
      const dialog = storageFailureDialog({code: 'STORAGE_PRIVACY_UNAVAILABLE', reason: 'WINDOWS_HELPER_UNAVAILABLE'});
      assert.equal(dialog.message, message);
      assert.match(dialog.detail, /ACL/u);
      assert.doesNotMatch(dialog.detail, /POSIX|0600/u);
      assert.ok(dialog.detail.split('\n').some(line => line.startsWith(recovery)), `${locale}: the recovery starts its own line`);
    }
    setNativeLanguageReader(() => 'zh-Hans');
    const generic = storageFailureDialog({code: 'STORAGE_PRIVACY_UNAVAILABLE'});
    assert.match(generic.detail, /0600\/0700/u);
    assert.match(generic.detail, /不会自动更改权限\n请使用受支持的本地 POSIX 文件系统/u);
  } finally { setNativeLanguageReader(() => 'zh-Hans'); }
});

test('Windows diagnostics append, rotate and drop oversized slots through the storage backend only', () => {
  const files = new Map<string, Buffer>(), calls: string[] = [], directories: string[] = [];
  const dataDir = 'C:\\data', directory = 'C:\\data\\diagnostics', file = 'C:\\data\\diagnostics\\backend-exit.jsonl';
  const storage: WindowsDiagnosticStorage = {
    ensurePrivateDirectory: ((target: string, options: {create?: boolean}) => { assert.equal(options.create, true); directories.push(target); return null; }) as WindowsDiagnosticStorage['ensurePrivateDirectory'],
    validateManagedFile: ((target: string, options: {root: string; private: boolean}) => {
      assert.deepEqual([options.root, options.private], [dataDir, true]);
      const bytes = files.get(target); return bytes ? {size: bytes.length} : null;
    }) as unknown as WindowsDiagnosticStorage['validateManagedFile'],
    readPrivateFile: ((target: string, options: {root: string; maxBytes: number}) => {
      assert.deepEqual([options.root, options.maxBytes], [dataDir, 32]); calls.push(`read ${path.win32.basename(target)}`); return files.get(target) ?? null;
    }) as unknown as WindowsDiagnosticStorage['readPrivateFile'],
    writePrivateFileAtomic: ((target: string, bytes: Buffer, options: {root: string; maxBytes: number; replace: boolean}) => {
      assert.deepEqual([options.root, options.maxBytes, options.replace], [dataDir, 32, true]);
      if (bytes.length > options.maxBytes) throw Object.assign(new Error('limit'), {reason: 'SIZE_LIMIT'});
      calls.push(`write ${path.win32.basename(target)}`); files.set(target, Buffer.from(bytes));
    }) as unknown as WindowsDiagnosticStorage['writePrivateFileAtomic'],
    removePrivateFile: ((target: string, options: {root: string}) => {
      assert.equal(options.root, dataDir); calls.push(`remove ${path.win32.basename(target)}`); files.delete(target);
    }) as unknown as WindowsDiagnosticStorage['removePrivateFile'],
  };
  const limits = {maxBytes: 32, fileCount: 3}, line = (text: string) => Buffer.from(`${text}\n`);
  appendWindowsDiagnostic(dataDir, directory, file, line('one-123456'), limits, storage);
  appendWindowsDiagnostic(dataDir, directory, file, line('two-123456'), limits, storage);
  assert.equal(files.get(file)!.toString(), 'one-123456\ntwo-123456\n');
  assert.deepEqual([...new Set(directories)], [dataDir, directory]);
  // The third line overflows 32 bytes: the current file becomes slot 1.
  appendWindowsDiagnostic(dataDir, directory, file, line('three-1234'), limits, storage);
  assert.deepEqual([files.get(file)!.toString(), files.get(`${file}.1`)!.toString()], ['three-1234\n', 'one-123456\ntwo-123456\n']);
  for (const text of ['four-12345', 'five-12345', 'six-123456']) appendWindowsDiagnostic(dataDir, directory, file, line(text), limits, storage);
  const content = (name: string): string | undefined => files.get(name)?.toString();
  // Two 11-byte lines fill a 32-byte slot; three slots hold six lines.
  assert.deepEqual([...files.keys()].map(name => path.win32.basename(name)).sort(), ['backend-exit.jsonl', 'backend-exit.jsonl.1', 'backend-exit.jsonl.2']);
  assert.deepEqual([content(file), content(`${file}.1`), content(`${file}.2`)], ['five-12345\nsix-123456\n', 'three-1234\nfour-12345\n', 'one-123456\ntwo-123456\n']);
  // The oldest slot leaves first; every newer slot moves up once.
  appendWindowsDiagnostic(dataDir, directory, file, line('seven-1234'), limits, storage);
  assert.deepEqual([content(file), content(`${file}.1`), content(`${file}.2`)], ['seven-1234\n', 'five-12345\nsix-123456\n', 'three-1234\nfour-12345\n']);
  // An oversized slot is dropped, as on POSIX, without being read or moved.
  files.set(`${file}.1`, Buffer.alloc(64)); files.set(file, Buffer.from('eight-1234\nnine-12345\n')); calls.length = 0;
  appendWindowsDiagnostic(dataDir, directory, file, line('ten-123456'), limits, storage);
  assert.equal(calls.includes('read backend-exit.jsonl.1'), false);
  assert.ok(calls.includes('remove backend-exit.jsonl.1'));
  assert.deepEqual([content(file), content(`${file}.1`), content(`${file}.2`)], ['ten-123456\n', 'eight-1234\nnine-12345\n', undefined]);
  assert.throws(() => appendWindowsDiagnostic(dataDir, directory, file, Buffer.alloc(40), limits, storage), {reason: 'SIZE_LIMIT'}, 'a line larger than a slot is refused');
});

test('every desktop storage path dispatches to the Windows backend, never to POSIX descriptors or modes', () => {
  const main = read('apps/desktop/src/main.ts'), backend = read('apps/desktop/src/backend.ts'), build = read('apps/desktop/scripts/build.ts');
  assert.match(main, /try \{ initializeDesktopPrivateStorage\(privateStorageHelperFile\(app\)\); paths = prepareDesktopStorage\(/u, 'registration precedes the first storage access, in the same failure path');
  assert.match(main, /utilityEnvironment\(process\.env, tools, process\.platform === 'win32' \? privateStorageHelperFile\(app\) : undefined\)/u);
  assert.match(backend, /try \{\n\s+\/\/ Windows storage opens only through the helper main verified and named\.\n\s+initializeDesktopPrivateStorage\(process\.env\.MIOON_DESKTOP_PRIVATE_STORAGE_HELPER \?\? ''\);/u);
  assert.match(build, /if\(process\.platform==='win32'\)\{[\s\S]*?Build the Windows private storage helper first[\s\S]*?cp\(helper,path\.join\(output,'native','mioon_private_storage\.node'\)\)/u);
  for (const [file, limits] of [['exit-diagnostics', 'EXIT_DIAGNOSTIC_LIMITS'], ['renderer-diagnostics', 'RENDERER_DIAGNOSTIC_LIMITS']] as const)
    assert.match(read(`apps/desktop/src/${file}.ts`), new RegExp(`if \\(process\\.platform === 'win32'\\) \\{ appendWindowsDiagnostic\\(dataDir, directory, file, line, ${limits}\\); return; \\}`, 'u'));
  const lut = read('apps/desktop/src/lut-recovery-store.ts');
  assert.match(lut, /samePrivateStorageIdentity\(a, b\)/u);
  assert.match(lut, /if \(process\.platform === 'win32'\) \{ getWindowsManagedFileIO\(\)\.syncDirectory\(userData, \{ private: true \}\); boundary\(\); \}/u);
  assert.match(read('apps/desktop/src/workspace-native-host.ts'), /if\(process\.platform==='win32'\)\{await verifyWindowsExport\(root,output,identity,check\);return;\}/u);
  assert.match(read('apps/desktop/src/smoke-checks.ts'), /if \(process\.platform === 'win32'\) assert\.ok\(validateManagedFile\(file, \{ root: paths\.userData, private: true \}\)/u);
});
