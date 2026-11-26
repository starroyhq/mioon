import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {type TestContext} from 'node:test';
import {createExternalAgentSkills} from '../apps/desktop/src/external-agent-skills.ts';

const template = '---\nname: mioon\n---\n"{{MIOON_COMMAND}}" doctor\n';
const templateName = 'SKILL.md';
const referenceName = 'references/connection.md';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-external-agent-skills-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const homeDirectory = path.join(root, 'home');
  const appDataDirectory = path.join(homeDirectory, 'app-data');
  const bundledSkillDirectory = path.join(root, 'bundle');
  const commandPath = path.join(homeDirectory, '.local', 'bin', 'mioon-dev');
  const claude = path.join(homeDirectory, '.claude', 'skills', 'mioon-dev');
  const codex = path.join(homeDirectory, '.codex', 'skills', 'mioon-dev');
  const options = {homeDirectory, appDataDirectory, bundledSkillDirectory, commandName: 'mioon-dev'} as const;
  await mkdir(homeDirectory);
  await mkdir(path.join(bundledSkillDirectory, 'references'), {recursive: true});
  await writeFile(path.join(bundledSkillDirectory, templateName), template);
  await writeFile(path.join(bundledSkillDirectory, referenceName), 'Run "{{MIOON_COMMAND}}" doctor\n');
  return {
    homeDirectory, appDataDirectory, bundledSkillDirectory, commandPath, claude, codex, options,
    skills: createExternalAgentSkills(options),
    manifest: path.join(appDataDirectory, 'external-agent-skills.json'),
  };
}

test('installs both development skill trees, renders the command, and records installed file hashes', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.skills.read('claude-code'), {
    agent: 'claude-code', state: 'not-installed', displayDirectory: '~/.claude/skills/mioon-dev',
  });
  for (const [agent, directory] of [['claude-code', f.claude], ['codex', f.codex]] as const) {
    await f.skills.install(agent, f.commandPath);
    const main = await readFile(path.join(directory, templateName), 'utf8');
    assert.equal(main, `---\nname: mioon-dev\n---\n"${f.commandPath}" doctor\n`);
    assert.equal(await readFile(path.join(directory, referenceName), 'utf8'), `Run "${f.commandPath}" doctor\n`);
    const manifest = JSON.parse(await readFile(f.manifest, 'utf8'));
    assert.equal(manifest.installations[agent].files[templateName], createHash('sha256').update(main).digest('hex'));
    assert.equal((await f.skills.read(agent)).state, 'installed');
  }
  await f.skills.uninstall('codex');
  await assert.rejects(lstat(f.codex), {code: 'ENOENT'});
  assert.equal((await f.skills.read('claude-code')).state, 'installed');
});

test('isolates the release skill from development and leaves unrelated files and directories on uninstall', async t => {
  const f = await fixture(t);
  const production = createExternalAgentSkills({
    ...f.options, appDataDirectory: path.join(f.homeDirectory, 'production-data'), commandName: 'mioon',
  });
  const productionDirectory = path.join(path.dirname(f.claude), 'mioon');
  const productionCommand = path.join(f.homeDirectory, 'commands', 'mioon');
  const existingReferenceDirectory = path.dirname(path.join(f.claude, referenceName));
  await mkdir(existingReferenceDirectory, {recursive: true});
  await mkdir(path.join(f.claude, 'personal'));
  await writeFile(path.join(f.claude, 'keep.txt'), 'personal content');
  await f.skills.install('claude-code', f.commandPath);
  await production.install('claude-code', productionCommand);
  await f.skills.uninstall('claude-code');
  assert.equal(await readFile(path.join(f.claude, 'keep.txt'), 'utf8'), 'personal content');
  assert.ok((await lstat(path.join(f.claude, 'personal'))).isDirectory());
  assert.ok((await lstat(existingReferenceDirectory)).isDirectory());
  for (const file of [templateName, referenceName]) await assert.rejects(lstat(path.join(f.claude, file)), {code: 'ENOENT'});
  assert.equal(await readFile(path.join(productionDirectory, templateName), 'utf8'),
    `---\nname: mioon\n---\n"${productionCommand}" doctor\n`);
});

test('auto-updates a pristine install and requires confirmation for an edited install with a newer bundle', async t => {
  const f = await fixture(t);
  await f.skills.install('claude-code', f.commandPath);
  await f.skills.install('codex', f.commandPath);
  await writeFile(path.join(f.codex, templateName), 'my changes');
  assert.equal((await f.skills.read('codex', f.commandPath)).state, 'installed');
  await unlink(path.join(f.bundledSkillDirectory, referenceName));
  await writeFile(path.join(f.bundledSkillDirectory, templateName), template + 'updated');
  const restarted = createExternalAgentSkills(f.options);
  assert.equal((await restarted.read('claude-code', f.commandPath)).state, 'update-available');
  assert.equal((await restarted.read('codex', f.commandPath)).state, 'modified');
  await restarted.autoUpdate('claude-code', f.commandPath);
  await restarted.autoUpdate('codex', f.commandPath);
  assert.equal((await restarted.read('claude-code')).state, 'installed');
  assert.equal(await readFile(path.join(f.codex, templateName), 'utf8'), 'my changes');
  await assert.rejects(lstat(path.join(f.claude, referenceName)), {code: 'ENOENT'});
  assert.equal(await restarted.update('codex', f.commandPath, false), 'modified');
  assert.equal(await readFile(path.join(f.codex, templateName), 'utf8'), 'my changes');
  assert.equal(await restarted.update('codex', f.commandPath, true), 'updated');
  assert.match(await readFile(path.join(f.codex, templateName), 'utf8'), /updated$/u);
  assert.equal((await restarted.read('codex')).state, 'installed');
});

test('a pristine skill is refreshed when the CLI moves and shell metacharacters are quoted literally', async t => {
  const f = await fixture(t);
  const selectedCommand = path.join(f.homeDirectory, "a '! $P", 'mioon-dev');
  await f.skills.install('claude-code', f.commandPath);
  assert.equal((await f.skills.read('claude-code', selectedCommand)).state, 'update-available');
  await f.skills.autoUpdate('claude-code', selectedCommand);
  const installed = await readFile(path.join(f.claude, templateName), 'utf8');
  const quoted = "'" + selectedCommand.replaceAll("'", "'\"'\"'") + "'";
  assert.equal(installed, `---\nname: mioon-dev\n---\n${quoted} doctor\n`);
  assert.equal((await f.skills.read('claude-code')).state, 'installed');
});

test('preserves an unmanaged file at a bundle path before installing anything', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(path.join(f.claude, referenceName)), {recursive: true});
  await writeFile(path.join(f.claude, referenceName), 'personal content');
  await assert.rejects(f.skills.install('claude-code', f.commandPath), /unmanaged file/u);
  await assert.rejects(lstat(path.join(f.claude, templateName)), {code: 'ENOENT'});
  await assert.rejects(lstat(f.manifest), {code: 'ENOENT'});
  assert.equal(await readFile(path.join(f.claude, referenceName), 'utf8'), 'personal content');
});

test('a replaced skill directory does not inherit ownership from the previous installation', async t => {
  const f = await fixture(t);
  await f.skills.install('claude-code', f.commandPath);
  const previousDirectory = f.claude + '-previous';
  await rename(f.claude, previousDirectory);
  await mkdir(f.claude);
  await writeFile(path.join(f.claude, templateName), 'new unrelated skill');
  assert.equal((await f.skills.read('claude-code')).state, 'not-installed');
  await assert.rejects(f.skills.install('claude-code', f.commandPath), /unmanaged file/u);
  await f.skills.uninstall('claude-code');
  assert.equal(await readFile(path.join(f.claude, templateName), 'utf8'), 'new unrelated skill');
  assert.match(await readFile(path.join(previousDirectory, templateName), 'utf8'), /name: mioon-dev/u);
});

test('does not follow directory or file links during install, update, or uninstall', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  const other = path.join(f.homeDirectory, 'unmanaged');
  const agentRoot = path.dirname(path.dirname(f.claude));
  await mkdir(other);
  await symlink(other, agentRoot);
  await assert.rejects(f.skills.install('claude-code', f.commandPath));
  await assert.rejects(lstat(path.join(other, 'skills')), {code: 'ENOENT'});
  await unlink(agentRoot);
  await f.skills.install('claude-code', f.commandPath);
  const unmanaged = path.join(other, templateName);
  await writeFile(unmanaged, 'keep');
  await unlink(path.join(f.claude, templateName));
  await symlink(unmanaged, path.join(f.claude, templateName));
  await writeFile(path.join(f.bundledSkillDirectory, templateName), template + 'updated');
  assert.equal((await f.skills.read('claude-code')).state, 'modified');
  await assert.rejects(f.skills.update('claude-code', f.commandPath, true), /unmanaged file/u);
  await f.skills.uninstall('claude-code');
  assert.ok((await lstat(path.join(f.claude, templateName))).isSymbolicLink());
  assert.equal(await readFile(unmanaged, 'utf8'), 'keep');
  assert.equal((await f.skills.read('claude-code')).state, 'not-installed');
});

test('rolls back an initial install when one nested destination cannot be written', {skip: process.getuid?.() === 0}, async t => {
  const f = await fixture(t);
  const restricted = path.dirname(path.join(f.claude, referenceName));
  await mkdir(restricted, {recursive: true});
  await chmod(restricted, 0o500);
  try {
    await assert.rejects(f.skills.install('claude-code', f.commandPath), {code: 'EACCES'});
    await assert.rejects(lstat(path.join(f.claude, templateName)), {code: 'ENOENT'});
    await assert.rejects(lstat(f.manifest), {code: 'ENOENT'});
  } finally {
    await chmod(restricted, 0o700);
  }
  await f.skills.install('claude-code', f.commandPath);
  assert.equal((await f.skills.read('claude-code')).state, 'installed');
});
