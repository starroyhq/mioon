import path from 'node:path';
import {readPrivateFile} from '@mioon/contracts/private-storage';

export class ConnectionError extends Error {
  constructor(message) { super(message); this.name = 'ConnectionError'; this.code = 'CONNECTION_CONFIG_ERROR'; }
}
const invalid = message => { throw new ConnectionError(message); };

export function validateLocalUrl(base) {
  let url;
  try { url = new URL(base); } catch { invalid('The backend must be a local HTTP origin.'); }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    invalid('The client only connects to a local HTTP backend origin.');
  }
  return url.origin;
}

/** The shared Node-only policy validates parent privacy and the opened inode.
 * Keep storage diagnostics local: connection errors never include a path/token. */
async function privateFile(file) {
  try {
    return await readPrivateFile(file, {maxBytes:8192, encoding:'utf8'});
  } catch (error) {
    if (error?.code === 'STORAGE_PRIVACY_UNAVAILABLE') invalid('Private connection files require verified operating-system access controls, which are unavailable on this platform.');
    invalid('Cannot read connection credentials. Use a small, owner-only (0600) regular file in a private owner-only directory (0700), and check that the backend is running.');
  }
}
function validToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 20 || token.length > 4096 || /[\r\n\0]/.test(token)) invalid('Invalid local backend token.');
  return token;
}

/** Resolve afresh for every request. Descriptor and token rotation need no client restart. */
export async function resolveConnection(env = process.env) {
  // An explicit current-name token is supported; never silently mix token files.
  if (env.MIOON_TOKEN && !env.MIOON_TOKEN_FILE) {
    return {base: validateLocalUrl(env.MIOON_BASE_URL || 'http://127.0.0.1:4318'), token: validToken(env.MIOON_TOKEN)};
  }
  if (env.MIOON_CONNECTION_FILE) {
    if (env.MIOON_BASE_URL || env.MIOON_TOKEN_FILE || env.MIOON_TOKEN) invalid('Do not mix MIOON_BASE_URL or direct credentials with desktop discovery.');
    const descriptorPath = path.resolve(env.MIOON_CONNECTION_FILE);
    let descriptor;
    try { descriptor = JSON.parse(await privateFile(descriptorPath)); } catch (error) {
      if (error instanceof ConnectionError) throw error;
      invalid('Invalid desktop connection descriptor.');
    }
    if (!descriptor || descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || typeof descriptor.tokenFile !== 'string' || !path.isAbsolute(descriptor.tokenFile)) invalid('Invalid desktop connection descriptor.');
    if (path.dirname(path.resolve(descriptor.tokenFile)) !== path.dirname(descriptorPath)) invalid('Desktop token must be beside its connection descriptor.');
    try { process.kill(descriptor.pid, 0); } catch { invalid('Desktop backend is not running; reopen Mioon.'); }
    const token = validToken(await privateFile(descriptor.tokenFile));
    return {base: validateLocalUrl(descriptor.url), token};
  }
  if (env.MIOON_TOKEN_FILE) {
    if (env.MIOON_TOKEN) invalid('Choose MIOON_TOKEN_FILE or MIOON_TOKEN, not both.');
    return {base: validateLocalUrl(env.MIOON_BASE_URL || 'http://127.0.0.1:4318'), token: validToken(await privateFile(path.resolve(env.MIOON_TOKEN_FILE)))};
  }
  invalid('Set MIOON_CONNECTION_FILE for Electron, or MIOON_BASE_URL with MIOON_TOKEN_FILE. MIOON_TOKEN is also supported.');
}

export function connectionSource(env = process.env) {
  if (env.MIOON_TOKEN && !env.MIOON_TOKEN_FILE) return 'environment-token';
  if (env.MIOON_CONNECTION_FILE) return 'desktop-descriptor';
  if (env.MIOON_TOKEN_FILE) return 'private-token-file';
  return 'unconfigured';
}
