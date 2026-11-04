import {lstatSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {projectCopyActionIntentSchema} from '../../../../packages/contracts/src/project-copy-action-records.ts';
import type {ProjectCopyActionIntent} from '../../../../packages/contracts/src/project-copy-action-records.ts';
import {isProjectCopyActionOperation} from '../../../../packages/contracts/src/project-copies.ts';
import type {ProjectCopyActionOperation} from '../../../../packages/contracts/src/project-copies.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../../../packages/contracts/src/private-storage.ts';
import {syncCopiedDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {copyFailure} from './copy-records.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';

export type ActionIntent = ProjectCopyActionIntent;
export function createCopyActionRecords(dataDir: string, assertAllowed: () => void) {
  const root = path.join(dataDir, 'project-copy-actions'), limit = 2 * 1024 * 1024;
  const file = (operation: ProjectCopyActionOperation, requestId: string) => path.join(root, `${operation}-${requestId}.json`);
  const work = (operation: ProjectCopyActionOperation, requestId: string) => path.join(root, `${operation}-${requestId}`);
  const read = (operation: ProjectCopyActionOperation, requestId: string): ActionIntent | null => {
    const name = file(operation, requestId);
    if (!lstatSync(name, {throwIfNoEntry: false})) return null;
    try {
      const bytes = readPrivateFile(name, {root, maxBytes: limit});
      if (!bytes) throw Error('missing action');
      const intent = projectCopyActionIntentSchema.parse(JSON.parse(bytes.toString('utf8')));
      const parent = intent.operation === 'project.template.instantiate' ? intent.input.parentDir : path.dirname(intent.targetFile);
      if (intent.operation !== operation || intent.input.requestId !== requestId
        || intent.digest !== createHash('sha256').update(canonicalJson({operation: intent.operation, input: intent.input})).digest('hex')
        || intent.stageDirectory && (path.dirname(intent.stageDirectory) !== parent || !path.basename(intent.stageDirectory).startsWith('.project-copy-'))
        || intent.operation === 'project.template.instantiate' && (intent.targetDirectory !== path.join(intent.input.parentDir, intent.input.name)
          || intent.targetFile !== path.join(intent.targetDirectory!, intent.input.name + '.mioon'))
        || intent.operation !== 'project.template.instantiate' && intent.targetDirectory !== null) throw Error('action path binding');
      return intent;
    } catch (cause) {
      const error = copyFailure('PROJECT_COPY_INTENT_INVALID', '项目复制恢复记录无效，未更改源或目标。'); error.cause = cause; throw error;
    }
  };
  return {root, work, read,
    write(intent: ActionIntent): void {
      assertAllowed();
      const parsed = projectCopyActionIntentSchema.parse(intent);
      ensurePrivateDirectory(root, {create: true});
      writePrivateFileAtomic(file(parsed.operation, parsed.input.requestId), JSON.stringify(parsed), {root, maxBytes: limit});
      syncCopiedDirectory(root);
    },
    list(): ActionIntent[] {
      if (!lstatSync(root, {throwIfNoEntry: false})) return [];
      ensurePrivateDirectory(root);
      return readdirSync(root).filter(name => name.endsWith('.json')).flatMap(name => {
        const match = /^(project\.(?:adopt-copy|copy-to|template\.instantiate))-([a-f0-9-]{36})\.json$/u.exec(name);
        return match && isProjectCopyActionOperation(match[1]) ? [read(match[1], match[2])!] : [];
      });
    },
  };
}
