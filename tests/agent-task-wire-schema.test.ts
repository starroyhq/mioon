import test from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_TASK_TOOL_SCHEMAS} from '../packages/business/src/agent/task-tool-schemas-v2.ts';
import {taskToolWireSchema} from '../packages/business/src/agent/task-tool-wire-schema.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {DEFAULT_AGENT_CONFIGURATION} from '../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';

const configuration: AgentConfiguration = {...DEFAULT_AGENT_CONFIGURATION, presetId: 'deepseek', protocol: 'chat_completions', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com'};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
for (const operation of ['timeline.export.preflight', 'timeline.render'] as const) {
  test(`${operation}: only DeepSeek delivery-name format hints change; all host constraints remain authoritative`, () => {
    const original = AGENT_TASK_TOOL_SCHEMAS[operation], before = structuredClone(original), name = `mioon_${operation.replaceAll('.', '_')}`;
    const projected = taskToolWireSchema(configuration, name, original);
    assert.ok(object(original) && object(original.properties) && object(projected) && object(projected.properties));
    const deliveryName = projected.properties.deliveryName;
    assert.ok(object(deliveryName));
    assert.equal(deliveryName.type, 'string'); assert.equal(deliveryName.minLength, 1); assert.equal(deliveryName.maxLength, 120);
    assert.equal('allOf' in deliveryName, false); assert.match(String(deliveryName.description), /控制字符.*UTF-16/);
    assert.deepEqual({...projected, properties: {...projected.properties, deliveryName: original.properties.deliveryName}}, original);
    assert.deepEqual(original, before, 'public/generated schema is not mutated');
    assert.strictEqual(taskToolWireSchema({...configuration, protocol: 'responses'}, name, original), original);
    assert.strictEqual(taskToolWireSchema({...configuration, presetId: 'openai'}, name, original), original);
    assert.strictEqual(taskToolWireSchema(configuration, 'mioon_other', original), original);
    const changedSchema = {...original, properties: {...original.properties, deliveryName: {type: 'string'}}};
    assert.throws(() => taskToolWireSchema(configuration, name, changedSchema), {code: 'AGENT_CHAT_PROFILE_UNSUPPORTED'});
    const input = {projectId: '11111111-1111-4111-8111-111111111111', expectedRevision: 1, ...(operation === 'timeline.render' ? {purpose: 'export', requestId: 'synthetic-wire-schema-only'} : {})};
    for (const value of ['中文剪片验收', 'A'.repeat(120), ' 🙂 ', '  保留空格  ']) {
      const parsed = schemas[operation].safeParse({...input, deliveryName: value});
      assert.equal(parsed.success, true);
      if (parsed.success) assert.equal(parsed.data.deliveryName, value, 'format validation never cleans or trims caller input');
    }
    for (const value of ['', ' ', '\t', 'x\n', 'x\u0000', 'x\u007f', 'x\u0085', 'x\u2028', 'x\u2029', '\ud800', '\udfff', 'A'.repeat(121)]) assert.equal(schemas[operation].safeParse({...input, deliveryName: value}).success, false, JSON.stringify(value));
    assert.equal(schemas[operation].safeParse({...input, deliveryName: 'Valid', approved: true}).success, false);
  });
}
test('DeepSeek compatibility never changes image union bindings or arbitrary schemas', () => {
  for (const [operation, original] of Object.entries(AGENT_TASK_TOOL_SCHEMAS)) {
    if (operation === 'timeline.export.preflight' || operation === 'timeline.render') continue;
    assert.strictEqual(taskToolWireSchema(configuration, `mioon_${operation.replaceAll('.', '_')}`, original), original, operation);
  }
});
test('actual tool preparation refuses invalid delivery names before any change or generated job', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-wire-name-')), store = openStore(root), services = createServices(store, new Map()), tools = createAgentTaskTools({store, services});
  t.after(async () => { tools.dispose(); await services.drain(); store.close(); await rm(root, {recursive: true, force: true}); });
  const project = await services.call('project.create', {name: 'Wire-name validation'});
  assert.ok(object(project) && typeof project.id === 'string');
  const projectId = project.id, journal = createAgentTaskJournal(store), before = journal.revisionSnapshot(projectId);
  for (const operation of ['timeline.export.preflight', 'timeline.render']) {
    for (const deliveryName of ['', ' ', 'x\n', '\0', '\u0085', '\u2028', '\ud800', 'A'.repeat(121)]) assert.throws(() => tools.prepare({projectId, operation, input: {expectedRevision: 1, ...(operation === 'timeline.render' ? {purpose: 'export'} : {}), deliveryName}}), {code: 'VALIDATION_ERROR'});
  }
  assert.deepEqual(journal.revisionSnapshot(projectId), before);
  assert.deepEqual(store.list('jobs', projectId), []);
  assert.deepEqual(store.list('exports', projectId), []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_task_changes_v2').get()?.n, 0);
});
