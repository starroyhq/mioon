import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_TASK_STATUSES} from '../packages/contracts/src/agent-tasks-v2.ts';
import {LOCALES, catalogs, translate, validateCatalogs} from '../packages/i18n/src/index.ts';
import {agentTaskMessages} from '../packages/i18n/src/catalogs/agent-tasks.ts';

test('Mio keeps the same product name across the panel, settings and four languages', () => {
  for (const key of ['agent.task.title', 'agent.settings.title', 'shell.agentLabel', 'redesign.shell.agent', 'redesign.settings.agent'] as const) {
    for (const locale of LOCALES) assert.equal(translate(locale, key), 'Mio', `${key}/${locale}`);
  }
  const oldName = /智能助理|智慧助理|\b(?:Agent|Assistant)\b|アシスタント|エージェント/u;
  for (const [key, entry] of Object.entries(catalogs)) {
    if (!key.startsWith('agent.') && !key.startsWith('operation.agent.authorization.') && !key.startsWith('shell.agent')) continue;
    for (const locale of LOCALES) assert.doesNotMatch(JSON.stringify(entry[locale]), oldName, `${key}/${locale}`);
  }
});

test('all existing run states have localized labels, including preparation before execution', () => {
  assert.deepEqual(LOCALES.map(locale => translate(locale, 'agent.task.status.accepted')), ['准备中', '準備中', 'Preparing', '準備中']);
  for (const status of AGENT_TASK_STATUSES) {
    const key = `agent.task.status.${status}` as const;
    for (const locale of LOCALES) {
      const label = translate(locale, key);
      assert.ok(label.trim(), `${key}/${locale}`);
      assert.notEqual(label, status, `${key}/${locale}`);
    }
  }
});

test('Mio wording distinguishes execution from the background task center and retains safety notices', () => {
  const taskCenterKeys = new Set(['agent.task.waitReconcile', 'agent.task.existingRequests']);
  for (const [key, entry] of Object.entries(agentTaskMessages)) {
    if (taskCenterKeys.has(key)) continue;
    for (const locale of LOCALES) {
      assert.doesNotMatch(entry[locale], /任务|任務|\btasks?\b|タスク|编辑保护|編輯保護|editing protection|編集保護/iu, `${key}/${locale}`);
    }
  }
  for (const locale of LOCALES) {
    assert.notEqual(translate(locale, 'agent.task.history'), translate(locale, 'redesign.tasks.search'));
    assert.ok(translate(locale, 'agent.task.unknown').length > 20);
    assert.ok(translate(locale, 'agent.task.editingDiscardConfirm').includes('Mio'));
  }
  assert.match(translate('zh-Hans', 'agent.task.waitReconcile'), /任务中心/);
  assert.match(translate('en', 'redesign.tasks.search'), /tasks/);
  assert.deepEqual(validateCatalogs(agentTaskMessages), []);
});
