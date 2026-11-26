/** The v1 wire format for the desktop CLI runtime host. */
export const cliRuntimeProtocol = 1;
const helloMagic = Buffer.from('MIOONCLI\0', 'ascii');
export const helloHeaderLength = helloMagic.length + 6;
export const cliRuntimeMaxPayload = 1_048_576;
export const cliRuntimeFrameHeaderLength = 5;
const invalidString = /[\0\uD800-\uDFFF]/u;

export const cliRuntimeFrames = Object.freeze({
  stdin: 1, stdinEof: 2, stdout: 3, stderr: 4, cancel: 5, exit: 6, ready: 7, error: 8,
} as const);
export type CliRuntimeChannel = 'development' | 'production';
export type CliRuntimeRole = 'cli' | 'mcp';
export type CliRuntimeErrorCode = 'CLI_PROTOCOL_ERROR' | 'CLI_AUTH_FAILED' | 'CLI_VERSION_MISMATCH'
  | 'SESSION_LIMIT' | 'CLI_RUNTIME_UNAVAILABLE';

export interface CliRuntimeHello {
  readonly protocol: number;
  readonly channel: CliRuntimeChannel;
  readonly launcherVersion: string;
  readonly appVersion: string;
  readonly token: string;
  readonly role: CliRuntimeRole;
  readonly argv: string[];
  readonly cwd?: string;
}

export function readHelloHeader(bytes: Buffer): {protocol: number; length: number} | null {
  if (!bytes.subarray(0, helloMagic.length).equals(helloMagic)) return null;
  const length = bytes.readUInt32BE(helloMagic.length + 2);
  if (length < 1 || length > cliRuntimeMaxPayload) return null;
  return {protocol: bytes.readUInt16BE(helloMagic.length), length};
}

export function isCliRuntimeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value);
}

export function readHello(bytes: Buffer): CliRuntimeHello | null {
  let value: unknown;
  // ignoreBOM keeps a leading BOM in the decoded string so JSON.parse rejects it.
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)); }
  catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['protocol', 'channel', 'launcherVersion', 'appVersion', 'token', 'role', 'argv'];
  const hasCwd = Object.hasOwn(value, 'cwd');
  if (Object.keys(value).length !== fields.length + Number(hasCwd)
    || fields.some(field => !Object.hasOwn(value, field))) return null;
  const hello = value as Record<string, unknown>;
  if (typeof hello.protocol !== 'number' || !Number.isInteger(hello.protocol) || hello.protocol < 0 || hello.protocol > 65535
    || (hello.channel !== 'development' && hello.channel !== 'production')
    || !isCliRuntimeVersion(hello.appVersion) || !isCliRuntimeVersion(hello.launcherVersion)
    || typeof hello.token !== 'string' || (hello.role !== 'cli' && hello.role !== 'mcp')
    || !Array.isArray(hello.argv) || hello.argv.length > 256
    || hello.argv.some(arg => typeof arg !== 'string' || invalidString.test(arg))
    || (hasCwd && (typeof hello.cwd !== 'string' || Buffer.byteLength(hello.cwd) > 4096
      || invalidString.test(hello.cwd)))) return null;
  return {protocol: hello.protocol, channel: hello.channel, launcherVersion: hello.launcherVersion, appVersion: hello.appVersion,
    token: hello.token, role: hello.role, argv: hello.argv, ...(typeof hello.cwd === 'string' ? {cwd: hello.cwd} : {})};
}

export function cliRuntimeFrame(type: number, data: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(cliRuntimeFrameHeaderLength + data.byteLength);
  frame[0] = type;
  frame.writeUInt32BE(data.byteLength, 1);
  frame.set(data, cliRuntimeFrameHeaderLength);
  return frame;
}

export function cliRuntimeJsonFrame(type: number, value: object): Buffer {
  return cliRuntimeFrame(type, Buffer.from(JSON.stringify(value)));
}
