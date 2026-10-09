import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rename, unlink} from 'node:fs/promises';
import {agentSettingsError} from './config.mjs';

const MAX_ENVELOPE_BYTES = 64 * 1024;
const safeFailure = () => agentSettingsError('AGENT_SETTINGS_CORRUPT');
const owned = stat => process.platform === 'win32' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
/** Private single-file envelope. A rename is the commit point; no failure is
 * reported after that point. No plaintext credential is accepted by this layer. */
export function createAgentSettingsFile({directory, filename = 'settings.json'}) {
  if (!path.isAbsolute(directory) || !/^[a-z0-9-]+\.json$/i.test(filename)) throw safeFailure();
  const root = path.resolve(directory), file = path.join(root, filename);
  async function checkParents() {
    // Do not traverse a symbolic-link parent even when the final file is safe.
    let current = path.parse(root).root;
    const parts = root.slice(current.length).split(path.sep).filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw safeFailure();
    }
  }
  async function checkDirectory({create = false} = {}) {
    await checkParents();
    try { if (create) await mkdir(root, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !owned(metadata)) throw safeFailure();
  }
  async function checkFile() {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || !owned(metadata) || metadata.size > MAX_ENVELOPE_BYTES) throw safeFailure();
    return metadata;
  }
  return {
    async load() {
      let handle;
      try {
        try { await checkDirectory(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        let metadata;
        try { metadata = await checkFile(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || !owned(opened) || opened.nlink !== 1 || opened.ino !== metadata.ino || opened.dev !== metadata.dev || opened.size > MAX_ENVELOPE_BYTES) throw safeFailure();
        // Bounded read protects against a concurrently growing same-user file.
        const bytes = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const {bytesRead} = await handle.read(bytes, size, bytes.length - size, size);
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_ENVELOPE_BYTES) throw safeFailure();
        return JSON.parse(bytes.subarray(0, size).toString('utf8'));
      } catch { throw safeFailure(); }
      finally { await handle?.close().catch(() => {}); }
    },
    async save(envelope) {
      let handle, temporary, committed = false;
      try {
        const serialized = JSON.stringify(envelope) + '\n';
        if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) throw safeFailure();
        await checkDirectory({create: true});
        try { await checkFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        temporary = path.join(root, `.settings-${randomBytes(16).toString('hex')}.tmp`);
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
        await handle.close(); handle = undefined;
        await checkDirectory();
        try { await checkFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(temporary, file);
        committed = true;
        // Best-effort directory durability. The committed file is already visible;
        // an unsupported directory fsync must not report a misleading failed save.
        let directoryHandle;
        try { directoryHandle = await open(root, constants.O_RDONLY); await directoryHandle.sync(); }
        catch {} finally { await directoryHandle?.close().catch(() => {}); }
      } catch { throw agentSettingsError('AGENT_SETTINGS_SAVE_FAILED'); }
      finally {
        await handle?.close().catch(() => {});
        if (temporary && !committed) await unlink(temporary).catch(() => {});
      }
    },
  };
}
