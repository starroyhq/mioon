import test from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {agentCommandHelp, isAgentCommand, validateAgentOptions} from '../apps/cli/src/agent.ts';
import {argumentsFor} from '../apps/cli/src/arguments.ts';
import {help} from '../apps/cli/src/help.ts';
import {discoverSchema, EXIT_CODES, operationDefinition, schemas, splitProjectAddress, VERSION} from '../packages/client/src/index.ts';
import {isEntityAddressedOperation} from '../packages/contracts/src/project-addressing.ts';

const repo = path.resolve(import.meta.dirname, '..');
const skill = path.join(repo, 'skills/mioon');
const marker = '{{MIOON_COMMAND}}', launcher = `"${marker}"`;
const mcpName = /^(?=.*[a-z])[A-Za-z][A-Za-z0-9-]*(?:_[A-Za-z0-9-]+)+$/u;
const helpers = new Set(help(undefined, {VERSION, EXIT_CODES, discoverSchema, schemas}).usage.flatMap(usage => {
  const command = /^mioon ([a-z-]+(?: [a-z-]+)*)(?= --| \[|$)/u.exec(usage)?.[1];
  return command === undefined ? [] : [command.replaceAll(' ', '.')];
}));
const namespaces = new Set([...Object.keys(schemas), ...helpers].map(operation => operation.split('.')[0]));

function docsIn(directory: string): string[] {
  assert.ok(lstatSync(directory).isDirectory(), `${path.relative(skill, directory)} must be an installed directory`);
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `${path.relative(skill, file)} would depend on a symlink after installation`);
    return entry.isDirectory() ? docsIn(file) : entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [file] : [];
  });
}

function validateLink(raw: string, file: string): void {
  const label = path.relative(skill, file);
  const target = decodeURIComponent(raw.split(/[?#]/u)[0]);
  if (!target) return;
  if (/^https?:\/\//iu.test(target)) {
    const url = new URL(target);
    const repository = ['github.com', 'raw.githubusercontent.com'].includes(url.hostname) && /^\/starroyhq\/mioon\//iu.test(url.pathname);
    assert.ok(!repository || !/\/docs(?:\/|$)/iu.test(url.pathname), `${label}: repository docs link ${raw}`);
    return;
  }
  assert.ok(!path.isAbsolute(target) && !target.includes('\\') && !target.includes(':'), `${label}: invalid installed link ${raw}`);
  const local = path.resolve(path.dirname(file), target);
  const isInside = (name: string) => {
    const relative = path.relative(skill, name);
    return !path.isAbsolute(relative) && !/^\.\.(?:[\\/]|$)/u.test(relative);
  };
  assert.ok(isInside(local), `${label}: link leaves the installed skill ${raw}`);
  let resolved: string;
  try { resolved = realpathSync(local); } catch { assert.fail(`${label}: missing installed link ${raw}`); }
  assert.ok(isInside(resolved), `${label}: link leaves the installed skill ${raw}`);
}

/** Read literal shell arguments without expanding a variable or executing a sample. */
function cliWords(command: string, label: string): string[] {
  const text = command.slice(launcher.length).trim();
  const tokens = /(?:'([^'\n]*)'|"([^"\n$`\\]*)"|([a-zA-Z0-9_./:=+@-]+))(?=\s|$)\s*/uy;
  const argv = [];
  while (tokens.lastIndex < text.length) {
    const unmatched = tokens.lastIndex;
    const found = tokens.exec(text);
    assert.ok(found, `${label}: unsupported shell syntax near ${text.slice(unmatched)}`);
    argv.push(found[1] ?? found[2] ?? found[3]);
  }
  return argv;
}

function checkCommand(command: string, label: string): void {
  const {words, options} = argumentsFor(cliWords(command, label), message => assert.fail(`${label}: ${message}`), () => {});
  const operation = (words[0] === 'rpc' ? words.slice(1) : words).join('.');
  if (!operation && !words.length) {
    assert.ok(options.help || options.version, `${label}: name a command or use --help/--version`);
    return;
  }
  assert.ok(options.input === undefined || options['input-file'] === undefined, `${label}: --input and --input-file are exclusive`);
  if (words[0] === 'schema') {
    const selected = words.slice(1).join('.');
    if (isAgentCommand(selected.split('.'))) agentCommandHelp(selected);
    else if (selected) assert.ok(Object.hasOwn(schemas, selected), `${label}: unknown CLI schema ${selected}`);
    return;
  }
  if (isAgentCommand(words)) {
    validateAgentOptions(operation, options);
    const descriptor = agentCommandHelp(operation) as {operation?: string};
    assert.ok(descriptor.operation || options.help || options.version, `${label}: incomplete Agent command`);
    if (operation === 'agent.task.upload' && (options.input !== undefined || options['input-file'] !== undefined)) {
      assert.ok(options.file, `${label}: include the authorized local file with --file`);
    }
    return;
  }
  assert.ok(!['project.delete', 'project.duplicate'].includes(operation), `${label}: ${operation} is unavailable through the CLI`);
  const rpc = Object.hasOwn(schemas, operation);
  assert.ok(rpc || operation !== 'schema' && helpers.has(operation), `${label}: unknown CLI command ${operation}`);
  if (!rpc || typeof options.input !== 'string' || options.input === '-' || options.file !== undefined) return;
  let input: unknown;
  try { input = JSON.parse(options.input); } catch { assert.fail(`${label}: --input must be literal JSON`); }
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), `${label}: expected one JSON input object`);
  const payload = input as Record<string, unknown>;
  if (typeof options['request-id'] === 'string') {
    assert.ok(payload.requestId === undefined || payload.requestId === options['request-id'], `${label}: conflicting requestId`);
    payload.requestId = options['request-id'];
  }
  const addressed = splitProjectAddress(operation, payload);
  if (isEntityAddressedOperation(operation)) assert.ok(addressed.projectId, `${label}: missing projectId`);
  const parsed = schemas[operation as keyof typeof schemas].safeParse(addressed.input);
  assert.ok(parsed.success, `${label}: ${operationDefinition(operation).command}\n${parsed.success ? '' : parsed.error.message}`);
}

function scan(file: string): {commands: string[]; tools: string[]} {
  assert.ok(lstatSync(file).isFile(), `${path.relative(skill, file)} must be an installed file`);
  const text = readFileSync(file, 'utf8');
  const commands: string[] = [], tools: string[] = [];
  const label = path.relative(skill, file);
  const readCommand = (line: string): void => {
    assert.ok(line.startsWith(`${launcher} `), `${label}: use the quoted installed command as the command prefix: ${line}`);
    commands.push(line);
  };
  const unfenced = text.replace(/^[ \t]*(`{3,})([a-z-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*\r?$/gmu,
    (_whole, _fence: string, language: string, body: string) => {
      if (['sh', 'bash', 'shell'].includes(language)) {
        for (const line of body.replace(/\\[ \t]*\r?\n[ \t]*/gu, ' ').split(/\r?\n/u).map(value => value.trim())) {
          if (line && !line.startsWith('#')) readCommand(line);
        }
      } else assert.ok(!body.includes(marker), `${label}: CLI samples need a shell fence or inline code`);
      return '';
    });
  const prose = unfenced.replace(/(?<!`)(`+)([^`\r\n]+)\1(?!`)/gu, (_whole, _ticks: string, literal: string) => {
    const code = literal.trim();
    if (code === marker || code === launcher) return '';
    if (code.includes(marker)) readCommand(code);
    else if (mcpName.test(code)) tools.push(code);
    else if (/^(?:mioon(?:-dev)?|node|pnpm)\s/u.test(code) ||
      (/^[a-z][a-zA-Z0-9-]*(?: [a-zA-Z0-9-]+)+$/u.test(code) && namespaces.has(code.split(' ')[0]))) {
      assert.fail(`${label}: format command heads with ${launcher}: ${code}`);
    }
    return '';
  });
  assert.ok(!prose.includes(marker), `${label}: put the command placeholder in inline code or a shell fence`);
  for (const link of prose.matchAll(/\]\(\s*<?([^>\s)]+)>?[^\r\n)]*\)|^\s*\[[^\]\r\n]+\]:\s*<?([^>\s]+)>?/gmu)) {
    validateLink(link[1] ?? link[2], file);
  }
  return {commands, tools};
}

test('the installed Mioon skill and its references name available CLI commands and MCP tools', {timeout: 30_000}, async t => {
  const files = [path.join(skill, 'SKILL.md'), ...docsIn(path.join(skill, 'references'))];
  const mentions = files.map(file => ({label: path.relative(skill, file), ...scan(file)}));
  assert.ok(mentions.some(({commands}) => commands.length), 'expected documented CLI commands');
  assert.ok(mentions.some(({tools}) => tools.length), 'expected documented MCP tools');
  for (const {commands, label} of mentions) for (const command of commands) checkCommand(command, `${label}: ${command}`);

  const home = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-skill-catalog-'));
  const mcp = new Client({name: 'mioon-skill-drift-test', version: VERSION});
  t.after(async () => {try { await mcp.close(); } finally { rmSync(home, {recursive: true, force: true}); }});
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts'], cwd: repo,
    env: {HOME: home, USERPROFILE: home, MIOON_CONNECTION_FILE: path.join(home, 'missing.json')}, stderr: 'ignore'}));
  const catalog = new Set((await mcp.listTools({}, {timeout: 15_000})).tools.map(tool => tool.name));
  for (const {tools, label} of mentions) for (const tool of tools) assert.ok(catalog.has(tool), `${label}: unknown MCP tool ${tool}`);
});
