import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory, readPrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {agentSettingsError} from './config.ts';

const MAX_ENVELOPE_BYTES = 64 * 1024;
const safeFailure = (): never => { throw agentSettingsError('AGENT_SETTINGS_CORRUPT'); };
export interface AgentSettingsFile {
  load(): Promise<unknown | null>;
  save(envelope: unknown): Promise<void>;
}

/** Private single-file envelope. The shared Node-only policy owns filesystem
 * verification, bounded reads and atomic publication, including the Windows
 * ACL readiness gate. A codec platform test override cannot bypass that gate.
 * No plaintext credential is accepted by this layer. */
export function createAgentSettingsFile({directory, filename = 'settings.json', privateRoot = directory}: {directory: string; filename?: string; privateRoot?: string}): AgentSettingsFile {
  if (!path.isAbsolute(directory) || !path.isAbsolute(privateRoot) || !/^[a-z0-9-]+\.json$/i.test(filename)) throw safeFailure();
  const root = path.resolve(directory), boundary = path.resolve(privateRoot), file = path.join(root, filename);
  const relative = path.relative(boundary, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw safeFailure();
  return {
    async load() {
      try {
        if (!ensurePrivateDirectory(boundary, {allowMissing: true})) return null;
        if (!validateManagedDirectory(root, {root: boundary, private: true, allowMissing: true})) return null;
        const contents: unknown = readPrivateFile(file, {root, maxBytes: MAX_ENVELOPE_BYTES, allowMissing: true});
        if (contents === null) return null;
        if (!(contents instanceof Uint8Array)) throw safeFailure();
        return JSON.parse(Buffer.from(contents).toString('utf8'));
      } catch { throw safeFailure(); }
    },
    async save(envelope) {
      try {
        const serialized = `${JSON.stringify(envelope)}\n`;
        if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) throw safeFailure();
        ensurePrivateDirectory(boundary, {create: true});
        ensurePrivateDirectory(root, {create: true});
        writePrivateFileAtomic(file, serialized, {root, maxBytes: MAX_ENVELOPE_BYTES});
      } catch { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); }
    },
  };
}
