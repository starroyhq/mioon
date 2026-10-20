/** Shared managed byte import pipeline. Candidate application assembly supplies
 * its existing owner fence; it never supplies a codec or filesystem adapter. */
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {writeFile, unlink, open, lstat} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../contracts/src/app-error.ts';
import {taskEffectOrigin} from './agent/task-effects-v2.ts';

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = createRequire(import.meta.url);
const media: unknown = require('./media.ts');
const lifecycle: unknown = require('./operation-lifecycle.ts');
function invoke(module: unknown, name: string, args: unknown[]): unknown {
  if (!object(module) || typeof module[name] !== 'function') throw new Error('Managed import runtime is unavailable');
  return Reflect.apply(module[name], module, args) as unknown;
}
export interface ManagedAssetImportStore {
  root: string;
  db: {prepare(sql: string): {get(...args: string[]): unknown}};
  put(table: 'assets', value: Value): unknown;
  tx?<T>(callback:()=>T):T;
}
export interface ManagedAssetImportOptions {
  signal?: AbortSignal;
  required(table: 'projects', id: string): unknown;
  now(): string;
  guarded: boolean;
  effectFence(): (() => void) | undefined;
  unsafe(): Error;
  safeError(error: unknown): boolean;
}
export function createManagedAssetImportHandler(store: ManagedAssetImportStore, options: ManagedAssetImportOptions) {
  const checkpoint = (signal?: AbortSignal): void => {invoke(lifecycle, 'checkpoint', [signal]);};
  return async (input: Value, context: {signal?: AbortSignal} = {}): Promise<unknown> => {
    const signal = context.signal ?? options.signal, invocationFence = options.effectFence(),origin=taskEffectOrigin();
    checkpoint(signal); invocationFence?.();
    if (typeof input.projectId !== 'string' || typeof input.dataBase64 !== 'string' || typeof input.mimeType !== 'string') throw new AppError('INVALID_MEDIA', '无效的素材导入');
    const projectId = input.projectId, mimeType = input.mimeType, importProject = options.required('projects', projectId);
    if (!object(importProject)) throw options.unsafe();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64) || input.dataBase64.length % 4) throw new AppError('INVALID_MEDIA', '无效的 base64');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.length > 30 * 1024 * 1024 || bytes.length === 0) throw new AppError('INVALID_MEDIA', '素材大小须为 1 字节至 30 MiB');
    const four = (start: number, value: string): boolean => bytes.toString('ascii', start, start + 4) === value;
    const mp3Frame = bytes.length >= 4 && bytes[0] === 255 && (bytes[1]! & 224) === 224 && (bytes[1]! & 24) !== 8 && (bytes[1]! & 6) !== 0 && (bytes[2]! & 240) !== 240 && (bytes[2]! & 12) !== 12;
    const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' :
      four(0, 'RIFF') && four(8, 'WEBP') ? 'image/webp' : four(0, 'RIFF') && four(8, 'WAVE') ? 'audio/wav' :
      bytes.toString('ascii', 0, 3) === 'ID3' || mp3Frame ? 'audio/mpeg' : four(4, 'ftyp') ? 'iso-bmff' :
      bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163])) ? 'video/webm' : null;
    if (!(detected === 'iso-bmff' ? ['video/mp4', 'audio/mp4'].includes(mimeType) : detected === mimeType)) throw new AppError('INVALID_MEDIA', '文件类型与实际内容不符');
    const extensions: Readonly<Record<string, string>> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'};
    const id = randomUUID(), relativePath = `media/${id}.${extensions[mimeType]}`, file = path.join(store.root, relativePath);
    checkpoint(signal);
    const expectedByteHash = options.guarded ? createHash('sha256').update(bytes).digest('hex') : null;
    let ownedHandle: FileHandle | undefined, ownedIdentity: Stats | undefined, writtenIdentity: Stats | undefined;
    const beforeEffect = options.guarded ? (): void => {
      invocationFence?.();
      const row: unknown = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?").get(projectId);
      let project: unknown;
      try {project = object(row) && typeof row.data === 'string' ? JSON.parse(row.data) as unknown : undefined;} catch {throw options.unsafe();}
      if (!object(row) || !object(project) || project.id !== row.id || row.id !== projectId || project.createdAt !== importProject.createdAt) throw options.unsafe();
      if (ownedIdentity) {
        let actual: Stats; try {actual = lstatSync(file);} catch {throw options.unsafe();}
        if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== ownedIdentity.dev || actual.ino !== ownedIdentity.ino || writtenIdentity &&
            (actual.size !== writtenIdentity.size || actual.mtimeMs !== writtenIdentity.mtimeMs || actual.ctimeMs !== writtenIdentity.ctimeMs)) throw options.unsafe();
      }
    } : undefined;
    origin?.beforeEffect();beforeEffect?.();
    if (!options.guarded) await writeFile(file, bytes, {flag: 'wx'});
    try {
      if (options.guarded) {ownedHandle = await open(file, 'wx'); ownedIdentity = await ownedHandle.stat(); beforeEffect!(); await ownedHandle.writeFile(bytes); writtenIdentity = await ownedHandle.stat(); beforeEffect!();}
      checkpoint(signal);
      const info: unknown = await invoke(media, 'fileInfo', [file, {signal, beforeEffect}]); checkpoint(signal); beforeEffect?.();
      if (!object(info)) throw options.unsafe();
      if (options.guarded && info.sha256 !== expectedByteHash) throw options.unsafe();
      const hasVideo = info.hasVideo ?? (typeof info.width === 'number' && info.width > 0 && typeof info.height === 'number' && info.height > 0);
      if (mimeType.startsWith('audio/') ? (!info.hasAudio || hasVideo || !(typeof info.duration === 'number' && info.duration > 0)) : !hasVideo) throw new Error('Declared media kind does not match decoded streams');
      const publish=():unknown=>{origin?.beforeEffect();const result=store.put('assets', {id, projectId, name: input.name, mimeType, ...info, relativePath, url: `/media/${id}`, createdAt: options.now(), provenance: 'user-import'});
        if(origin?.importHandle){const connection=store.db as unknown as {prepare(sql:string):{run(...args:string[]):{changes:number|bigint}}};const changed=connection.prepare("UPDATE agent_task_imports_v2 SET status='imported',assetId=? WHERE id=? AND projectId=? AND status='importing'").run(id,origin.importHandle,projectId);if(changed.changes!==1)throw new AppError('AGENT_TASK_UNKNOWN_RESULT','导入受理记录已改变',409);}
        return result;};
      return store.tx?store.tx(publish):publish();
    } catch (error) {
      if (!options.guarded) await unlink(file).catch(() => {});
      else if (ownedIdentity) {const actual = await lstat(file).catch(() => null); if (actual?.isFile() && actual.dev === ownedIdentity.dev && actual.ino === ownedIdentity.ino) await unlink(file).catch(() => {});}
      if (object(error) && (error.terminationUnconfirmed||typeof error.code==='string'&&error.code.startsWith('AGENT_TASK_')) || options.safeError(error)) throw error;
      checkpoint(signal); throw new AppError('INVALID_MEDIA', '无法解码素材或媒体类型不符，请检查文件');
    } finally {if (ownedHandle) await ownedHandle.close();}
  };
}
