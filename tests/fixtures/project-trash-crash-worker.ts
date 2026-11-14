import {renameSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../helpers/test-server.ts';
import type {ProjectDeleteInput} from '../../packages/contracts/src/project-lifecycle.ts';

const root = process.argv[2]!;
let input!: ProjectDeleteInput;
const server = await startServer({dataDir: path.join(root, 'app'), projectsDir: path.join(root, 'projects'), port: 0,
  token: 'synthetic-project-trash-crash-token', comfyModule: 'skip', projectTrash: {
    reserve: async () => ({release() {}, trash: async request => {
      renameSync(request.projectFile, path.join(root, 'trashed.mioon'));
      process.send?.({type: 'moved', input});
      await new Promise<void>(() => {});
    }}),
  }});
const entry = await server.projectEntries.create({name: 'Crash trash source'});
input = {requestId: randomUUID(), projectId: entry.projectId, projectFile: entry.projectFile,
  fileIdentity: entry.fileIdentity, expectedRevision: 1, confirmTrash: true};
if (!server.projectEntries.trash) throw Error('synthetic trash capability missing');
await server.projectEntries.trash(input);
