import {AGENT_PRESETS} from '../../packages/business/src/agent/presets.ts';
import type {AgentConfiguration} from '../../packages/business/src/agent/config.ts';
import {resolveAgentPresetBaseUrl} from '../../packages/contracts/src/agent-provider-catalog.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';

/** Exercise each runnable platform/protocol, including all six workspace templates. */
export function presetConfigurations(): AgentConfiguration[] {
  return AGENT_PRESETS.flatMap(preset => preset.platforms.flatMap(platform => platform.availableProtocols.map(protocol => {
    const input = platform.addressMode === 'workspace' ? 'synthetic-workspace' : platform.addressMode === 'local' ? 'http://127.0.0.1:11434' : platform.addressMode === 'custom' ? 'https://gateway.example.com/team/v1' : undefined;
    return {presetId: preset.id, platformId: platform.id, protocol,
      model: (protocol === 'responses' ? platform.supportedModelHints?.responses?.[0] : undefined) || platform.model || 'synthetic-mio',
      baseUrl: resolveAgentPresetBaseUrl(AGENT_PRESETS, preset.id, platform.id, protocol, input)};
  })));
}

export function defaultTestAgentConfiguration(protocol:AgentProtocol):AgentConfiguration {
  const configuration=presetConfigurations().find(value=>value.presetId===(protocol==='anthropic_messages'?'ollama':'openai')&&value.protocol===protocol);
  if(!configuration)throw new Error('Missing explicit fixture connection');
  // This is a protocol-specific business fixture, not the application default:
  // Terra needs Responses for tools; Luna supports CC tools with effort none.
  return protocol==='chat_completions'?{...configuration,model:'gpt-6-luna'}:configuration;
}
