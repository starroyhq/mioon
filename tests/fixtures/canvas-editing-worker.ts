import {createCanvasEditing} from '../../packages/business/src/canvas-editing.ts';
import {recoverProjectFile} from '../../packages/business/src/project-file/connection.ts';
import {openProjectStore, registerProjectTransactionObserver} from '../../packages/business/src/project-file/index.ts';

const {projectFile, location, input, boundary, clock} = JSON.parse(process.argv[2]!);
recoverProjectFile(projectFile, {});
const store = openProjectStore({projectFile, locate: () => location, format4: {}});
const die = () => process.kill(process.pid, 'SIGKILL');
if (boundary === 'before-commit') registerProjectTransactionObserver(store.db, die);
createCanvasEditing(store, {now: () => new Date(clock).toISOString(), time: () => clock}).call('canvas.apply', input);
if (boundary === 'after-commit') die();
process.exitCode = 1;
