import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeText, setNativeLanguageReader } from '../apps/desktop/src/app-language-text.ts';

const source = readFileSync(new URL('../apps/desktop/src/main.ts', import.meta.url), 'utf8');

function recoveryDetail(key: 'native.restartDetail' | 'native.serviceStoppedDetail'): string {
  assert.ok(source.includes(`detail: nt('${key}')`), 'The native recovery dialog must use the translated safety detail.');
  setNativeLanguageReader(() => 'zh-Hans');
  return (nativeText as (key: string, params?: Record<string, unknown>) => string)(key, {});
}

const dialogs = [
  ['restart confirmation', 'native.restartDetail'],
  ['backend crash recovery', 'native.serviceStoppedDetail'],
];

for (const [name, pattern] of dialogs as Array<[string, 'native.restartDetail' | 'native.serviceStoppedDetail']>) {
  test(`desktop ${name} distinguishes saved generation status recovery from unknown submission recreation`, () => {
    const detail = recoveryDetail(pattern);
    if (name === 'restart confirmation') assert.match(detail, /已保存的数据保留/);
    assert.match(detail, /未保存的界面修改可能丢失/);
    assert.match(detail, /生成任务会按已保存的状态恢复处理/);
    assert.match(detail, /提交结果未知时只对账，不会自动重新提交/);
    assert.doesNotMatch(detail, /正在运行的任务会在恢复后继续处理|已知任务会恢复/);
  });

  test(`desktop ${name} preserves saved Agent text without promising resumed inference or resending`, () => {
    const detail = recoveryDetail(pattern);
    assert.match(detail, /Agent 对话保留已保存的文字/);
    assert.match(detail, /Agent 对话[^。]*重启后不会自动继续推理或重新发送请求/);
  });
}
