import assert from 'node:assert/strict';
import {access, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {externalAgentsReplySchema, type ExternalAgentsReply} from '../packages/contracts/src/external-agents.ts';
import {createCliInstaller} from '../apps/desktop/src/cli-install.ts';
import {createExternalAgentSkills} from '../apps/desktop/src/external-agent-skills.ts';
import {createExternalAgentsHost} from '../apps/desktop/src/external-agents-host.ts';

const supportedFixture = process.platform === 'darwin' || process.platform === 'linux';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-external-agents-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = path.join(root, 'home');
  const userData = path.join(home, 'data');
  const appPath = path.join(root, 'test.app');
  const helper = path.join(appPath, 'Contents', 'Helpers', 'mioon-dev');
  const bin = path.join(home, '.local', 'bin');
  const command = path.join(bin, 'mioon-dev');
  const claudeSkill = path.join(home, '.claude', 'skills', 'mioon-dev');
  const codexSkill = path.join(home, '.codex', 'skills', 'mioon-dev');
  const bundledSkill = path.join(appPath, 'Contents', 'Resources', 'skills', 'mioon');
  await mkdir(home);
  await mkdir(path.dirname(helper), {recursive: true});
  await writeFile(helper, 'fixture launcher', {mode: 0o700});
  await cp(new URL('../skills/mioon', import.meta.url), bundledSkill, {recursive: true});
  const host = (appVersion = '0.4.0', repairOnStartup = false) => createExternalAgentsHost({
    cli: createCliInstaller({homeDir: home, userData, appPath, appVersion, channel: 'development', shell: '/bin/zsh',
      pathLookup: async () => null, platform: {
        async verifyLauncher() {},
        async copyLauncher(source, target) {await copyFile(source, target);},
        async assessCopy() {return 'accepted';},
      }}),
    skills: createExternalAgentSkills({homeDirectory: home, appDataDirectory: userData, bundledSkillDirectory: bundledSkill, commandName: 'mioon-dev'}),
    repairOnStartup,
  });
  return {home, bin, command, claudeSkill, codexSkill, bundledSkill, host};
}

const owner = {isCurrent: () => true, canMutate: () => true, chooseDirectory: async (): Promise<string | null> => null};
const failure = (code: string, status: number) => ({ok: false, error: {code, status}});

function data(reply: ExternalAgentsReply) {
  assert.ok(externalAgentsReplySchema.safeParse(reply).success);
  if (!reply.ok) assert.fail(reply.error.code);
  return reply.data;
}

test('the settings host installs, repairs and removes a CLI and both skills in an isolated development profile', {skip: !supportedFixture}, async t => {
  const f = await fixture(t);
  const {dispatch} = f.host();
  const read = async () => data(await dispatch(owner, {kind: 'read'}));
  const initial = await read();
  assert.equal(initial.cli.state, 'not-installed');
  assert.deepEqual(initial.skills.map(skill => skill.state), ['not-installed', 'not-installed']);
  assert.equal(initial.mcpCommands.codex, `codex mcp add mioon-dev -- "${f.command}" mcp`);
  for (const request of [
    {kind: 'install-skill', agent: 'claude-code'},
    {kind: 'update-skill', agent: 'claude-code', overwriteModified: false},
    {kind: 'uninstall-skill', agent: 'codex'},
  ]) assert.deepEqual(await dispatch(owner, request), failure('CLI_REQUIRED', 409));

  const installed = data(await dispatch(owner, {kind: 'install-cli', location: 'default'}));
  assert.equal(installed.cli.commandPath, f.command);
  assert.deepEqual(installed.cli.pathHint, {line: 'export PATH="$HOME/.local/bin:$PATH"', rcFile: '~/.zshrc'});
  for (const [agent, directory] of [['claude-code', f.claudeSkill], ['codex', f.codexSkill]] as const) {
    const skill = data(await dispatch(owner, {kind: 'install-skill', agent})).skills.find(item => item.agent === agent);
    assert.equal(skill?.state, 'installed');
    const body = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
    assert.ok(body.includes(f.command));
    assert.ok(!body.includes('{{MIOON_COMMAND}}'));
  }

  await unlink(f.command);
  assert.equal((await read()).cli.reason, 'CLI_FILE_MISSING');
  assert.equal(data(await dispatch(owner, {kind: 'repair-cli'})).cli.state, 'installed');
  await writeFile(path.join(f.claudeSkill, 'personal.md'), 'untouched');
  const removed = data(await dispatch(owner, {kind: 'uninstall-skill', agent: 'claude-code'}));
  assert.equal(removed.skills.find(skill => skill.agent === 'claude-code')?.state, 'not-installed');
  assert.equal(await readFile(path.join(f.claudeSkill, 'personal.md'), 'utf8'), 'untouched');
  await writeFile(path.join(f.bin, 'another-program'), 'keep');
  assert.equal(data(await dispatch(owner, {kind: 'uninstall-cli'})).cli.state, 'not-installed');
  assert.equal(await readFile(path.join(f.bin, 'another-program'), 'utf8'), 'keep');
  await assert.rejects(access(f.command), {code: 'ENOENT'});
});

test('the host owns the directory chooser, preserves failed states and refuses stale or busy requests', {skip: !supportedFixture}, async t => {
  const f = await fixture(t);
  const {dispatch} = f.host();
  const request = {kind: 'install-cli', location: 'choose'};
  const chosen = path.join(f.home, 'chosen folder');
  await mkdir(chosen);
  await mkdir(f.bin, {recursive: true});
  await writeFile(f.command, 'another CLI');
  assert.deepEqual(await dispatch(null, request), failure('EXTERNAL_AGENTS_UNAVAILABLE', 503));
  assert.deepEqual(await dispatch({...owner, canMutate: () => false}, request), failure('EXTERNAL_AGENTS_UNAVAILABLE', 503));
  assert.deepEqual(await dispatch(owner, {...request, directory: chosen}), failure('EXTERNAL_AGENTS_INVALID', 400));
  const failed = data(await dispatch(owner, {kind: 'install-cli', location: 'default'}));
  assert.equal(failed.cli.reason, 'CLI_INSTALL_TARGET_EXISTS');
  assert.deepEqual(data(await dispatch(owner, request)), failed);

  let current = true;
  const directory = Promise.withResolvers<string>();
  const opened = Promise.withResolvers<void>();
  const choosing = dispatch({...owner, isCurrent: () => current, chooseDirectory: () => {
    opened.resolve();
    return directory.promise;
  }}, request);
  await opened.promise;
  assert.deepEqual(await dispatch(owner, {kind: 'uninstall-cli'}), failure('EXTERNAL_AGENTS_BUSY', 409));
  current = false;
  directory.resolve(chosen);
  assert.deepEqual(await choosing, failure('EXTERNAL_AGENTS_UNAVAILABLE', 503));
  await assert.rejects(access(path.join(chosen, 'mioon-dev')), {code: 'ENOENT'});

  const disappeared = data(await dispatch({...owner, chooseDirectory: async () => path.join(chosen, 'removed')}, request));
  assert.equal(disappeared.cli.reason, 'CLI_INSTALL_NOT_WRITABLE');
  assert.equal(disappeared.mcpCommands.codex, failed.mcpCommands.codex);
  const installed = data(await dispatch({...owner, chooseDirectory: async () => chosen}, request));
  assert.equal(installed.cli.commandPath, path.join(chosen, 'mioon-dev'));
  assert.equal(installed.cli.state, 'installed');
  assert.equal(await readFile(f.command, 'utf8'), 'another CLI');
});

test('startup refreshes clean skills and changed skills require an explicit overwrite', {skip: !supportedFixture}, async t => {
  const f = await fixture(t);
  const before = f.host();
  data(await before.dispatch(owner, {kind: 'install-cli', location: 'default'}));
  for (const agent of ['claude-code', 'codex']) data(await before.dispatch(owner, {kind: 'install-skill', agent}));
  const file = 'SKILL.md';
  const claude = path.join(f.claudeSkill, file);
  const bundled = path.join(f.bundledSkill, file);
  const original = await readFile(bundled, 'utf8');
  await writeFile(claude, 'local edits');
  await writeFile(bundled, original + '\nNew version.\n');

  const restarted = f.host('0.4.1', true);
  const view = data(await restarted.dispatch(owner, {kind: 'read'}));
  assert.equal(view.cli.version, '0.4.1');
  assert.deepEqual(view.skills.map(item => item.state), ['modified', 'installed']);
  assert.match(await readFile(path.join(f.codexSkill, file), 'utf8'), /New version\./u);
  const request = {kind: 'update-skill', agent: 'claude-code'};
  assert.deepEqual(await restarted.dispatch(owner, {...request, overwriteModified: false}), failure('SKILL_MODIFIED', 409));
  assert.equal(await readFile(claude, 'utf8'), 'local edits');
  assert.equal(data(await restarted.dispatch(owner, {...request, overwriteModified: true})).skills[0]?.state, 'installed');
  assert.match(await readFile(claude, 'utf8'), /New version\./u);
});
