import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_NOTICES = Object.freeze([
  {source: 'LICENSE', output: 'Mioon-LICENSE.txt'},
  {source: 'NOTICE', output: 'Mioon-NOTICE.txt'},
  {source: 'THIRD_PARTY_NOTICES.md', output: 'Mioon-THIRD-PARTY-NOTICES.md'},
]);

export async function stageProjectNotices(root: string, destination: string): Promise<void> {
  // Read the complete required set first: a missing/empty project declaration
  // must fail the build rather than produce a package with partial notices.
  const files = await Promise.all(PROJECT_NOTICES.map(async file => {
    const bytes = await readFile(path.join(root, file.source));
    if (!bytes.length) throw new Error(`Project notice is empty: ${file.source}`);
    return {...file, bytes};
  }));
  await mkdir(destination, {recursive: true});
  for (const file of files) await writeFile(path.join(destination, file.output), file.bytes, {flag: 'wx'});
}
