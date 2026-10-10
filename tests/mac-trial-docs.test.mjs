import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DURABLE_EDIT_OPERATIONS, EDIT_TASK_LIMITS} from '../packages/contracts/src/edit-tasks.mjs';
import {getStoragePrivacyCapability} from '../packages/contracts/src/private-storage.mjs';
import {parseArguments, nativeReadiness} from '../scripts/lib/local-tooling.mjs';
import identity from '../apps/desktop/identity.cjs';

// Documentation/contract checks only: no documented command is executed, no
// dependency installation, application launch, private data or network access.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => readFileSync(path.join(root, file), 'utf8');
const files = ['docs/MAC-SOURCE-TRIAL.zh-CN.md', 'docs/MAC-TRIAL-CHECKLIST.zh-CN.md', 'docs/DESKTOP.md'];
const documents = Object.fromEntries(files.map(file => [file, read(file)]));
const guide = documents[files[0]], checklist = documents[files[1]], desktopDoc = documents[files[2]];
const application = JSON.parse(read('package.json'));
const desktop = JSON.parse(read('apps/desktop/package.json'));

const headings = source => new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, text]) => text
  .toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')));

test('Mac trial documents identify the reviewed source snapshot and separate planned native evidence', () => {
  for (const [file, document] of Object.entries(documents)) {
    assert.match(document, /9e9598d887b21b8e1b7dc742e5d15c66a3ff93d4/, file);
    assert.match(document, /历史/, file);
    assert.match(document, /(?:没有产生|不产生|没有执行).*Mac.*(?:验收|原生)/, file);
  }
  assert.match(guide, /build.*package|暂存包/);
  assert.match(checklist, /SHA-256/);
});

test('documented Node, pnpm, Electron and application versions match current manifests', () => {
  assert.equal(desktop.version, application.version);
  assert.equal(application.engines.node, '>=24.0.0');
  const pin = application.packageManager.slice('pnpm@'.length);
  for (const document of [guide, checklist]) {
    assert.ok(document.includes(`pnpm ${pin}`));
    assert.match(document, /Node(?:\.js)? ≥24/);
    assert.ok(document.includes(application.devDependencies.electron));
    assert.ok(document.includes(application.version));
    assert.match(document, /\/health.*0\.4\.0/);
  }
  assert.match(read('apps/server/src/index.mjs'), /version:\s*'0\.4\.0'/);
  assert.match(read('packages/client/src/index.mjs'), /export const VERSION = applicationPackage\.version;/);
});

test('Mac instructions use the real serialized Web-desktop build and existing start entrypoints', () => {
  const lines = ['node scripts/tooling.mjs doctor',
    'node scripts/tooling.mjs test --suite=portable --concurrency=1',
    'node scripts/tooling.mjs build --channel=development'];
  for (const line of lines) {
    assert.ok(guide.includes(line));
    assert.doesNotThrow(() => parseArguments(line.slice('node scripts/tooling.mjs '.length).split(' ')));
  }
  assert.ok(guide.includes('MIOON_ENABLE_LIVE_PROVIDER=0 pnpm desktop'));
  assert.equal(application.scripts.desktop, 'pnpm --filter @mioon/desktop start');
  assert.equal(desktop.scripts.start, 'electron build');
  for (const [name, channel, config] of [['package:mac', 'production', 'electron-builder.cjs'],
    ['package:mac:dev', 'development', 'electron-builder.dev.cjs']]) {
    assert.equal(desktop.scripts[name], `node ../../scripts/tooling.mjs build --channel=${channel} && electron-builder --config ${config} --mac --publish never`);
    assert.ok(desktopDoc.includes(name));
  }
  assert.equal(nativeReadiness('darwin', 'arm64').ready, false);
  assert.equal(getStoragePrivacyCapability('win32').available, false);
  assert.match(checklist, /Windows ACL 后端仍阻止正常启动/);
});

test('durable scope, capacity and staging identity are tied to shared contracts', () => {
  assert.equal(DURABLE_EDIT_OPERATIONS.length, 15);
  assert.equal(DURABLE_EDIT_OPERATIONS.includes('timeline.render'), false);
  for (const operation of ['subject.create', 'subject.version.add', 'subject.binding.set']) {
    assert.ok(DURABLE_EDIT_OPERATIONS.includes(operation));
    assert.ok(guide.includes(operation));
    assert.ok(desktopDoc.includes(operation));
  }
  assert.match(guide, /15 类本地编辑请求/);
  assert.match(checklist, /十五类持久本地编辑/);
  assert.match(desktopDoc, /15 类固定操作/);
  assert.ok(guide.includes(EDIT_TASK_LIMITS.rows.toLocaleString('en-US')));
  assert.match(desktopDoc, /`mioonDesktop`/);
  assert.doesNotMatch(desktopDoc, /workbenchDesktop/);
  assert.match(read('apps/desktop/scripts/build.mjs'), /mioonDesktop:\s*identity/);
  for (const channel of ['production', 'development']) assert.ok(desktopDoc.includes(identity.identityForChannel(channel).appId));
});

test('first trial uses tracked synthetic inputs and keeps separate model settings inactive', () => {
  for (const fixture of ['examples/timeline-synthetic/scene-a.png', 'examples/timeline-synthetic/scene-b.mp4']) {
    assert.ok(guide.includes(fixture));
    assert.ok(checklist.includes(fixture));
    assert.ok(statSync(path.join(root, fixture)).isFile());
  }
  for (const document of [guide, checklist, desktopDoc]) {
    assert.match(document, /Images/);
    assert.match(document, /ComfyUI/);
    assert.match(document, /(?:连接检查|检查本身会发送 HTTP)/);
  }
  assert.match(guide, /MIOON_ENABLE_LIVE_PROVIDER=0[^\n]*不应[^\n]*总开关/);
  assert.match(checklist, /异步 safeStorage 候选/);
  assert.match(desktopDoc, /专用设置及 Electron safeStorage 接入已实现/);
  assert.doesNotMatch(desktopDoc, /尚未实现[^\n]*系统密钥链凭据配置/);
});

test('all local Markdown links in the three trial documents resolve, including anchors', () => {
  let count = 0;
  for (const [file, document] of Object.entries(documents)) {
    for (const [, link] of document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:\/\//i.test(link)) continue;
      const [relative, anchor] = link.split('#');
      const target = relative ? path.resolve(root, path.dirname(file), relative) : path.join(root, file);
      assert.ok(target.startsWith(root + path.sep), `${file}: local target leaves repository`);
      assert.ok(statSync(target).isFile(), `${file}: ${link}`);
      if (anchor) assert.ok(headings(readFileSync(target, 'utf8')).has(decodeURIComponent(anchor)), `${file}: ${link}`);
      count++;
    }
  }
  assert.ok(count >= 10, `Unexpectedly few checked links: ${count}`);
});


test('Mac follow-up reports retain their own title and implementation subject rather than a copied neighboring report', () => {
  const specifications = [
    ['docs/KEYCHAIN-TIMEOUT-AUDIT.md', '# Electron 密钥库超时审查', ['image-secret-broker.mjs', 'secret-store.mjs', '2000', 'Atomics.wait']],
    ['docs/TIMELINE-RECOVERY-AUDIT.md', '# Timeline Undo/Redo 恢复审查', ['timeline-recovery-audit.test.mjs', 'undo', 'redo']],
    ['docs/KEYCHAIN-ASYNC-FEASIBILITY.md', '# Electron 44.7.0 Keychain 异步可行性', ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']],
    ['docs/CLIENT-VERSION-SOURCE.md', '# CLI / MCP 客户端版本来源', ['packages/client/src/index.mjs', 'package.json', 'VERSION']],
  ];
  const validate = (text, [, title, markers]) => {
    assert.equal(text.split('\n')[0], title);
    for (const marker of markers) assert.ok(text.includes(marker), `Missing report subject: ${marker}`);
  };
  for (const specification of specifications) validate(read(specification[0]), specification);
  const keychain = read(specifications[0][0]), timeline = read(specifications[1][0]);
  assert.notEqual(keychain, timeline);
  assert.throws(() => validate(timeline, specifications[0]), assert.AssertionError);
  assert.throws(() => validate(keychain, specifications[1]), assert.AssertionError);
  assert.match(keychain, /文档串写/);
  assert.match(keychain, /0f96d8700f667252f3c678ac932f87b62e54661a5f7c0b6c1e1b9a62da597fab/);
});
