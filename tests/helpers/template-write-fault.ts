import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';

/** Interrupt only a real media write to the template destination, after the
 * first copied block and while the prepared artifact is still private. */
export function interruptTemplateWrite(parentDir: string, interrupt: () => never): () => void {
  const write = fs.writeSync;
  fs.writeSync = ((fd: number, ...args: unknown[]): number => {
    const count = Reflect.apply(write, fs, [fd, ...args]) as number;
    if (count !== 65_536) return count;
    const file = fs.fstatSync(fd, {bigint: true});
    for (const name of fs.readdirSync(parentDir)) {
      if (!name.startsWith('.project-copy-')) continue;
      const staged = fs.lstatSync(path.join(parentDir, name, 'media', 'scene.png'), {bigint: true, throwIfNoEntry: false});
      if (staged?.dev === file.dev && staged.ino === file.ino && staged.birthtimeNs === file.birthtimeNs) interrupt();
    }
    return count;
  }) as typeof fs.writeSync;
  syncBuiltinESMExports();
  return () => {fs.writeSync = write; syncBuiltinESMExports();};
}
