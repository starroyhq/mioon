import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../apps/desktop/src/main.mjs', import.meta.url), 'utf8');

function recoveryDetail(pattern) {
  const match = source.match(pattern);
  assert.ok(match, 'The native recovery dialog must explain recovery before restarting.');
  return match[1];
}

const dialogs = [
  ['restart confirmation', /message: '重启本地服务？',\s*detail: '([^']+)'/],
  ['backend crash recovery', /message: '本地服务意外退出。已保存的数据会在重启时恢复。',\s*detail: '([^']+)'/],
];

for (const [name, pattern] of dialogs) {
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
