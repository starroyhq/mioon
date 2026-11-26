import {
  externalAgentsErrorCodeSchema,
  externalAgentsReplySchema,
  externalAgentsViewSchema,
} from '../../../packages/contracts/src/external-agents.ts';
import type {
  ExternalAgent,
  ExternalAgentsBridge,
  ExternalAgentsErrorCode,
  ExternalAgentsView,
  SkillState,
} from '../../../packages/contracts/src/external-agents.ts';
import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';

const BRIDGE_METHODS = [
  'read',
  'installCli',
  'uninstallCli',
  'repairCli',
  'installSkill',
  'uninstallSkill',
  'updateSkill',
] as const;

const AGENT_ORDER: readonly ExternalAgent[] = ['claude-code', 'codex'];

export class ExternalAgentsClientError extends Error {
  readonly code: ExternalAgentsErrorCode;
  readonly status: 400 | 409 | 503;

  constructor(code: ExternalAgentsErrorCode, status: 400 | 409 | 503) {
    super(code);
    this.name = 'ExternalAgentsClientError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExternalAgentsBridge(host: unknown = globalThis): boolean {
  if (!isRecord(host) || !Object.hasOwn(host, '__mioonExternalAgents')) return false;
  const candidate = host.__mioonExternalAgents;
  if (!isRecord(candidate)) return false;
  return BRIDGE_METHODS.every(method => typeof candidate[method] === 'function');
}

function unwrapView(value: unknown): ExternalAgentsView {
  const reply = externalAgentsReplySchema.safeParse(value);
  if (reply.success) {
    if (reply.data.ok) return reply.data.data;
    throw new ExternalAgentsClientError(reply.data.error.code, reply.data.error.status);
  }
  const view = externalAgentsViewSchema.safeParse(value);
  if (view.success) return view.data;
  throw new ExternalAgentsClientError('EXTERNAL_AGENTS_INVALID', 400);
}

export function readExternalAgentsBridge(host: unknown = globalThis): ExternalAgentsBridge | null {
  if (!hasExternalAgentsBridge(host)) return null;
  const raw = (host as Record<'__mioonExternalAgents', Record<string, (...args: unknown[]) => Promise<unknown>>>).__mioonExternalAgents;
  return Object.freeze({
    read: async () => unwrapView(await raw.read()),
    installCli: async (location: 'default' | 'choose') => unwrapView(await raw.installCli(location)),
    uninstallCli: async () => unwrapView(await raw.uninstallCli()),
    repairCli: async () => unwrapView(await raw.repairCli()),
    installSkill: async (agent: ExternalAgent) => unwrapView(await raw.installSkill(agent)),
    uninstallSkill: async (agent: ExternalAgent) => unwrapView(await raw.uninstallSkill(agent)),
    updateSkill: async (agent: ExternalAgent, overwriteModified: boolean) => unwrapView(await raw.updateSkill(agent, overwriteModified)),
  });
}

export function readExternalAgentsErrorCode(error: unknown): ExternalAgentsErrorCode | null {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const candidate = (error as { readonly code?: unknown }).code;
  const parsed = externalAgentsErrorCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parentDirectory(displayPath: string): string {
  const trimmed = displayPath.replace(/[\\/]+$/u, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : displayPath;
}

export function externalAgentsReasonMessage(view: ExternalAgentsView): DisplayMessage | null {
  const { cli } = view;
  switch (cli.reason) {
    case 'CLI_FILE_MISSING':
      return message('externalAgents.reason.CLI_FILE_MISSING', { displayPath: cli.displayPath });
    case 'CLI_TARGET_MISSING':
      return message('externalAgents.reason.CLI_TARGET_MISSING');
    case 'CLI_VERSION_MISMATCH':
      return message('externalAgents.reason.CLI_VERSION_MISMATCH', {
        installedVersion: cli.reasonValues?.installedVersion ?? cli.version ?? '—',
        appVersion: view.appVersion,
      });
    case 'CLI_AUTO_UPDATE_FAILED':
      return message('externalAgents.reason.CLI_AUTO_UPDATE_FAILED');
    case 'CLI_INSTALL_TARGET_EXISTS':
      return message('externalAgents.reason.CLI_INSTALL_TARGET_EXISTS', {
        directory: cli.reasonValues?.directory ?? parentDirectory(cli.displayPath),
        commandName: view.commandName,
      });
    case 'CLI_INSTALL_NOT_WRITABLE':
      return message('externalAgents.reason.CLI_INSTALL_NOT_WRITABLE', {
        directory: cli.reasonValues?.directory ?? parentDirectory(cli.displayPath),
      });
    case 'CLI_INSTALL_FAILED':
      return message('externalAgents.reason.CLI_INSTALL_FAILED');
    default:
      return null;
  }
}

export function externalAgentsErrorMessage(error: unknown): DisplayMessage {
  const code = readExternalAgentsErrorCode(error);
  switch (code) {
    case 'EXTERNAL_AGENTS_UNAVAILABLE':
      return message('externalAgents.error.EXTERNAL_AGENTS_UNAVAILABLE');
    case 'EXTERNAL_AGENTS_BUSY':
      return message('externalAgents.error.EXTERNAL_AGENTS_BUSY');
    case 'CLI_REQUIRED':
      return message('externalAgents.error.CLI_REQUIRED');
    case 'EXTERNAL_AGENTS_INVALID':
      return message('externalAgents.error.EXTERNAL_AGENTS_INVALID');
    default:
      return message('externalAgents.error.unknown');
  }
}

export function externalAgentSkillBadge(state: SkillState): {
  readonly tone: 'neutral' | 'success' | 'warning';
  readonly key: 'externalAgents.status.notInstalled' | 'externalAgents.status.installed' | 'externalAgents.status.updateAvailable';
} {
  if (state === 'installed') return { tone: 'success', key: 'externalAgents.status.installed' };
  if (state === 'update-available' || state === 'modified') return { tone: 'warning', key: 'externalAgents.status.updateAvailable' };
  return { tone: 'neutral', key: 'externalAgents.status.notInstalled' };
}

export function orderedExternalAgentSkills(view: ExternalAgentsView): ExternalAgentsView['skills'] {
  const byAgent = new Map(view.skills.map(skill => [skill.agent, skill] as const));
  const ordered = AGENT_ORDER.flatMap(agent => {
    const entry = byAgent.get(agent);
    return entry ? [entry] : [];
  });
  for (const skill of view.skills) {
    if (!AGENT_ORDER.includes(skill.agent)) ordered.push(skill);
  }
  return ordered;
}
