import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTaskErrorKey } from '../apps/web/src/agent-task-errors.ts';
import { LOCALES, translate } from '../packages/i18n/src/index.ts';

test('Mio errors choose localized fixed templates using only stable codes', () => {
  for (const locale of LOCALES) {
    for (const code of ['AGENT_CHAT_HTTP_ERROR','AGENT_CHAT_TIMEOUT','AGENT_TASK_CONSENT_REQUIRED','AGENT_TASK_STORAGE_UNAVAILABLE','AGENT_TASK_TARGET_CHANGED','AGENT_TASK_TARGET_CLAIMED','AGENT_TASK_READ_ONLY','FFMPEG_NOT_FOUND']) {
      const text = translate(locale, agentTaskErrorKey(code));
      assert.ok(text.length > 0);
      assert.ok(!text.includes(code));
      assert.notEqual(agentTaskErrorKey(code), 'agent.task.error.generic');
    }
    const fallback = translate(locale, agentTaskErrorKey(undefined));
    for (const code of ['UNKNOWN_FROM_PROVIDER','<img src=x>','__proto__',null,{},'']) {
      assert.equal(translate(locale, agentTaskErrorKey(code)), fallback);
    }
  }
  assert.notEqual(translate('en', agentTaskErrorKey('AGENT_CHAT_HTTP_ERROR')), translate('zh-Hans', agentTaskErrorKey('AGENT_CHAT_HTTP_ERROR')));
});

// A renderer receipt failure cannot prove that background or remote work stopped.
test('local receipt errors ask to check the original run without promising cancellation', () => {
  assert.equal(agentTaskErrorKey('LOCAL_RECEIPT_UNAVAILABLE'), 'agent.task.error.receipt');
  for (const locale of LOCALES) assert.doesNotMatch(translate(locale, agentTaskErrorKey('LOCAL_RECEIPT_UNAVAILABLE')), /已停止|have stopped|停止しました/u);
});

test('local transport failures do not tell the user to change the model connection', () => {
  assert.equal(agentTaskErrorKey('NETWORK'), 'agent.task.error.localConnection');
  assert.equal(agentTaskErrorKey('INVALID_RESPONSE'), 'agent.task.error.localResponse');
  assert.notEqual(agentTaskErrorKey('NETWORK'), agentTaskErrorKey('AGENT_CHAT_CONNECT_FAILED'));
  for (const locale of LOCALES) assert.doesNotMatch(translate(locale, agentTaskErrorKey('NETWORK')), /模型|model|モデル/u);
});

test('new error templates follow the static UI paragraph punctuation rule', () => {
  for (const locale of LOCALES) {
    for (const code of ['AGENT_CHAT_HTTP_ERROR','AGENT_CHAT_TIMEOUT','NETWORK','INVALID_RESPONSE','LOCAL_RECEIPT_UNAVAILABLE',undefined]) {
      assert.doesNotMatch(translate(locale, agentTaskErrorKey(code)), /[。.]$/u);
    }
  }
});
