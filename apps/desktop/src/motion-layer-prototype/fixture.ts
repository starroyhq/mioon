import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const fixture = Object.freeze({width: 1080, height: 1920, fps: 30, frames: 150});

const execute = promisify(execFile);

export async function runTool(name: string, executable: string, args: string[]): Promise<string> {
  try {
    const {stdout} = await execute(executable, args, {encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024});
    return stdout.trim();
  } catch (error) {
    const status = error as {code?: string | number; signal?: string};
    // Diagnostics report the tool and exit status without exposing host paths.
    throw new Error(`${name} failed (${status.signal ?? status.code ?? 'unknown exit status'})`);
  }
}
