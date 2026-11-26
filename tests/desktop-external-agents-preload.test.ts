import assert from 'node:assert/strict';
import test from 'node:test';
import {createExternalAgentsBridge} from '../apps/desktop/src/external-agents-preload.ts';
import {EXTERNAL_AGENTS_CHANNEL} from '../packages/contracts/src/external-agents.ts';
import type {
  ExternalAgent,
  ExternalAgentsError,
  ExternalAgentsRequest,
  ExternalAgentsView,
} from '../packages/contracts/src/external-agents.ts';

const view: ExternalAgentsView = {
  commandName: 'mioon-dev',
  appVersion: '0.4.0',
  cli: {state: 'not-installed', displayPath: 'bin/mioon-dev', onPath: 'unknown'},
  mcpCommands: {claudeCode: 'claude fixture', codex: 'codex fixture'},
  skills: [
    {agent: 'claude-code', state: 'not-installed', displayDirectory: 'claude/skills/mioon-dev'},
    {agent: 'codex', state: 'not-installed', displayDirectory: 'codex/skills/mioon-dev'},
  ],
};

const expectError = (expected: ExternalAgentsError) => (error: unknown): boolean => {
  assert.deepEqual(error, expected);
  assert.equal(Object.getPrototypeOf(error), Object.prototype);
  return true;
};

test('external Agents preload sends only the seven fixed request kinds and returns the parsed view', async () => {
  const calls: Array<[string, ExternalAgentsRequest]> = [];
  const bridge = createExternalAgentsBridge({invoke: async (channel, request) => {
    calls.push([channel, request]);
    return {ok: true, data: view};
  }});

  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), ['read', 'installCli', 'uninstallCli', 'repairCli', 'installSkill', 'uninstallSkill', 'updateSkill']);
  const result = await Promise.all([
    bridge.read(),
    bridge.installCli('choose'),
    bridge.uninstallCli(),
    bridge.repairCli(),
    bridge.installSkill('claude-code'),
    bridge.uninstallSkill('codex'),
    bridge.updateSkill('codex', false),
  ]);

  assert.deepEqual(result, Array(7).fill(view));
  assert.equal(Object.isFrozen(result[0].skills), true);
  assert.deepEqual(calls.map(([channel]) => channel), Array(7).fill(EXTERNAL_AGENTS_CHANNEL));
  assert.deepEqual(calls.map(([, request]) => request), [
    {kind: 'read'},
    {kind: 'install-cli', location: 'choose'},
    {kind: 'uninstall-cli'},
    {kind: 'repair-cli'},
    {kind: 'install-skill', agent: 'claude-code'},
    {kind: 'uninstall-skill', agent: 'codex'},
    {kind: 'update-skill', agent: 'codex', overwriteModified: false},
  ]);
});

test('external Agents preload rejects invalid renderer arguments before IPC', async () => {
  const bridge = createExternalAgentsBridge({invoke: async () => assert.fail('invalid request reached IPC')});
  const invalid = expectError({code: 'EXTERNAL_AGENTS_INVALID', status: 400});
  const invalidAgent = 'other' as ExternalAgent;

  await assert.rejects(bridge.installCli('directory-from-renderer' as 'choose'), invalid);
  await assert.rejects(bridge.installSkill(invalidAgent), invalid);
  await assert.rejects(bridge.uninstallSkill(invalidAgent), invalid);
  await assert.rejects(bridge.updateSkill(invalidAgent, false), invalid);
  await assert.rejects(bridge.updateSkill('codex', 'yes' as unknown as boolean), invalid);
});

test('external Agents preload forwards known plain errors and sanitizes malformed replies and transport failures', async () => {
  const errors: ExternalAgentsError[] = [
    {code: 'EXTERNAL_AGENTS_UNAVAILABLE', status: 503},
    {code: 'EXTERNAL_AGENTS_INVALID', status: 400},
    {code: 'EXTERNAL_AGENTS_BUSY', status: 409},
    {code: 'CLI_REQUIRED', status: 409},
    {code: 'SKILL_MODIFIED', status: 409},
  ];
  for (const error of errors) {
    const bridge = createExternalAgentsBridge({invoke: async () => ({ok: false, error})});
    await assert.rejects(bridge.updateSkill('codex', false), expectError(error));
  }

  const unavailable = expectError({code: 'EXTERNAL_AGENTS_UNAVAILABLE', status: 503});
  for (const reply of [
    null,
    view,
    {ok: true, data: {...view, cli: {...view.cli, onPath: 'maybe'}}},
    {ok: false, error: {code: 'EACCES', status: 400}},
    {ok: false, error: {...errors[4], diagnostics: 'private'}},
  ]) {
    const bridge = createExternalAgentsBridge({invoke: async () => reply});
    await assert.rejects(bridge.read(), unavailable);
  }

  const bridge = createExternalAgentsBridge({invoke: async () => { throw Error('private'); }});
  await assert.rejects(bridge.read(), unavailable);
});
