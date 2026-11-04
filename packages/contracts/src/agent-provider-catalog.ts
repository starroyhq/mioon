import {z} from 'zod';
import {AGENT_PROTOCOLS} from './agent-protocol.ts';
import type {AgentProtocol} from './agent-protocol.ts';

export type AgentAddressMode = 'fixed' | 'workspace' | 'local' | 'custom';
export interface AgentProviderConfiguration {presetId: string; platformId: string; baseUrl: string; model: string; protocol: AgentProtocol}
export interface AgentPresetSource {label: string; url: string}
export interface AgentProtocolEndpoint {
  baseUrl: string; baseUrlTemplate?: string; blockedReason?: string;
  sources: AgentPresetSource[]; checkedAt: string;
}
export interface AgentPresetProtocols {
  defaultProtocol: AgentProtocol; availableProtocols: AgentProtocol[];
  supportedModelHints?: Partial<Record<AgentProtocol, string[]>>;
  protocolNotes?: Partial<Record<AgentProtocol, string>>;
}
export interface AgentPresetPlatform extends AgentPresetProtocols {
  id: string; label: string; addressMode: AgentAddressMode;
  baseUrl: string; model: string; sources: AgentPresetSource[]; notes?: string; baseUrlTemplate?: string;
  protocols: Partial<Record<AgentProtocol, AgentProtocolEndpoint>>;
}
export interface AgentPresetEntry extends AgentPresetProtocols {
  id: string; label: string; description: string; platforms: AgentPresetPlatform[];
}

const protocols = Object.keys(AGENT_PROTOCOLS) as AgentProtocol[];
const protocolSchema = z.enum(['chat_completions', 'responses', 'anthropic_messages']);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function scalarString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function isAgentModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !controls.test(value) && scalarString(value);
}
export const agentProviderConfigurationSchema = z.object({
  presetId: identifier, platformId: identifier, baseUrl: z.string().min(1).max(2048),
  model: z.string().trim().refine(isAgentModelIdentifier), protocol: protocolSchema,
}).strict();
const sourceSchema = z.object({label: z.string().min(1).max(200), url: z.string().max(2048).url().refine(value => value.startsWith('https://'))}).strict();
const endpointSchema = z.object({
  baseUrl: z.string().max(2048), baseUrlTemplate: z.string().max(2048).optional(),
  blockedReason: z.string().min(1).max(1000).optional(), sources: z.array(sourceSchema).max(8),
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
}).strict();
const endpointMap = z.object({chat_completions: endpointSchema.optional(), responses: endpointSchema.optional(), anthropic_messages: endpointSchema.optional()}).strict();
const hintsSchema = z.object({
  chat_completions: z.array(z.string().max(200)).max(50).optional(),
  responses: z.array(z.string().max(200)).max(50).optional(),
  anthropic_messages: z.array(z.string().max(200)).max(50).optional(),
}).strict();
const protocolNotes = z.object({
  chat_completions: z.string().max(2000).optional(), responses: z.string().max(2000).optional(), anthropic_messages: z.string().max(2000).optional(),
}).strict();
const protocolFields = {
  defaultProtocol: protocolSchema, availableProtocols: z.array(protocolSchema).min(1).max(3),
  supportedModelHints: hintsSchema.optional(), protocolNotes: protocolNotes.optional(),
};
const platformSchema = z.object({
  id: identifier, label: z.string().min(1).max(200), addressMode: z.enum(['fixed', 'workspace', 'local', 'custom']),
  baseUrl: z.string().max(2048), model: z.string().max(200), sources: z.array(sourceSchema).max(8),
  notes: z.string().max(2000).optional(), baseUrlTemplate: z.string().max(2048).optional(), protocols: endpointMap, ...protocolFields,
}).strict().superRefine((value, context) => {
  const allowed = protocols.filter(protocol => value.protocols[protocol] !== undefined && !value.protocols[protocol]?.blockedReason);
  if (JSON.stringify(value.availableProtocols) !== JSON.stringify(allowed) || !allowed.includes(value.defaultProtocol) || value.baseUrl !== value.protocols[value.defaultProtocol]?.baseUrl) {
    context.addIssue({code: 'custom', message: 'Protocol availability must derive from endpoint descriptors'});
  }
  if (value.addressMode === 'workspace' && allowed.some(protocol => !value.protocols[protocol]?.baseUrlTemplate)) {
    context.addIssue({code: 'custom', message: 'Workspace endpoint requires its protocol template'});
  }
});
const entrySchema = z.object({id: identifier, label: z.string().min(1).max(200), description: z.string().max(2000), platforms: z.array(platformSchema).min(1).max(16), ...protocolFields}).strict().superRefine((value, context) => {
  const allowed = protocols.filter(protocol => value.platforms.some(platform => platform.availableProtocols.includes(protocol)));
  if (new Set(value.platforms.map(platform => platform.id)).size !== value.platforms.length ||
      JSON.stringify(value.availableProtocols) !== JSON.stringify(allowed) || !allowed.includes(value.defaultProtocol)) {
    context.addIssue({code: 'custom', message: 'Invalid provider protocol catalog'});
  }
});
export const agentProviderCatalogSchema = z.array(entrySchema).min(1).max(32).refine(value => new Set(value.map(entry => entry.id)).size === value.length);

export function agentPresetPlatform(catalog: readonly AgentPresetEntry[], presetId: string, platformId: string): AgentPresetPlatform | undefined {
  return catalog.find(entry => entry.id === presetId)?.platforms.find(platform => platform.id === platformId);
}
export function agentPresetProtocolEndpoint(catalog: readonly AgentPresetEntry[], presetId: string, platformId: string, protocol: AgentProtocol): AgentProtocolEndpoint | undefined {
  return agentPresetPlatform(catalog, presetId, platformId)?.protocols[protocol];
}
function invalid(): never {throw new TypeError('Invalid agent provider endpoint');}
/** Syntax and exact catalog constraints only. The host still applies its DNS,
 * address policy, peer and self-port checks before any network operation. */
function normalizeBase(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\%?#@]/u.test(value) || controls.test(value) || !scalarString(value) || !/^https?:\/\//iu.test(value)) invalid();
  const rawPath = value.replace(/^https?:\/\/[^/]+/iu, '');
  if (rawPath && (!/^\/[A-Za-z0-9/_~.\-]*$/u.test(rawPath) || /\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath))) invalid();
  let url: URL; try {url = new URL(value);} catch {return invalid();}
  if (url.username || url.password || url.search || url.hash || url.port && Number(url.port) === 0) invalid();
  return url.origin + url.pathname.replace(/\/+$/u, '');
}
function endpoint(catalog: readonly AgentPresetEntry[], presetId: string, platformId: string, protocol: AgentProtocol): {platform: AgentPresetPlatform; endpoint: AgentProtocolEndpoint} {
  const platform = agentPresetPlatform(catalog, presetId, platformId), selected = platform?.protocols[protocol];
  if (!platform || !selected || selected.blockedReason || !platform.availableProtocols.includes(protocol)) invalid();
  return {platform, endpoint: selected};
}
function workspaceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(value)) invalid();
  return value.toLowerCase();
}
function localOrigin(value: unknown): string {
  const normalized = normalizeBase(value), url = new URL(normalized);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || normalized !== url.origin) invalid();
  return url.origin;
}
export function resolveAgentPresetBaseUrl(catalog: readonly AgentPresetEntry[], presetId: string, platformId: string, protocol: AgentProtocol, addressInput?: string): string {
  const selected = endpoint(catalog, presetId, platformId, protocol);
  if (selected.platform.addressMode === 'fixed') {
    if (addressInput !== undefined) invalid();
    return normalizeBase(selected.endpoint.baseUrl);
  }
  if (selected.platform.addressMode === 'workspace') {
    const template = selected.endpoint.baseUrlTemplate;
    if (!template || template.split('{WorkspaceId}').length !== 2 || !template.startsWith('https://{WorkspaceId}.')) invalid();
    return normalizeBase(template.replace('{WorkspaceId}', workspaceId(addressInput)));
  }
  if (selected.platform.addressMode === 'local') {
    const origin = localOrigin(addressInput ?? new URL(selected.endpoint.baseUrl).origin);
    return origin + (protocol === 'anthropic_messages' ? '' : '/v1');
  }
  if (typeof addressInput !== 'string') invalid();
  const base = normalizeBase(addressInput); if (!base.startsWith('https://')) invalid(); return base;
}
function configurationAddressInput(catalog: readonly AgentPresetEntry[], configuration: AgentProviderConfiguration): string | undefined {
  const selected = endpoint(catalog, configuration.presetId, configuration.platformId, configuration.protocol), base = normalizeBase(configuration.baseUrl);
  if (selected.platform.addressMode === 'fixed') return undefined;
  if (selected.platform.addressMode === 'custom') return base;
  if (selected.platform.addressMode === 'local') return new URL(base).origin;
  const template = selected.endpoint.baseUrlTemplate;
  if (!template) invalid();
  const [prefix, suffix, extra] = template.split('{WorkspaceId}');
  if (prefix !== 'https://' || !suffix?.startsWith('.') || extra !== undefined || !base.startsWith(prefix) || !base.endsWith(suffix)) invalid();
  return workspaceId(base.slice(prefix.length, base.length - suffix.length));
}
export function validateAgentProviderEndpoint(catalog: readonly AgentPresetEntry[], configuration: AgentProviderConfiguration): void {
  const input = configurationAddressInput(catalog, configuration);
  if (normalizeBase(configuration.baseUrl) !== resolveAgentPresetBaseUrl(catalog, configuration.presetId, configuration.platformId, configuration.protocol, input)) invalid();
}
/** The serviceKey is a separate owner boundary in settings. This identifies
 * only the credential recipient inside that one stable service entry. */
export function agentCredentialReceiverBinding(catalog: readonly AgentPresetEntry[], configuration: AgentProviderConfiguration): string {
  validateAgentProviderEndpoint(catalog, configuration);
  const selected = endpoint(catalog, configuration.presetId, configuration.platformId, configuration.protocol), input = configurationAddressInput(catalog, configuration);
  return JSON.stringify([selected.platform.addressMode, configuration.presetId, configuration.platformId,
    ...(selected.platform.addressMode === 'fixed' ? [] : [input])]);
}
