import {isProjectId} from '../../packages/contracts/src/project-file.ts';
// Disposable real HTTP backend. Only owned fixture IPC can arm a crash; no
// production endpoint, environment variable, provider, or live media is used.
// The same IPC reads the project on the backend's own connection: while the
// backend holds the project, the parent cannot open a second connection.
import {installWireGuard} from '../helpers/inspection-wire-fixture.ts';
import type {InspectApplication,InspectProject} from '../../apps/server/src/index.ts';

const guard = installWireGuard({auditPath: process.argv[2]});
const {startServer} = await import('../helpers/test-server.ts');
const {schemaObjects} = await import('../helpers/project-database.ts');
const {readProjectState,changeMarks} = await import('../helpers/project-state.ts');
const {databaseFiles} = await import('../helpers/data-file-snapshot.ts');
const crashPhases = new Set(['afterPreparePersist', 'afterClaim', 'afterBusinessCommit', 'afterOutcomePersist']);
interface DraftsServerLike {url: string; close(): Promise<unknown>}
interface DraftsProcessMessage {type: string; root?: string; token?: string; phase?: string; id?: string; [key: string]: unknown}
let server: DraftsServerLike|undefined, inspect: InspectProject|undefined, inspectApplication: InspectApplication|undefined, armed: string|undefined, started = false, closing: Promise<void>|undefined;
const phases: string[] = [];
const report = (message: unknown): void => { if (process.connected) process.send?.(message); };
// Every table but SQLite's own, as plain rows that survive the IPC channel.
const snapshot = (projectId: string) => inspect!(projectId, db => Object.fromEntries(schemaObjects(db)
  .filter(({type, name}) => type === 'table' && !name.startsWith('sqlite_'))
  .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row}))])));
const close = () => closing ??= (async () => {
  await server?.close();
  if (process.connected) process.disconnect();
})();
process.on('message', async (raw: unknown) => {
  const message = raw as DraftsProcessMessage;
  try {
    if (message.type === 'start' && !started) {
      started = true;
      server = await startServer({dataDir: String(message.root), token: message.token, port: 0,
        taskGatewayV2: async function* () { guard.deny('model gateway'); },
        taskFault(phase: string) {
          if (phases.length < 64) phases.push(phase);
          if (phase === armed) process.kill(process.pid, 'SIGKILL');
        },
        inspectProject(received) { inspect = received; },
        inspectApplication(received) { inspectApplication = received; },
      });
      report({type: 'ready', pid: process.pid, url: server.url});
    } else if (message.type === 'arm') {
      if (typeof message.phase !== 'string' || !crashPhases.has(message.phase)) throw Error('Unsupported synthetic crash phase');
      armed = message.phase;
      report({type: 'reply', id: message.id, data: {armed}});
    } else if (message.type === 'observe') report({type: 'reply', id: message.id, data: {phases}});
    else if (message.type === 'corrupt-last-project-document') {
      if (typeof message.id!=='string'||Object.keys(message).some(key=>!['type','id'].includes(key)) || !inspectApplication) throw Error('Unsupported last-project fault question');
      const changed=inspectApplication(db=>db.prepare("UPDATE app_documents SET data=? WHERE name='last-project-v1.json'").run(JSON.stringify('PRIVATE corrupt evidence')).changes);
      if(changed!==1)throw Error('The last-project fixture document must already exist');
      report({type:'reply',id:message.id,data:{corrupted:true}});
    }
    else if (message.type === 'app-storage') {
      if (typeof message.id!=='string'||Object.keys(message).some(key => !['type','id'].includes(key)) || !inspectApplication) throw Error('Unsupported application storage question');
      const data = inspectApplication(db => {const state=readProjectState(db);return {schema:state.schema,rows:state.tables,version:changeMarks(db),databases:databaseFiles(db)};});
      report({type:'reply',id:message.id,data});
    }
    else if (message.type === 'lut-state') {
      if(typeof message.id!=='string'||!isProjectId(message.projectId)||Object.keys(message).some(key=>!['type','id','projectId'].includes(key)))throw Error('Unsupported LUT state question');
      const data = inspect!(String(message.projectId), db => ({rows: Object.fromEntries(schemaObjects(db).filter(({type}) => type === 'table')
        .map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({...row, ...(name === 'project_lut_resources' ? {content: Buffer.from(row.content as Uint8Array).toString('base64')} : {})}))])), version: changeMarks(db),databases:databaseFiles(db)}));
      report({type: 'reply', id: message.id, data});
    }
    else if (message.type === 'snapshot') report({type: 'reply', id: message.id, data: snapshot(String(message.projectId))});
    else if (message.type === 'close') await close();
    else throw Error('Unsupported synthetic fixture message');
  } catch (error) {
    report({type: 'fatal', message: String((error as {stack?: string})?.stack || error).slice(-8000)});
    process.exitCode = 1;
    await close().catch(() => {});
  }
});
process.once('disconnect', () => { close().catch(() => { process.exitCode = 1; }); });
