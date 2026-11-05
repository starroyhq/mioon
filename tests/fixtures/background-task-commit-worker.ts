import path from 'node:path';
import {openProjectStore} from '../../packages/business/src/project-file/store.ts';
import {subscribeBackgroundTaskChanges} from '../../packages/business/src/background-task-events.ts';

const [root, taskId] = process.argv.slice(2);
const store = openProjectStore({projectFile: path.join(root!, 'Project.mioon'), locate: () => ({localDir: path.join(root!, 'records'), cacheDir: path.join(root!, 'cache'), tempDir: path.join(root!, 'tmp')})});
subscribeBackgroundTaskChanges(store.db, () => {
  if (store.db.isTransaction) throw Error('Notification ran before COMMIT');
  process.send?.({type: 'project-committed', taskId});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
});
store.tx(() => store.put('jobs', {id: taskId, projectId: store.projectId, status: 'queued', revision: 1, providerId: 'mock', snapshot: {}}));
