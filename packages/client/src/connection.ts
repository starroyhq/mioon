import path from 'node:path';
import {readPrivateFile} from '@mioon/contracts/private-storage';

export type ConnectionErrorCode = 'CONNECTION_CONFIG_ERROR';
export class ConnectionError extends Error {
  declare code: ConnectionErrorCode;
  constructor(message: string) { super(message); this.name = 'ConnectionError'; this.code = 'CONNECTION_CONFIG_ERROR'; }
}
function invalid(message: string): never { throw new ConnectionError(message); }
export type ConnectionSource = 'environment-token' | 'desktop-descriptor' | 'private-token-file' | 'unconfigured';
export interface LocalConnection {base: string; token: string}
interface DesktopConnectionDescriptor {version: 1; pid: number; tokenFile: string; url: unknown}

export function validateLocalUrl(base: string | URL): string {
  let url: URL;
  try { url = new URL(base); } catch { return invalid('The backend must be a local HTTP origin.'); }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    invalid('The client only connects to a local HTTP backend origin.');
  }
  return url.origin;
}

/** The shared Node-only policy validates parent privacy and the opened inode.
 * Keep storage diagnostics local: connection errors never include a path/token. */
async function privateFile(file: string): Promise<string> {
  try {
    return await readPrivateFile(file, {maxBytes:8192, encoding:'utf8'}) as string;
  } catch (error) {
    if ((error as {code?: unknown} | null | undefined)?.code === 'STORAGE_PRIVACY_UNAVAILABLE') invalid('Private connection files require verified operating-system access controls, which are unavailable on this platform.');
    invalid('Cannot read connection credentials. Use a small, owner-only (0600) regular file in a private owner-only directory (0700), and check that the backend is running.');
  }
}
function validToken(value: unknown): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 20 || token.length > 4096 || /[\r\n\0]/.test(token)) invalid('Invalid local backend token.');
  return token;
}
function connectionDescriptor(value: unknown): DesktopConnectionDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const descriptor = value as Record<string, unknown>;
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || (descriptor.pid as number) < 1 ||
      typeof descriptor.tokenFile !== 'string' || !path.isAbsolute(descriptor.tokenFile)) return null;
  return {version: 1, pid: descriptor.pid as number, tokenFile: descriptor.tokenFile, url: descriptor.url};
}

/** Resolve afresh for every request. Descriptor and token rotation need no client restart. */
export async function resolveConnection(env: NodeJS.ProcessEnv = process.env): Promise<LocalConnection> {
  // An explicit current-name token is supported; never silently mix token files.
  if (env.MIOON_TOKEN && !env.MIOON_TOKEN_FILE) {
    return {base: validateLocalUrl(env.MIOON_BASE_URL || 'http://127.0.0.1:4318'), token: validToken(env.MIOON_TOKEN)};
  }
  if (env.MIOON_CONNECTION_FILE) {
    if (env.MIOON_BASE_URL || env.MIOON_TOKEN_FILE || env.MIOON_TOKEN) invalid('Do not mix MIOON_BASE_URL or direct credentials with desktop discovery.');
    const descriptorPath = path.resolve(env.MIOON_CONNECTION_FILE);
    let rawDescriptor: unknown;
    try { rawDescriptor = JSON.parse(await privateFile(descriptorPath)) as unknown; } catch (error) {
      if (error instanceof ConnectionError) throw error;
      invalid('Invalid desktop connection descriptor.');
    }
    const descriptor = connectionDescriptor(rawDescriptor);
    if (!descriptor) invalid('Invalid desktop connection descriptor.');
    if (path.dirname(path.resolve(descriptor.tokenFile)) !== path.dirname(descriptorPath)) invalid('Desktop token must be beside its connection descriptor.');
    try { process.kill(descriptor.pid, 0); } catch { invalid('Desktop backend is not running; reopen Mioon.'); }
    const token = validToken(await privateFile(descriptor.tokenFile));
    return {base: validateLocalUrl(descriptor.url as string), token};
  }
  if (env.MIOON_TOKEN_FILE) {
    if (env.MIOON_TOKEN) invalid('Choose MIOON_TOKEN_FILE or MIOON_TOKEN, not both.');
    return {base: validateLocalUrl(env.MIOON_BASE_URL || 'http://127.0.0.1:4318'), token: validToken(await privateFile(path.resolve(env.MIOON_TOKEN_FILE)))};
  }
  invalid('Set MIOON_CONNECTION_FILE for Electron, or MIOON_BASE_URL with MIOON_TOKEN_FILE. MIOON_TOKEN is also supported.');
}

export function connectionSource(env: NodeJS.ProcessEnv = process.env): ConnectionSource {
  if (env.MIOON_TOKEN && !env.MIOON_TOKEN_FILE) return 'environment-token';
  if (env.MIOON_CONNECTION_FILE) return 'desktop-descriptor';
  if (env.MIOON_TOKEN_FILE) return 'private-token-file';
  return 'unconfigured';
}
