import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeText, setNativeLanguageReader } from '../apps/desktop/src/app-language-text.ts';

const source = readFileSync(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');

const dialogs = [
  {
    name: 'restart confirmation',
    message: 'native.restartQuestion',
    detail: 'native.restartDetail',
    buttons: "nt('native.restart'), nt('native.cancel')",
    warning: '重启可能丢失未保存的界面修改。',
  },
  {
    name: 'backend crash recovery',
    message: 'native.serviceStopped',
    detail: 'native.serviceStoppedDetail',
    buttons: "nt('native.restartService'), nt('native.quit')",
    warning: '未保存的修改可能丢失。',
  },
] as const;

for (const {name, message, detail, buttons, warning} of dialogs) {
  test(`desktop ${name} shows the unsaved-work warning at the decision`, () => {
    setNativeLanguageReader(() => 'zh-Hans');
    assert.equal(nativeText(detail), warning);
    if (message === 'native.serviceStopped') assert.equal(nativeText(message), '本地服务意外退出。');
  });

  test(`desktop ${name} keeps the warning with its two native actions`, () => {
    const start = source.indexOf(`message: nt('${message}')`);
    assert.ok(start >= 0);
    const popup = source.slice(start, start + 250);
    assert.ok(popup.includes(`detail: nt('${detail}')`));
    assert.ok(popup.includes(`buttons: [${buttons}]`));
  });
}
