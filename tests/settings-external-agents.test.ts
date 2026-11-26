import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';
import {
  EXTERNAL_AGENTS_CHANNEL,
  externalAgentsReplySchema,
  externalAgentsRequestSchema,
  externalAgentsViewSchema,
} from '../packages/contracts/src/external-agents.ts';
import type {
  CliReason,
  ExternalAgent,
  ExternalAgentsBridge,
  ExternalAgentsErrorCode,
  ExternalAgentsView,
} from '../packages/contracts/src/external-agents.ts';
import { LOCALES, renderMessage, translate, validateCatalogs } from '../packages/i18n/src/index.ts';
import { externalAgentsMessages } from '../packages/i18n/src/catalogs/external-agents.ts';
import {
  ExternalAgentsClientError,
  externalAgentsErrorMessage,
  externalAgentsReasonMessage,
  hasExternalAgentsBridge,
  readExternalAgentsBridge,
  readExternalAgentsErrorCode,
} from '../apps/web/src/external-agents-client.ts';
import * as externalAgentsClient from '../apps/web/src/external-agents-client.ts';
import { visibleSettingsCategories } from '../apps/web/src/settings-categories.ts';
import { i18nTestModule } from './helpers/i18n.ts';
import type { RootHook, RootNode, RootTree } from './helpers/strict-root-ui-types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const flush = () => new Promise(setImmediate);

function collectNodes(value: RootTree): RootNode[] {
  if (Array.isArray(value)) return value.flatMap(collectNodes);
  if (!value || typeof value !== 'object') return [];
  if (typeof value.type === 'function') {
    const rendered = (value.type as (props: Record<string, unknown>) => RootTree)(value.props ?? {});
    return [value, ...collectNodes(rendered)];
  }
  const children = value.props?.children;
  const extras: RootTree[] = [];
  if (value.props) {
    for (const key of ['render', 'footer', 'actions']) {
      const candidate = value.props[key];
      if (candidate && typeof candidate === 'object') extras.push(candidate as RootTree);
    }
  }
  return [value, ...collectNodes(children), ...extras.flatMap(collectNodes)];
}

function collectText(value: RootTree): string {
  if (Array.isArray(value)) return value.map(collectText).join('');
  if (value && typeof value === 'object') return collectText(value.props?.children);
  return value == null || typeof value === 'boolean' ? '' : String(value);
}

function sampleView(patch: Partial<ExternalAgentsView> = {}): ExternalAgentsView {
  return {
    commandName: 'mioon',
    appVersion: '0.4.0',
    cli: {
      state: 'not-installed',
      displayPath: '~/.local/bin/mioon',
      onPath: 'unknown',
    },
    mcpCommands: {
      claudeCode: 'claude mcp add -s user mioon -- "$HOME/.local/bin/mioon" mcp',
      codex: 'codex mcp add mioon -- "$HOME/.local/bin/mioon" mcp',
    },
    skills: [
      { agent: 'claude-code', state: 'not-installed', displayDirectory: '~/.claude/skills/mioon' },
      { agent: 'codex', state: 'not-installed', displayDirectory: '~/.codex/skills/mioon' },
    ],
    ...patch,
  };
}

function installedView(patch: Partial<ExternalAgentsView['cli']> = {}, skills?: ExternalAgentsView['skills']): ExternalAgentsView {
  return sampleView({
    cli: {
      state: 'installed',
      version: '0.4.0',
      commandPath: '/opt/synthetic-home/.local/bin/mioon',
      displayPath: '~/.local/bin/mioon',
      onPath: 'yes',
      ...patch,
    },
    ...(skills ? { skills } : {}),
  });
}

function createFakeBridge(initial: ExternalAgentsView, overrides: Partial<ExternalAgentsBridge> = {}) {
  let current = initial;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, args: unknown[], impl?: () => Promise<T>): Promise<T> => {
    calls.push({ method, args });
    return impl ? impl() : Promise.resolve(current as unknown as T);
  };
  const bridge: ExternalAgentsBridge = {
    read: () => overrides.read ? record('read', [], () => overrides.read!()) : record('read', []),
    installCli: location => overrides.installCli
      ? record('installCli', [location], () => overrides.installCli!(location))
      : record('installCli', [location], async () => {
        current = installedView();
        return current;
      }),
    uninstallCli: () => overrides.uninstallCli
      ? record('uninstallCli', [], () => overrides.uninstallCli!())
      : record('uninstallCli', [], async () => {
        current = { ...current, cli: sampleView().cli };
        return current;
      }),
    repairCli: () => overrides.repairCli
      ? record('repairCli', [], () => overrides.repairCli!())
      : record('repairCli', [], async () => {
        current = installedView();
        return current;
      }),
    installSkill: agent => overrides.installSkill
      ? record('installSkill', [agent], () => overrides.installSkill!(agent))
      : record('installSkill', [agent], async () => {
        current = {
          ...current,
          skills: current.skills.map(skill => skill.agent === agent ? { ...skill, state: 'installed' } : skill),
        };
        return current;
      }),
    uninstallSkill: agent => overrides.uninstallSkill
      ? record('uninstallSkill', [agent], () => overrides.uninstallSkill!(agent))
      : record('uninstallSkill', [agent], async () => {
        current = {
          ...current,
          skills: current.skills.map(skill => skill.agent === agent ? { ...skill, state: 'not-installed' } : skill),
        };
        return current;
      }),
    updateSkill: (agent, overwriteModified) => overrides.updateSkill
      ? record('updateSkill', [agent, overwriteModified], () => overrides.updateSkill!(agent, overwriteModified))
      : record('updateSkill', [agent, overwriteModified], async () => {
        const target = current.skills.find(skill => skill.agent === agent);
        if (target?.state === 'modified' && !overwriteModified) {
          throw new ExternalAgentsClientError('SKILL_MODIFIED', 409);
        }
        current = {
          ...current,
          skills: current.skills.map(skill => skill.agent === agent ? { ...skill, state: 'installed' } : skill),
        };
        return current;
      }),
  };
  return {
    bridge,
    calls,
    setView(next: ExternalAgentsView) { current = next; },
  };
}

function mountExternalAgents(
  initialProps: Record<string, unknown>,
  locale: Parameters<typeof i18nTestModule>[0] = 'zh-Hans',
) {
  const hooks: RootHook[] = [];
  let cursor = 0;
  let effects: number[] = [];
  let tree: RootTree = null;
  let props: Record<string, unknown> = { active: true, ...initialProps };

  const react = {
    Fragment: 'Fragment',
    createElement: (type: string, elementProps: Record<string, unknown> | null, ...children: RootTree[]) => ({
      type,
      props: { ...elementProps, children },
    }),
    useRef(initial: unknown) { return hooks[cursor++] ||= { current: initial }; },
    useCallback(callback: unknown, deps: readonly unknown[]) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous?.deps?.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) {
        return previous.value;
      }
      hooks[index] = { value: callback, deps };
      return callback;
    },
    useState(initial: unknown) {
      const index = cursor++;
      hooks[index] ||= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      return [
        hooks[index].value,
        (next: unknown) => {
          hooks[index].value = typeof next === 'function'
            ? (next as (prev: unknown) => unknown)(hooks[index].value)
            : next;
        },
      ];
    },
    useEffect(callback: () => void | (() => void), deps: readonly unknown[] | undefined) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) {
        return;
      }
      hooks[index] = { callback, deps, cleanup: previous?.cleanup };
      effects.push(index);
    },
  };
  (react as typeof react & { default?: unknown }).default = react;

  const primitive = new Proxy({}, { get: (_, key) => String(key) });
  const module: { exports: { default?: (componentProps: Record<string, unknown>) => RootTree } } = { exports: {} };
  const source = readFileSync(new URL('../apps/web/src/ExternalAgentsSettings.tsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code)(
    (name: string) => {
      if (name === 'react') return react;
      if (name === './i18n/I18nProvider.tsx') return i18nTestModule(locale);
      if (name === './external-agents-client.ts') return externalAgentsClient;
      if (name === './icons.tsx') return { __esModule: true, default: 'Icon' };
      if (name === './WorkspaceControls.tsx') return { WorkbenchTooltip: 'WorkbenchTooltip' };
      if (name.startsWith('@mioon/ui/') || name.endsWith('.css')) return primitive;
      assert.fail(`Unexpected ExternalAgentsSettings dependency: ${name}`);
    },
    module,
    module.exports,
  );
  const Component = module.exports.default!;

  return {
    render(patch: Record<string, unknown> = {}) {
      props = { ...props, ...patch };
      cursor = 0;
      effects = [];
      tree = Component(props);
      for (const index of effects) {
        hooks[index].cleanup?.();
        hooks[index].cleanup = hooks[index].callback!();
      }
      return tree;
    },
    find(id: string) {
      return collectNodes(tree).find(node => node.props?.['data-testid'] === id);
    },
    findAll(predicate: (node: RootNode) => boolean) {
      return collectNodes(tree).filter(predicate);
    },
    get tree() { return tree; },
    unmount() {
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

let shellRenderer: ((locale: string, page: string, withBridge: boolean) => string) | null = null;
function renderSettingsShell(locale: string, page: string, withBridge: boolean): string {
  if (!shellRenderer) {
    const fixture = `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { SettingsConnectionForms } from './src/SettingsConnectionForms.tsx';
      import { createSettingsNavigationRegistry } from './src/settings-navigation-state.ts';
      import { I18nProvider } from './src/i18n/I18nProvider.tsx';
      export function render(locale, page, withBridge) {
        const host = globalThis;
        const previous = host.__mioonExternalAgents;
        const hadWindow = Object.hasOwn(host, 'window');
        const previousWindow = host.window;
        if (!hadWindow) host.window = host;
        const fakeView = {
          commandName: 'mioon',
          appVersion: '0.4.0',
          cli: { state: 'not-installed', displayPath: '~/.local/bin/mioon', onPath: 'unknown' },
          mcpCommands: {
            claudeCode: 'claude mcp add -s user mioon -- "$HOME/.local/bin/mioon" mcp',
            codex: 'codex mcp add mioon -- "$HOME/.local/bin/mioon" mcp',
          },
          skills: [
            { agent: 'claude-code', state: 'not-installed', displayDirectory: '~/.claude/skills/mioon' },
            { agent: 'codex', state: 'not-installed', displayDirectory: '~/.codex/skills/mioon' },
          ],
        };
        if (withBridge) {
          host.__mioonExternalAgents = {
            read: async () => fakeView,
            installCli: async () => fakeView,
            uninstallCli: async () => fakeView,
            repairCli: async () => fakeView,
            installSkill: async () => fakeView,
            uninstallSkill: async () => fakeView,
            updateSkill: async () => fakeView,
          };
        } else {
          delete host.__mioonExternalAgents;
        }
        try {
          const snapshot = { ready: true, locale, preference: locale, persistence: 'saved', saving: false };
          const store = { subscribe: () => () => {}, getSnapshot: () => snapshot, setPreference: async () => {} };
          const registry = createSettingsNavigationRegistry();
          return renderToStaticMarkup(
            <I18nProvider store={store}>
              <SettingsConnectionForms
                selected="agent"
                page={page}
                visible={true}
                registry={registry}
                onSelect={() => {}}
                onPage={() => {}}
                general={null}
              />
            </I18nProvider>
          );
        } finally {
          if (previous === undefined) delete host.__mioonExternalAgents;
          else host.__mioonExternalAgents = previous;
          if (!hadWindow) delete host.window;
          else host.window = previousWindow;
        }
      }
    `;
    const built = buildSync({
      stdin: { contents: fixture, loader: 'tsx', resolveDir: path.join(root, 'apps/web') },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const mod: { exports: { render?: (locale: string, page: string, withBridge: boolean) => string } } = { exports: {} };
    Function('require', 'module', 'exports', built.outputFiles[0]!.text)(createRequire(import.meta.url), mod, mod.exports);
    shellRenderer = mod.exports.render!;
  }
  return shellRenderer(locale, page, withBridge);
}

test('contract schemas enforce channel name, view, requests, replies, and error codes strictly', () => {
  assert.equal(EXTERNAL_AGENTS_CHANNEL, 'mioon:external-agents:v1');
  assert.deepEqual(validateCatalogs(externalAgentsMessages), []);

  const validInstalled = installedView({
    onPath: 'no',
    pathHint: { line: 'export PATH="$HOME/.local/bin:$PATH"', rcFile: '~/.zshrc' },
  });
  assert.deepEqual(externalAgentsViewSchema.parse(validInstalled), validInstalled);

  const validDev = sampleView({
    commandName: 'mioon-dev',
    cli: {
      state: 'install-failed',
      displayPath: '~/.local/bin/mioon-dev',
      onPath: 'unknown',
      reason: 'CLI_INSTALL_TARGET_EXISTS',
      reasonValues: { directory: '~/.local/bin' },
    },
  });
  assert.deepEqual(externalAgentsViewSchema.parse(validDev), validDev);

  assert.equal(externalAgentsViewSchema.safeParse({ ...validInstalled, unexpected: true }).success, false);
  assert.equal(externalAgentsViewSchema.safeParse({ ...validInstalled, commandName: 'other' }).success, false);

  for (const request of [
    { kind: 'read' },
    { kind: 'install-cli', location: 'default' },
    { kind: 'install-cli', location: 'choose' },
    { kind: 'uninstall-cli' },
    { kind: 'repair-cli' },
    { kind: 'install-skill', agent: 'claude-code' },
    { kind: 'uninstall-skill', agent: 'codex' },
    { kind: 'update-skill', agent: 'claude-code', overwriteModified: false },
    { kind: 'update-skill', agent: 'codex', overwriteModified: true },
  ]) {
    assert.equal(externalAgentsRequestSchema.safeParse(request).success, true, JSON.stringify(request));
  }
  assert.equal(externalAgentsRequestSchema.safeParse({ kind: 'update-skill', agent: 'codex' }).success, false);

  assert.equal(externalAgentsReplySchema.safeParse({ ok: true, data: validInstalled }).success, true);
  for (const [code, status] of [
    ['EXTERNAL_AGENTS_UNAVAILABLE', 503],
    ['EXTERNAL_AGENTS_INVALID', 400],
    ['EXTERNAL_AGENTS_BUSY', 409],
    ['CLI_REQUIRED', 409],
    ['SKILL_MODIFIED', 409],
  ] as const) {
    assert.equal(externalAgentsReplySchema.safeParse({ ok: false, error: { code, status } }).success, true, code);
  }
  assert.equal(externalAgentsReplySchema.safeParse({ ok: false, error: { code: 'UNKNOWN', status: 500 } }).success, false);
});

test('bridge client detects presence, validates payloads, and formats all 7 CLI reasons and bridge errors in 4 locales', async () => {
  assert.equal(hasExternalAgentsBridge({}), false);
  assert.equal(readExternalAgentsBridge({}), null);
  assert.equal(hasExternalAgentsBridge({ __mioonExternalAgents: { read: () => Promise.resolve(null) } }), false);

  const view = installedView();
  const host = {
    __mioonExternalAgents: {
      read: async () => ({ ok: true, data: view }),
      installCli: async () => view,
      uninstallCli: async () => ({ ok: false, error: { code: 'EXTERNAL_AGENTS_BUSY', status: 409 } }),
      repairCli: async () => ({ malformed: true }),
      installSkill: async () => view,
      uninstallSkill: async () => view,
      updateSkill: async () => view,
    },
  };
  assert.equal(hasExternalAgentsBridge(host), true);
  const client = readExternalAgentsBridge(host)!;
  assert.deepEqual(await client.read(), view);
  await assert.rejects(() => client.uninstallCli(), (error: unknown) => readExternalAgentsErrorCode(error) === 'EXTERNAL_AGENTS_BUSY');
  await assert.rejects(() => client.repairCli(), (error: unknown) => readExternalAgentsErrorCode(error) === 'EXTERNAL_AGENTS_INVALID');

  const expectedReasons: ReadonlyArray<readonly [CliReason, Partial<ExternalAgentsView>, string]> = [
    ['CLI_FILE_MISSING', { cli: { state: 'needs-repair', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_FILE_MISSING' } }, '~/.local/bin/mioon 已被删除。'],
    ['CLI_TARGET_MISSING', { cli: { state: 'needs-repair', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_TARGET_MISSING' } }, '命令行工具指向的版本已不存在。'],
    ['CLI_VERSION_MISMATCH', { appVersion: '0.4.1', cli: { state: 'needs-repair', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_VERSION_MISMATCH', reasonValues: { installedVersion: '0.4.0' } } }, '命令行工具是 0.4.0，Mioon 是 0.4.1。'],
    ['CLI_AUTO_UPDATE_FAILED', { cli: { state: 'needs-repair', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_AUTO_UPDATE_FAILED' } }, '随 Mioon 更新命令行工具没有成功。'],
    ['CLI_INSTALL_TARGET_EXISTS', { cli: { state: 'install-failed', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_INSTALL_TARGET_EXISTS', reasonValues: { directory: '~/.local/bin' } } }, '~/.local/bin 里已经有一个别的 mioon。'],
    ['CLI_INSTALL_NOT_WRITABLE', { cli: { state: 'install-failed', displayPath: '/usr/local/bin/mioon', onPath: 'unknown', reason: 'CLI_INSTALL_NOT_WRITABLE', reasonValues: { directory: '/usr/local/bin' } } }, '/usr/local/bin 没有写入权限。'],
    ['CLI_INSTALL_FAILED', { cli: { state: 'install-failed', displayPath: '~/.local/bin/mioon', onPath: 'unknown', reason: 'CLI_INSTALL_FAILED' } }, '安装没有完成。'],
  ];

  for (const [reason, patch, zhExpected] of expectedReasons) {
    const msg = externalAgentsReasonMessage(sampleView(patch));
    assert.ok(msg, reason);
    assert.equal(renderMessage('zh-Hans', msg), zhExpected, reason);
    for (const locale of LOCALES) {
      const rendered = renderMessage(locale, msg);
      assert.ok(rendered.trim().length > 0 && !rendered.includes('{'), `${reason}/${locale}: ${rendered}`);
    }
  }

  const devTargetExists = externalAgentsReasonMessage(sampleView({
    commandName: 'mioon-dev',
    cli: {
      state: 'install-failed',
      displayPath: '~/.local/bin/mioon-dev',
      onPath: 'unknown',
      reason: 'CLI_INSTALL_TARGET_EXISTS',
      reasonValues: { directory: '~/.local/bin' },
    },
  }));
  assert.equal(renderMessage('zh-Hans', devTargetExists), '~/.local/bin 里已经有一个别的 mioon-dev。');

  for (const code of ['EXTERNAL_AGENTS_UNAVAILABLE', 'EXTERNAL_AGENTS_BUSY', 'CLI_REQUIRED', 'EXTERNAL_AGENTS_INVALID'] as const satisfies readonly ExternalAgentsErrorCode[]) {
    const msg = externalAgentsErrorMessage(new ExternalAgentsClientError(code, 409));
    for (const locale of LOCALES) {
      const rendered = renderMessage(locale, msg);
      assert.ok(rendered.trim().length > 0 && !rendered.includes(code), `${code}/${locale}: ${rendered}`);
    }
  }
  const unknownRendered = renderMessage('zh-Hans', externalAgentsErrorMessage(new Error('raw internal stack detail')));
  assert.equal(unknownRendered.includes('raw internal stack detail'), false);
});

test('F1 hides External Agents navigation without desktop bridge and places it directly below Mio when present', () => {
  assert.deepEqual(visibleSettingsCategories(false), ['general', 'workspace', 'video-tools', 'models', 'agent', 'shortcuts', 'about']);
  assert.deepEqual(visibleSettingsCategories(true), ['general', 'workspace', 'video-tools', 'models', 'agent', 'external-agents', 'shortcuts', 'about']);

  const withoutBridge = renderSettingsShell('zh-Hans', 'external-agents', false);
  assert.equal(withoutBridge.includes('data-testid="settings-category-external-agents"'), false);
  assert.match(withoutBridge, /data-page="general"/u);

  for (const locale of LOCALES) {
    const withBridge = renderSettingsShell(locale, 'external-agents', true);
    const mioIndex = withBridge.indexOf('data-testid="settings-category-agent"');
    const externalIndex = withBridge.indexOf('data-testid="settings-category-external-agents"');
    const shortcutsIndex = withBridge.indexOf('data-testid="settings-category-shortcuts"');
    assert.ok(mioIndex >= 0 && externalIndex > mioIndex && shortcutsIndex > externalIndex, locale);
    assert.ok(withBridge.includes('data-testid="settings-category-icon-external-agents"'), locale);
    assert.ok(withBridge.includes(translate(locale, 'redesign.settings.external-agents')), locale);
    assert.ok(withBridge.includes(translate(locale, 'externalAgents.subtitle')), locale);
  }
});

test('F2, F7, F8 render not-installed state with disabled skills, dimmed MCP rows, tooltips, and immediate install action', async () => {
  const fake = createFakeBridge(sampleView());
  const h = mountExternalAgents({ bridge: fake.bridge });
  h.render();
  await flush();
  h.render();

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.method, 'read');
  assert.equal(collectText(h.find('external-agents-command-name')), 'mioon');
  assert.equal(collectText(h.find('external-agents-cli-status')), '未安装');
  assert.ok(h.find('external-agents-cli-install'));
  assert.equal(h.find('external-agents-cli-uninstall'), undefined);
  assert.equal(h.find('external-agents-not-on-path'), undefined);

  const helpTooltip = h.findAll(node => node.type === 'WorkbenchTooltip' && node.props.content === '命令交给正在运行的 Mioon 执行，用之前先打开 Mioon。');
  assert.equal(helpTooltip.length, 1);

  const cliRequiredTooltips = h.findAll(node => node.type === 'WorkbenchTooltip' && node.props.content === '先安装命令行工具');
  assert.equal(cliRequiredTooltips.length, 4, 'two disabled skill install buttons and two dimmed MCP rows');
  for (const agent of ['claude-code', 'codex'] as const) {
    assert.equal(h.find(`external-agents-skill-install-${agent}`)?.props.disabled, true);
    assert.equal(h.find(`external-agents-mcp-row-${agent}`)?.props['data-disabled'], 'true');
    assert.equal(h.find(`external-agents-copy-mcp-${agent}`)?.props.disabled, true);
  }

  h.find('external-agents-cli-install')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'installCli', args: ['default'] });
  assert.equal(collectText(h.find('external-agents-cli-status')), '已安装');
  assert.equal(collectText(h.find('external-agents-cli-version')), '0.4.0');
  assert.equal(collectText(h.find('external-agents-cli-path')), '~/.local/bin/mioon');
  assert.equal(h.find('external-agents-not-on-path'), undefined, 'onPath=yes must hide Not in PATH badge');
  assert.equal(h.find('external-agents-skill-install-claude-code')?.props.disabled, false);
  assert.equal(h.find('external-agents-mcp-row-claude-code')?.props['data-disabled'], undefined);
  assert.equal(h.find('external-agents-copy-mcp-claude-code')?.props.disabled, false);

  h.unmount();
});

test('F4 and F5 show PATH popover only when onPath is no, copy absolute path and commands, and reset copied feedback', async () => {
  const copied: string[] = [];
  const fake = createFakeBridge(installedView({
    onPath: 'no',
    commandPath: '/opt/synthetic-home/.local/bin/mioon',
    displayPath: '~/.local/bin/mioon',
    pathHint: { line: 'export PATH="$HOME/.local/bin:$PATH"', rcFile: '~/.zshrc' },
  }));
  const h = mountExternalAgents({
    bridge: fake.bridge,
    copyText: async (value: string) => { copied.push(value); },
    copyResetMs: 25,
  });
  h.render();
  await flush();
  h.render();

  assert.ok(h.find('external-agents-not-on-path'));
  assert.equal(collectText(h.find('external-agents-path-hint-description')), '把这一行加到 ~/.zshrc，终端里就能直接输入 mioon。');
  assert.equal(collectText(h.find('external-agents-path-hint-line')), 'export PATH="$HOME/.local/bin:$PATH"');

  h.find('external-agents-copy-cli-path')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(copied, ['/opt/synthetic-home/.local/bin/mioon']);
  assert.equal(h.find('external-agents-copy-cli-path')?.props['data-copied'], 'true');
  assert.equal(collectText(h.find('external-agents-copied-cli-path')), '已复制');

  await new Promise(resolve => setTimeout(resolve, 40));
  h.render();
  assert.equal(h.find('external-agents-copy-cli-path')?.props['data-copied'], undefined);
  assert.equal(h.find('external-agents-copied-cli-path'), undefined);

  h.find('external-agents-copy-path-hint')!.props.onClick!();
  await flush();
  h.render();
  assert.equal(copied.at(-1), 'export PATH="$HOME/.local/bin:$PATH"');
  assert.equal(collectText(h.find('external-agents-copied-path-hint')), '已复制');

  h.find('external-agents-copy-mcp-claude-code')!.props.onClick!();
  await flush();
  h.render();
  assert.equal(copied.at(-1), 'claude mcp add -s user mioon -- "$HOME/.local/bin/mioon" mcp');
  assert.equal(collectText(h.find('external-agents-copied-mcp-claude-code')), '已复制');

  fake.setView(installedView({ onPath: 'unknown' }));
  h.render({ active: false });
  h.render({ active: true });
  await flush();
  h.render();
  assert.equal(h.find('external-agents-not-on-path'), undefined, 'onPath=unknown must hide Not in PATH badge');
  h.unmount();
});

test('F5 uses the desktop button gesture to copy plain text and preserves the browser clipboard path', async t => {
  const host = globalThis as Record<string, unknown>;
  const properties = ['__mioonExternalAgents', 'document', 'navigator'] as const;
  const original = properties.map(key => Object.getOwnPropertyDescriptor(host, key));
  t.after(() => properties.forEach((key, index) => {
    const descriptor = original[index];
    if (descriptor) Object.defineProperty(host, key, descriptor);
    else delete host[key];
  }));

  const view = installedView();
  const fake = createFakeBridge(view);
  host.__mioonExternalAgents = fake.bridge;
  const desktopCopies: Array<{ type: string; text: string }> = [];
  const browserCopies: string[] = [];
  type CopyListener = (event: {
    isTrusted: boolean;
    clipboardData: { setData(type: string, text: string): void };
    preventDefault(): void;
  }) => void;
  let onCopy: CopyListener | undefined;
  Object.defineProperty(host, 'document', { configurable: true, value: {
    addEventListener(event: string, listener: CopyListener, capture: boolean) {
      assert.equal(event, 'copy');
      assert.equal(capture, true);
      onCopy = listener;
    },
    removeEventListener(event: string, listener: CopyListener, capture: boolean) {
      assert.equal(event, 'copy');
      assert.equal(listener, onCopy);
      assert.equal(capture, true);
      onCopy = undefined;
    },
    execCommand(command: string) {
      assert.equal(command, 'copy');
      let defaultPrevented = false;
      onCopy!({
        isTrusted: true,
        clipboardData: { setData: (type, text) => { desktopCopies.push({ type, text }); } },
        preventDefault: () => { defaultPrevented = true; },
      });
      return defaultPrevented;
    },
  } });
  Object.defineProperty(host, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async (text: string) => { browserCopies.push(text); } },
  } });

  const h = mountExternalAgents({ bridge: fake.bridge });
  t.after(h.unmount);
  h.render();
  await flush();
  h.render();
  h.find('external-agents-copy-cli-path')!.props.onClick!();
  assert.deepEqual(desktopCopies, [{ type: 'text/plain', text: view.cli.commandPath }]);
  assert.equal(onCopy, undefined);
  assert.deepEqual(browserCopies, []);
  await flush();
  h.render();
  assert.equal(h.find('external-agents-copy-cli-path')?.props['data-copied'], 'true');

  delete host.__mioonExternalAgents;
  h.find('external-agents-copy-mcp-codex')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(browserCopies, [view.mcpCommands.codex]);
  assert.equal(desktopCopies.length, 1);
  assert.equal(h.find('external-agents-copy-mcp-codex')?.props['data-copied'], 'true');
});

test('F2 and F3 render needs-repair and install-failed states and trigger repair, choose-location, and retry actions', async () => {
  const fake = createFakeBridge(sampleView({
    appVersion: '0.4.1',
    cli: {
      state: 'needs-repair',
      displayPath: '~/.local/bin/mioon',
      onPath: 'unknown',
      reason: 'CLI_VERSION_MISMATCH',
      reasonValues: { installedVersion: '0.4.0' },
    },
  }));
  const h = mountExternalAgents({ bridge: fake.bridge });
  h.render();
  await flush();
  h.render();

  assert.equal(collectText(h.find('external-agents-cli-status')), '需要修复');
  assert.equal(collectText(h.find('external-agents-cli-reason')), '命令行工具是 0.4.0，Mioon 是 0.4.1。');
  assert.equal(h.find('external-agents-mcp-row-codex')?.props['data-disabled'], 'true');
  h.find('external-agents-cli-repair')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'repairCli', args: [] });
  assert.equal(collectText(h.find('external-agents-cli-status')), '已安装');

  const installCalls: Array<'default' | 'choose'> = [];
  const failedBridge = createFakeBridge(sampleView({
    cli: {
      state: 'install-failed',
      displayPath: '~/.local/bin/mioon',
      onPath: 'unknown',
      reason: 'CLI_INSTALL_TARGET_EXISTS',
      reasonValues: { directory: '~/.local/bin' },
    },
  }), {
    installCli: async location => {
      installCalls.push(location);
      return location === 'choose' ? installedView({ displayPath: '~/bin/mioon', commandPath: '/opt/synthetic-home/bin/mioon' }) : sampleView({
        cli: {
          state: 'install-failed',
          displayPath: '~/.local/bin/mioon',
          onPath: 'unknown',
          reason: 'CLI_INSTALL_TARGET_EXISTS',
          reasonValues: { directory: '~/.local/bin' },
        },
      });
    },
  });
  const failedHarness = mountExternalAgents({ bridge: failedBridge.bridge });
  failedHarness.render();
  await flush();
  failedHarness.render();

  assert.equal(collectText(failedHarness.find('external-agents-cli-status')), '安装失败');
  assert.equal(collectText(failedHarness.find('external-agents-cli-reason')), '~/.local/bin 里已经有一个别的 mioon。');
  failedHarness.find('external-agents-cli-retry')!.props.onClick!();
  await flush();
  failedHarness.render();
  failedHarness.find('external-agents-cli-choose')!.props.onClick!();
  await flush();
  failedHarness.render();
  assert.deepEqual(installCalls, ['default', 'choose']);
  assert.equal(collectText(failedHarness.find('external-agents-cli-status')), '已安装');
  assert.equal(collectText(failedHarness.find('external-agents-cli-path')), '~/bin/mioon');

  h.unmount();
  failedHarness.unmount();
});

test('F6 confirms modified skill overwrite on SKILL_MODIFIED 409 before retrying with overwriteModified true', async () => {
  const fake = createFakeBridge(installedView({}, [
    { agent: 'claude-code', state: 'modified', displayDirectory: '~/.claude/skills/mioon' },
    { agent: 'codex', state: 'update-available', displayDirectory: '~/.codex/skills/mioon' },
  ]));
  const h = mountExternalAgents({ bridge: fake.bridge });
  h.render();
  await flush();
  h.render();

  assert.equal(collectText(h.find('external-agents-skill-status-claude-code')), '有更新');
  assert.equal(collectText(h.find('external-agents-skill-status-codex')), '有更新');

  // Unmodified skill updates immediately with overwriteModified=false.
  h.find('external-agents-skill-update-codex')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'updateSkill', args: ['codex', false] });
  assert.equal(collectText(h.find('external-agents-skill-status-codex')), '已安装');

  // Modified skill gets SKILL_MODIFIED -> opens confirm dialog without showing an error alert.
  h.find('external-agents-skill-update-claude-code')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'updateSkill', args: ['claude-code', false] });
  assert.equal(h.find('external-agents-error'), undefined);
  const dialog = h.findAll(node => node.type === 'Dialog')[0]!;
  assert.equal(dialog.props.open, true);
  const dialogContent = h.find('external-agents-overwrite-dialog')!;
  assert.equal(dialogContent.props.title, '更新 Claude Code 技能？');
  assert.equal(dialogContent.props.description, '技能文件被改过，更新会覆盖这些改动。');

  // Cancel closes dialog without calling overwrite.
  h.find('external-agents-overwrite-cancel')!.props.onClick!();
  h.render();
  assert.equal(h.findAll(node => node.type === 'Dialog')[0]!.props.open, false);
  assert.equal(collectText(h.find('external-agents-skill-status-claude-code')), '有更新');

  // Re-trigger and confirm overwrite -> calls updateSkill('claude-code', true).
  h.find('external-agents-skill-update-claude-code')!.props.onClick!();
  await flush();
  h.render();
  h.find('external-agents-overwrite-confirm')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'updateSkill', args: ['claude-code', true] });
  assert.equal(h.findAll(node => node.type === 'Dialog')[0]!.props.open, false);
  assert.equal(collectText(h.find('external-agents-skill-status-claude-code')), '已安装');

  // Uninstall works immediately.
  h.find('external-agents-skill-uninstall-claude-code')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'uninstallSkill', args: ['claude-code'] });
  assert.equal(collectText(h.find('external-agents-skill-status-claude-code')), '未安装');

  h.unmount();
});

test('F7 leaves skill uninstall and update available after uninstalling the CLI', async () => {
  const fake = createFakeBridge(installedView({}, [
    { agent: 'claude-code', state: 'installed', displayDirectory: '~/.claude/skills/mioon' },
    { agent: 'codex', state: 'modified', displayDirectory: '~/.codex/skills/mioon' },
  ]), {
    updateSkill: async () => { throw { code: 'CLI_REQUIRED', status: 409 }; },
  });
  const h = mountExternalAgents({ bridge: fake.bridge });
  h.render();
  await flush();
  h.render();

  h.find('external-agents-cli-uninstall')!.props.onClick!();
  await flush();
  h.render();
  assert.equal(collectText(h.find('external-agents-cli-status')), '未安装');
  const uninstall = h.find('external-agents-skill-uninstall-claude-code')!;
  const update = h.find('external-agents-skill-update-codex')!;
  assert.equal(uninstall.props.disabled, false);
  assert.equal(update.props.disabled, false);
  assert.equal(h.find('external-agents-skill-disabled-codex'), undefined);
  assert.equal(h.find('external-agents-copy-mcp-claude-code')?.props.disabled, true);
  assert.equal(h.find('external-agents-copy-mcp-codex')?.props.disabled, true);

  update.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'updateSkill', args: ['codex', false] });
  assert.equal(collectText(h.find('external-agents-error')), translate('zh-Hans', 'externalAgents.error.CLI_REQUIRED'));
  assert.equal(h.findAll(node => node.type === 'Dialog')[0]!.props.open, false);

  h.find('external-agents-skill-uninstall-claude-code')!.props.onClick!();
  await flush();
  h.render();
  assert.deepEqual(fake.calls.at(-1), { method: 'uninstallSkill', args: ['claude-code'] });
  assert.equal(collectText(h.find('external-agents-skill-status-claude-code')), '未安装');
  assert.equal(h.find('external-agents-skill-install-claude-code')?.props.disabled, true);
  assert.equal(h.find('external-agents-error'), undefined);
  h.unmount();
});

test('F9 displays concise localized alerts for bridge failures and recovers on retry without exposing raw errors', async () => {
  let failRead = true;
  const fake = createFakeBridge(installedView(), {
    read: async () => {
      if (failRead) throw new ExternalAgentsClientError('EXTERNAL_AGENTS_UNAVAILABLE', 503);
      return installedView();
    },
    installSkill: async (_agent: ExternalAgent) => {
      throw new ExternalAgentsClientError('EXTERNAL_AGENTS_BUSY', 409);
    },
  });
  const h = mountExternalAgents({ bridge: fake.bridge });
  h.render();
  await flush();
  h.render();

  const initialError = h.find('external-agents-error');
  assert.ok(initialError);
  assert.equal(collectText(initialError), '外部 Agent 服务暂不可用，请重试。');
  assert.ok(h.find('external-agents-retry-read'));

  failRead = false;
  h.find('external-agents-retry-read')!.props.onClick!();
  await flush();
  h.render();
  assert.equal(h.find('external-agents-error'), undefined);
  assert.equal(collectText(h.find('external-agents-cli-status')), '已安装');

  h.find('external-agents-skill-install-claude-code')!.props.onClick!();
  await flush();
  h.render();
  assert.equal(collectText(h.find('external-agents-error')), '正在执行上一步操作，请稍后再试。');
  h.unmount();
});

test('global bridge reference stays memoized across rerenders so read runs once per activation', async () => {
  const host = globalThis as Record<string, unknown>;
  const previous = host.__mioonExternalAgents;
  const fake = createFakeBridge(installedView());
  host.__mioonExternalAgents = fake.bridge;
  try {
    const h = mountExternalAgents({});
    h.render();
    await flush();
    h.render();
    h.render();
    await flush();
    assert.equal(fake.calls.filter(call => call.method === 'read').length, 1);
    h.unmount();
  } finally {
    if (previous === undefined) delete host.__mioonExternalAgents;
    else host.__mioonExternalAgents = previous;
  }
});
