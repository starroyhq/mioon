import path from 'node:path';

// Media tools need CLI lookup, the user's home/temp directories and locale, not
// the backend's provider/Agent credentials, proxy settings or loader controls.
// Keep this an explicit allowlist: in particular, do not spread process.env.
const COMMON_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE'];
const WINDOWS_KEYS = ['SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

export function mediaEnvironment(source = process.env, { platform = process.platform } = {}) {
  const result = Object.create(null);
  for (const key of [...COMMON_KEYS, ...(platform === 'win32' ? WINDOWS_KEYS : [])]) {
    // Windows environment names are case-insensitive. Synthetic dictionaries
    // exercise these aliases without enumerating or logging the host's values.
    const aliases = platform === 'win32' ? [...new Set([key, key.toUpperCase(), key.toLowerCase(), key === 'PATH' ? 'Path' : key])] : [key];
    for (const alias of aliases) {
      if (typeof source[alias] === 'string') { result[key] = source[alias]; break; }
    }
  }
  return result;
}

export function mediaConfigurationError() {
  return Object.assign(new Error('Invalid local media runtime configuration.'), { code: 'MEDIA_INVALID_CONFIGURATION' });
}

export function mediaExecutable(command, source = process.env) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw mediaConfigurationError();
  const key = command === 'ffmpeg' ? 'MIOON_FFMPEG_PATH' : command === 'ffprobe' ? 'MIOON_FFPROBE_PATH' : null;
  const configured = key ? source[key] : undefined;
  if (configured !== undefined && configured !== '') {
    if (typeof configured !== 'string' || !path.isAbsolute(configured) || configured.includes('\0')) throw mediaConfigurationError();
    // Do not trim, split or quote a configured path: spaces and Unicode belong
    // to the filename, and shell interpretation is always disabled.
    return configured;
  }
  return command;
}
