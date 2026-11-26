import {
  EXTERNAL_AGENTS_CHANNEL,
  externalAgentsReplySchema,
  externalAgentsRequestSchema,
} from '../../../packages/contracts/src/external-agents.ts';
import type {
  ExternalAgentsBridge,
  ExternalAgentsError,
  ExternalAgentsRequest,
} from '../../../packages/contracts/src/external-agents.ts';

interface Transport {
  invoke(channel: string, request: ExternalAgentsRequest): Promise<unknown>;
}

const unavailable = (): ExternalAgentsError => ({code: 'EXTERNAL_AGENTS_UNAVAILABLE', status: 503});

export function createExternalAgentsBridge(transport: Transport): ExternalAgentsBridge {
  const call = async (input: ExternalAgentsRequest) => {
    const request = externalAgentsRequestSchema.safeParse(input);
    if (!request.success) throw {code: 'EXTERNAL_AGENTS_INVALID', status: 400} satisfies ExternalAgentsError;
    let raw: unknown;
    try {
      raw = await transport.invoke(EXTERNAL_AGENTS_CHANNEL, request.data);
    } catch {
      throw unavailable();
    }
    const reply = externalAgentsReplySchema.safeParse(raw);
    if (!reply.success) throw unavailable();
    if (!reply.data.ok) throw reply.data.error;
    return reply.data.data;
  };

  return Object.freeze<ExternalAgentsBridge>({
    read: () => call({kind: 'read'}),
    installCli: location => call({kind: 'install-cli', location}),
    uninstallCli: () => call({kind: 'uninstall-cli'}),
    repairCli: () => call({kind: 'repair-cli'}),
    installSkill: agent => call({kind: 'install-skill', agent}),
    uninstallSkill: agent => call({kind: 'uninstall-skill', agent}),
    updateSkill: (agent, overwriteModified) => call({kind: 'update-skill', agent, overwriteModified}),
  });
}
