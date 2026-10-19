import {isIP} from 'node:net';
import {AGENT_PROTOCOLS} from '@mioon/contracts';
import type {AgentProtocol} from '../../../contracts/src/agent-protocol.ts';
import {AGENT_PRESETS} from './presets.ts';

export const MAX_AGENT_SETTINGS_BYTES = 16 * 1024;
export const MAX_AGENT_SECRET_BYTES = 8192;
const messages = {
  AGENT_SETTINGS_VALIDATION: [400, 'Agent 设置格式无效，请检查地址、模型和密钥输入。'],
  AGENT_SETTINGS_CONFLICT: [409, 'Agent 设置已被另一个窗口更新，请重新读取后确认。'],
  AGENT_SETTINGS_STORAGE_UNAVAILABLE: [409, '系统安全存储不可用，请明确选择仅本次会话保存。'],
  AGENT_SETTINGS_SAVE_FAILED: [503, 'Agent 设置未能保存；请重新读取当前设置后再试。'],
  AGENT_SETTINGS_CORRUPT: [503, 'Agent 设置文件不可读取或不安全；为保护现有设置，已停止保存。'],
  AGENT_SETTINGS_CLOSED: [503, 'Agent 设置服务已关闭，请重新打开应用。'],
} as const;
export type AgentSettingsErrorCode = keyof typeof messages;
export type AgentSettingsFailure = Error & {code: AgentSettingsErrorCode; status: number};
const errorCode = (error: unknown): string | undefined => error !== null && typeof error === 'object' && 'code' in error && typeof (error as {code?: unknown}).code === 'string' ? (error as {code: string}).code : undefined;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
export function agentSettingsError(code: string = 'AGENT_SETTINGS_VALIDATION'): AgentSettingsFailure {
  const known = typeof code === 'string' && Object.hasOwn(messages, code);
  const resolved = (known ? code : 'AGENT_SETTINGS_SAVE_FAILED') as AgentSettingsErrorCode;
  return Object.assign(new Error(messages[resolved][1]), {code: resolved, status: messages[resolved][0]});
}
export function safeAgentSettingsError(error: unknown): {code: AgentSettingsErrorCode; message: string; status: number} {
  const safe = agentSettingsError(errorCode(error) || 'AGENT_SETTINGS_SAVE_FAILED');
  return {code: safe.code, message: safe.message, status: safe.status};
}
export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function invalid(): never { throw agentSettingsError(); }
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function privateV4(host: string): boolean {
  const [a, b, c] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
}
function remoteHostAllowed(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  const type = isIP(bare);
  if (type === 4) return !privateV4(bare);
  // Only global unicast, excluding documentation/tunneling ranges. This also
  // rejects mapped IPv4, loopback, unique-local, link-local and unspecified IPv6.
  if (type === 6) {
    const [first, second = ''] = bare.split(':');
    const secondWord = parseInt(second || '0', 16);
    return /^[23][0-9a-f]{3}:/i.test(bare) && !(first === '2001' && (secondWord < 0x200 || secondWord === 0xdb8)) && first !== '2002' && first !== '3fff';
  }
  if (!host.includes('.') || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/i.test(host)) return false;
  return host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) && !/^\d+$/.test(host.split('.').at(-1) as string);
}
/** Syntax-only gate. NO DNS/network is performed here. Future model gateway must
 * resolve, validate and pin the actual destination, and reject redirects. */
export function normalizeAgentBaseUrl(value: unknown, {local = false, selfPort}: {local?: boolean; selfPort?: number} = {}): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\%?#@]/u.test(value) || controls.test(value)) invalid();
  if (!/^https?:\/\//i.test(value)) invalid();
  // Reject dot-segment normalization rather than silently changing a destination.
  const rawPath = value.replace(/^https?:\/\/[^/]+/i, '');
  if (rawPath && (!/^\/[A-Za-z0-9/_~.\-]*$/.test(rawPath) || /\/{2}|(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath))) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.username || url.password || url.search || url.hash || (url.port && Number(url.port) === 0)) invalid();
  const pathname = url.pathname.replace(/\/+$/, '');
  if (local) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || pathname !== '/v1') invalid();
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (port === selfPort) invalid();
  } else if (url.protocol !== 'https:' || !remoteHostAllowed(url.hostname)) invalid();
  return `${url.origin}${pathname}`;
}
export interface AgentConfiguration {presetId: string; platformId: string; baseUrl: string; model: string; protocol: AgentProtocol}
export function parseAgentConfiguration(value: unknown, options: {selfPort?: number} = {}): AgentConfiguration {
  if (!exactObject(value, ['presetId', 'platformId', 'baseUrl', 'model', 'protocol'])) invalid();
  const preset = AGENT_PRESETS.find(item => item.id === value.presetId);
  const platform = preset?.platforms.find(item => item.id === value.platformId);
  if (!platform || typeof value.protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, value.protocol) ||
    !(platform.availableProtocols as readonly string[]).includes(value.protocol)) invalid();
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || controls.test(value.model)) invalid();
  return {presetId: value.presetId as string, platformId: value.platformId as string, baseUrl: normalizeAgentBaseUrl(value.baseUrl, {local: value.presetId === 'ollama', selfPort: options.selfPort}), model: value.model.trim(), protocol: value.protocol as AgentProtocol};
}
// Credential identity deliberately excludes model and protocol; authorization
// checks still compare the full configuration and its revision before delivery.
export const agentCredentialBinding = (configuration: AgentConfiguration): string => JSON.stringify([configuration.presetId, configuration.platformId, configuration.baseUrl]);
export type AgentSettingsSecret = {action: 'keep' | 'remove'} | {action: 'replace'; value: string; storage: 'session' | 'persistent'};
export interface AgentSettingsUpdate {expectedRevision: number; configuration: AgentConfiguration; secret: AgentSettingsSecret}
export function parseAgentSettingsUpdate(value: unknown, options: {selfPort?: number} = {}): AgentSettingsUpdate {
  if (!exactObject(value, ['expectedRevision', 'configuration', 'secret']) || !integer(value.expectedRevision) || value.expectedRevision < 0) invalid();
  const configuration = parseAgentConfiguration(value.configuration, options);
  let secret: AgentSettingsSecret;
  if (exactObject(value.secret, ['action']) && ['keep', 'remove'].includes(value.secret.action as string)) secret = {action: value.secret.action as 'keep' | 'remove'};
  else if (exactObject(value.secret, ['action', 'value', 'storage']) && value.secret.action === 'replace' && ['session', 'persistent'].includes(value.secret.storage as string)) {
    if (typeof value.secret.value !== 'string' || !value.secret.value.trim() || Buffer.byteLength(value.secret.value, 'utf8') > MAX_AGENT_SECRET_BYTES || controls.test(value.secret.value)) invalid();
    secret = {action: 'replace', value: value.secret.value, storage: value.secret.storage as 'session' | 'persistent'};
  } else invalid();
  // Guard direct trusted callers too; HTTP has an independent streaming limit.
  if (Buffer.byteLength(JSON.stringify({expectedRevision: value.expectedRevision, configuration, secret}), 'utf8') > MAX_AGENT_SETTINGS_BYTES) invalid();
  return {expectedRevision: value.expectedRevision, configuration, secret};
}
