import {testEnv} from './test-env.ts';
/** Synthetic QA uses the real app registry and one real kernel per project.
 * Preparation runs before the backend starts; live reads require its inspect
 * capability. No legacy workspace, shadow database or production route. */
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {createServerProject, openServerProject} from './project-database.ts';
import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {createServices} from '../../packages/business/src/services.ts';

/** @param {unknown} name */
const quote = name => { if(typeof name!=='string')throw TypeError('Expected SQL identifier'); return '"' + name.replaceAll('"', '""') + '"'; };
/** @typedef {Record<string, import('node:sqlite').SQLOutputValue>} QaSqlRow */
/** @param {'ffmpeg'|'ffprobe'} name */
function mediaTool(name) {
  const setting = name === 'ffmpeg' ? 'MIOON_FFMPEG_PATH' : 'MIOON_FFPROBE_PATH';
  const candidates = [process.env[setting], process.env.MIOON_TEST_MEDIA_TOOLS && path.join(process.env.MIOON_TEST_MEDIA_TOOLS, name), '/opt/homebrew/bin/' + name, '/usr/bin/' + name];
  const executable = candidates.find(file => file && existsSync(file)) ?? name;
  process.env[setting] = executable;
  return executable;
}
/** @param {string} dataDir */
function rejectLegacy(dataDir) {
  if (existsSync(path.join(dataDir, 'workbench.sqlite'))) throw Error('Historical QA data must be preserved; choose a fresh kernel fixture directory');
}
/** @param {string} file @param {string} dataDir */
export function readQaFixture(file, dataDir) {
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  if (value.kernel !== true || path.resolve(value.workspace) !== path.resolve(dataDir) || !existsSync(path.join(dataDir, 'app-library.db'))) {
    throw Error('Historical QA fixture must be preserved; choose a fresh kernel fixture directory');
  }
  rejectLegacy(dataDir);
  return value;
}
/** @param {import('../../packages/business/src/project-file/store.ts').ProjectStore} store */
async function seeded(store, {media = true} = {}) {
  const services = createServices(store, new Map(), {env: {}});
  const saved = store.get('projects', store.projectId);
  if(!saved||typeof saved!=='object'||!('id' in saved)||typeof saved.id!=='string')throw Error('Missing QA project');
  const project={id:saved.id};
  try {
    if (media && store.list('assets', project.id).length === 0) {
      const ffmpeg = mediaTool('ffmpeg'); mediaTool('ffprobe');
      /** @type {string[]} */
      const sources = [];
      /** @param {string} name @param {string[]} args */
      const generate = (name, args) => {
        const file = path.join(store.tempDir, `qa-${randomUUID()}-${name}`); sources.push(file);
        execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-n', ...args, file], {env: testEnv(), timeout: 30000, maxBuffer: 1024 * 1024});
        return readFileSync(file);
      };
      try {
        const video = generate('clip.mp4', ['-f', 'lavfi', '-i', 'color=c=0x336699:s=320x180:r=30:d=3', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p']);
        const audio = generate('music.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3']);
        /** @type {{id:string}[]} */
        const imported = [];
        for (const [name, mimeType, bytes] of /** @type {[string,string,Buffer][]} */ ([['Synthetic QA clip.mp4', 'video/mp4', video], ['Synthetic QA music.wav', 'audio/wav', audio]])) {
          const value=await services.call('asset.import', {projectId: project.id, name, mimeType, dataBase64: bytes.toString('base64')});
          if(!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string')throw Error('Invalid QA asset');
          imported.push({id:value.id});
        }
        /** @param {unknown} value @returns {{revision:number,tracks:{id:string,kind:string}[]}} */
        const timelineValue=value=>{
          if(!value||typeof value!=='object'||!('revision' in value)||typeof value.revision!=='number'||!('tracks' in value)||!Array.isArray(value.tracks)||!value.tracks.every(track=>track&&typeof track==='object'&&typeof track.id==='string'&&typeof track.kind==='string'))throw Error('Invalid QA timeline');
          return /** @type {{revision:number,tracks:{id:string,kind:string}[]}} */(value);
        };
        let timeline = timelineValue(await services.call('timeline.get', {projectId: project.id}));
        /** @param {Record<string,unknown>} input */
        const add = async input => timeline = timelineValue(await services.call('timeline.clip.add', {projectId: project.id, expectedRevision: timeline.revision, requestId: randomUUID(), ...input}));
        const videoTrack = timeline.tracks.find(track => track.kind === 'video'), audioTrack = timeline.tracks.find(track => track.kind === 'audio');
        if(!videoTrack||!audioTrack||!imported[0]||!imported[1])throw Error('Missing QA tracks or assets');
        await add({assetId: imported[0].id, trackId: videoTrack.id, startFrame: 0, durationFrames: 45});
        await add({assetId: imported[0].id, trackId: videoTrack.id, startFrame: 45, durationFrames: 45});
        await add({assetId: imported[1].id, trackId: audioTrack.id, startFrame: 0, durationFrames: 90});
        await services.call('shot.create', {projectId: project.id, requestId: randomUUID(), title: '合成验收镜头', prompt: 'Synthetic local QA only.', duration: 3});
      } finally { for (const file of sources) rmSync(file, {force: true}); }
    }
    return {store, services, project};
  } catch (error) { try { await services.drain(); } finally {store.close();} throw error; }
}
/** @param {string} dataDir */
export async function createQaProject(dataDir, {name = 'Synthetic QA project', media = true} = {}) {
  rejectLegacy(dataDir);
  const {store} = createServerProject(dataDir, {name});
  return seeded(store, {media});
}
/** @param {string} dataDir */
export async function ensureQaProject(dataDir, {name = 'Synthetic QA project', media = true} = {}) {
  rejectLegacy(dataDir);
  let entry;
  if (existsSync(path.join(dataDir, 'app-library.db'))) {
    const library = openAppLibrary({dataDir});
    try { entry = library.registry.list().find(item => item.name === name); } finally { library.close(); }
  }
  return entry ? seeded(openServerProject(dataDir, entry.projectId), {media}) : createQaProject(dataDir, {name, media});
}
/** @param {Awaited<ReturnType<typeof createQaProject>>} fixture */
export async function closeQaProject(fixture) {
  try { await fixture.services.drain(); } finally {fixture.store.close();}
}

/** Bounded rows plus the complete schema, including metadata and autoindexes.
 * Call with the exact live manager's inspect capability, or a cold opener.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{databases: Record<string, {schema: QaSqlRow[], rows: Record<string, QaSqlRow[]>}>, changeMarks: QaSqlRow | undefined}}
 */
export function auditQaDatabases(db) {
  /** @type {Record<string, {schema: QaSqlRow[], rows: Record<string, QaSqlRow[]>}>} */
  const databases = {};
  for (const {name} of db.prepare('PRAGMA database_list').all()) {
    if (name === 'temp') continue;
    if(typeof name!=='string')throw Error('Invalid database name');
    const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM ${quote(name)}.sqlite_master ORDER BY type,name`).all();
    const tables = schema.filter(row => row.type === 'table').map(row => row.name);
    const rows = Object.fromEntries(tables.map(table => {
      const columns = db.prepare(`PRAGMA ${quote(name)}.table_xinfo(${quote(table)})`).all();
      if (columns.length > 64) throw Error('QA audit column bound exceeded');
      const target = `${quote(name)}.${quote(table)}`;
      const budget = db.prepare(`SELECT coalesce(sum(${columns.map(column => `coalesce(length(CAST(${quote(column.name)} AS BLOB)),0)`).join('+')}),0) AS bytes FROM ${target}`).get();
      if (!budget)throw Error('Missing QA byte budget');
      if (Number(budget.bytes) > 8 * 1024 * 1024) throw Error('QA audit byte bound exceeded');
      const definition=schema.find(row => row.type === 'table' && row.name === table);
      if(!definition||typeof definition.sql!=='string')throw Error('Missing QA table definition');
      const withoutRowid = /\bWITHOUT\s+ROWID\b/iu.test(definition.sql);
      const order = withoutRowid ? columns.filter(column => Number(column.pk) > 0).sort((a,b) => Number(a.pk) - Number(b.pk)).map(column => quote(column.name)).join(',') : 'rowid';
      const result = db.prepare(`SELECT * FROM ${target} ORDER BY ${order} LIMIT 1001`).all();
      if (result.length > 1000) throw Error('QA audit bound exceeded');
      return [table, result];
    }));
    databases[name] = {schema, rows};
  }
  const changeMarks = db.prepare('SELECT total_changes() AS totalChanges').get();
  return {databases, changeMarks};
}
/** @param {unknown} value */
export function hashQaSnapshot(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
