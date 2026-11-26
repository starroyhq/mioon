import {externalAgentsRequestSchema} from '../../../packages/contracts/src/external-agents.ts';
import type {
  ExternalAgent, ExternalAgentsError, ExternalAgentsReply, ExternalAgentsView,
} from '../../../packages/contracts/src/external-agents.ts';
import type {createCliInstaller, CliInstallStatus} from './cli-install.ts';
import type {createExternalAgentSkills} from './external-agent-skills.ts';

const agents: readonly ExternalAgent[] = ['claude-code', 'codex'];
const refuse = (code: ExternalAgentsError['code'], status: ExternalAgentsError['status']): ExternalAgentsReply =>
  ({ok: false, error: {code, status}});

interface ExternalAgentsDocument {
  isCurrent(): boolean;
  canMutate(): boolean;
  chooseDirectory(): Promise<string | null>;
}

interface ExternalAgentsHostOptions {
  cli: ReturnType<typeof createCliInstaller>;
  skills: ReturnType<typeof createExternalAgentSkills>;
  repairOnStartup: boolean;
}

export function createExternalAgentsHost({cli, skills, repairOnStartup}: ExternalAgentsHostOptions) {
  let busy = false;
  const installedCommand = (status: CliInstallStatus) => status.cli.state === 'installed' ? status.cli.commandPath : undefined;

  async function refreshManagedSkills(status: CliInstallStatus): Promise<void> {
    const command = installedCommand(status);
    if (!command) return;
    for (const agent of agents) {
      try {await skills.autoUpdate(agent, command);}
      catch { /* A skill directory that cannot be updated must not block CLI installation or the other skill. */ }
    }
  }

  const ready = repairOnStartup ? cli.autoRepair().then(refreshManagedSkills).catch(() => {}) : Promise.resolve();

  async function view(status: CliInstallStatus): Promise<ExternalAgentsView> {
    const {commandName, appVersion, cli, mcpCommands} = status;
    const command = installedCommand(status);
    return {commandName, appVersion, cli, mcpCommands, skills: await Promise.all(agents.map(agent => skills.read(agent, command)))};
  }

  async function dispatch(owner: ExternalAgentsDocument | null, input: unknown): Promise<ExternalAgentsReply> {
    if (!owner?.isCurrent()) return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
    const parsed = externalAgentsRequestSchema.safeParse(input);
    if (!parsed.success) return refuse('EXTERNAL_AGENTS_INVALID', 400);
    const request = parsed.data;
    const mutates = request.kind !== 'read';
    const canContinue = () => owner.isCurrent() && (!mutates || owner.canMutate());
    if (!canContinue()) return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
    if (busy) return refuse('EXTERNAL_AGENTS_BUSY', 409);
    if (mutates) busy = true;
    try {
      await ready;
      if (!canContinue()) return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
      let status: CliInstallStatus;
      switch (request.kind) {
        case 'read':
          status = await cli.status();
          break;
        case 'install-cli':
          if (request.location === 'choose') {
            const directory = await owner.chooseDirectory();
            if (!canContinue()) return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
            status = directory === null ? await cli.status() : await cli.installSelectedDirectory(directory);
            if (directory !== null) await refreshManagedSkills(status);
          } else {
            status = await cli.install();
            await refreshManagedSkills(status);
          }
          break;
        case 'repair-cli':
          status = await cli.repair();
          await refreshManagedSkills(status);
          break;
        case 'uninstall-cli':
          status = await cli.uninstall();
          break;
        case 'uninstall-skill':
          await skills.uninstall(request.agent);
          status = await cli.status();
          break;
        case 'install-skill':
        case 'update-skill': {
          status = await cli.status();
          if (!canContinue()) return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
          const command = installedCommand(status);
          if (!command) return refuse('CLI_REQUIRED', 409);
          if (request.kind === 'install-skill') await skills.install(request.agent, command);
          else if (await skills.update(request.agent, command, request.overwriteModified) === 'modified') {
            return refuse('SKILL_MODIFIED', 409);
          }
        }
      }
      const data = await view(status);
      return owner.isCurrent() ? {ok: true, data} : refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
    } catch {
      return refuse('EXTERNAL_AGENTS_UNAVAILABLE', 503);
    } finally {
      if (mutates) busy = false;
    }
  }

  return {dispatch};
}
