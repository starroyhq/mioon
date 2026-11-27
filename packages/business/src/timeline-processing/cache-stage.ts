import {createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readdirSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {privateStorageIdentity, readPrivateFile, validateManagedDirectory, validateManagedFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {processingStageMarkerSchema, processingStageOwnershipSchema} from '../../../contracts/src/timeline-processing-storage.ts';
import type {ProcessingStageOwnership} from '../../../contracts/src/timeline-processing-storage.ts';
import {removeOwnedDirectory, removeOwnedFile, sameFile} from '../managed-file-io.ts';

export const processingStageName = /^stage-[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/u;
const markerLimit = 8192;
const keyName = '.stage-ownership.key';
const privateOptions = {private: true};
const stageFiles = new Set(['receipt.json', 'proxy.mkv', 'video.raw', 'audio.f32le', 'clock.json', 'frames.jsonl',
  'video-block.raw', 'audio-source.f32le', 'preview-frames.raw', 'preview.mp4']);

export interface ProcessingStageContext {readonly taskId: string; readonly requestId: string}
export interface ProcessingStageWriter {
  started(pid: number): void;
  exited(): void;
}
export interface ProcessingStageWriterTracking {begin(): ProcessingStageWriter}

interface StageContents {
  readonly name: string;
  readonly directory: string;
  readonly info: Stats;
  readonly files: ReadonlyMap<string, Stats>;
  readonly bytes: number;
  readonly removable: boolean;
}
interface StageEvidence extends StageContents {
  readonly marker: Stats;
  readonly ownership: ProcessingStageOwnership;
}

function changed(): never {throw new Error('Processing stage ownership changed');}
const macFor = (key: Buffer, ownership: ProcessingStageOwnership): Buffer => createHmac('sha256', key).update(JSON.stringify(ownership)).digest();
const birthtime = (info: Stats): number | null => Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : null;
function knownGone(pid: number): boolean {
  try {process.kill(pid, 0); return false;}
  catch (error) {return (error as NodeJS.ErrnoException).code === 'ESRCH';}
}
function writersGone({hostPid, writers}: ProcessingStageOwnership): boolean {
  // A reused PID or permission failure delays cleanup. A pending slot could
  // have spawned a writer before its PID was committed and is never guessed.
  return knownGone(hostPid) && writers.every(({pid}) => pid !== null && knownGone(pid));
}

/** Private, durable sibling marks survive both a writer crash and publication
 * of the stage directory. The MAC binds the stage to this cache's private
 * issuance key, and the identities stop copied marks authorizing another inode. */
export function createProcessingStageJournal(root: string) {
  const keyFile = path.join(root, keyName);
  const markerFile = (name: string) => path.join(root, `${name}.owner.json`);
  function key(create = false): Buffer | null {
    const found = readPrivateFile(keyFile, {root, maxBytes: 32, allowMissing: true});
    if (found !== null) {
      if (!Buffer.isBuffer(found) || found.length !== 32) changed();
      return found;
    }
    if (!create) return null;
    const issued = randomBytes(32);
    writePrivateFileAtomic(keyFile, issued, {root, maxBytes: 32, replace: false});
    return issued;
  }
  function contents(name: string): StageContents | null {
    if (!processingStageName.test(name)) return null;
    try {
      const directory = path.join(root, name);
      const info = validateManagedDirectory(directory, {root, ...privateOptions});
      if (!info) return null;
      const names = readdirSync(directory);
      if (names.length > 16) return null;
      const files = new Map<string, Stats>();
      let bytes = 0, removable = true;
      for (const file of names) {
        try {
          const leaf = validateManagedFile(path.join(directory, file), {root, ...privateOptions});
          if (!leaf || !Number.isSafeInteger(bytes + leaf.size)) changed();
          files.set(file, leaf);
          bytes += leaf.size;
          if (!stageFiles.has(file)) removable = false;
        } catch {removable = false;}
      }
      return {name, directory, info, files, bytes, removable};
    } catch {return null;}
  }
  function evidence(stage: StageContents, rootIdentity: string): StageEvidence | null {
    try {
      const file = markerFile(stage.name);
      const marker = validateManagedFile(file, {root, allowMissing: true, maxBytes: markerLimit, ...privateOptions});
      if (!marker) return null;
      const macKey = key();
      if (!macKey) return null;
      const body = readPrivateFile(file, {root, maxBytes: markerLimit, encoding: 'utf8'});
      const {ownership, mac} = processingStageMarkerSchema.parse(JSON.parse(String(body)));
      const created = birthtime(stage.info);
      if (!timingSafeEqual(Buffer.from(mac, 'hex'), macFor(macKey, ownership)) ||
          ownership.stage !== stage.name || ownership.rootIdentity !== rootIdentity ||
          ownership.directoryIdentity !== privateStorageIdentity(stage.info) ||
          ownership.directoryBirthtime !== created ||
          !sameFile(marker, validateManagedFile(file, {root, maxBytes: markerLimit, ...privateOptions}))) return null;
      // Where birthtime is unreported or falls back to ctime, the inode alone
      // can be reused by a replacement directory after a crash.
      return {...stage, removable: stage.removable && created !== null && created !== stage.info.ctimeMs, marker, ownership};
    } catch {return null;}
  }
  function issue(name: string, info: Stats, rootIdentity: string, projectId: string, cacheKey: string, context: ProcessingStageContext) {
    const macKey = key(true)!;
    const file = markerFile(name), directory = path.join(root, name);
    let saved: Stats | undefined;
    let ownership = processingStageOwnershipSchema.parse({version: 1, ...context, projectId, cacheKey, stage: name,
      rootIdentity, directoryIdentity: privateStorageIdentity(info), directoryBirthtime: birthtime(info), hostPid: process.pid, writers: []});
    const save = (next: ProcessingStageOwnership): void => {
      const current = validateManagedDirectory(directory, {root, ...privateOptions});
      if (!current || privateStorageIdentity(current) !== ownership.directoryIdentity || (saved && !sameFile(saved,
        validateManagedFile(file, {root, maxBytes: markerLimit, ...privateOptions})))) changed();
      const canonical = processingStageOwnershipSchema.parse(next);
      writePrivateFileAtomic(file, JSON.stringify({ownership: canonical, mac: macFor(macKey, canonical).toString('hex')}),
        {root, maxBytes: markerLimit, replace: saved !== undefined});
      saved = validateManagedFile(file, {root, maxBytes: markerLimit, ...privateOptions})!;
      ownership = canonical;
    };
    save(ownership);
    const writer: ProcessingStageWriterTracking = {
      begin() {
        const id = randomUUID();
        save({...ownership, writers: [...ownership.writers, {id, pid: null}]});
        return {
          started(pid) {
            if (!ownership.writers.some(entry => entry.id === id && entry.pid === null)) changed();
            save({...ownership, writers: ownership.writers.map(entry => entry.id === id ? {id, pid} : entry)});
          },
          exited() {
            if (ownership.writers.some(entry => entry.id === id)) {
              save({...ownership, writers: ownership.writers.filter(entry => entry.id !== id)});
            }
          },
        };
      },
    };
    return {writer, assertIdle() {if (ownership.writers.length > 0) changed();},
      removeMarker() {if (!removeOwnedFile(file, root, saved)) changed();}};
  }
  function reap(stage: StageEvidence, rootIdentity: string, beforeEffect: () => void): number {
    if (!stage.removable || !writersGone(stage.ownership)) return 0;
    beforeEffect();
    const currentContents = contents(stage.name);
    const current = currentContents && evidence(currentContents, rootIdentity);
    if (!current?.removable || !sameFile(stage.marker, current.marker) || !writersGone(current.ownership)) return 0;
    let bytes = 0;
    for (const [name, leaf] of current.files) {
      beforeEffect();
      if (!removeOwnedFile(path.join(current.directory, name), root, leaf)) changed();
      bytes += leaf.size;
    }
    beforeEffect();
    removeOwnedDirectory(current.directory, root, current.info);
    if (!removeOwnedFile(markerFile(stage.name), root, current.marker)) changed();
    return bytes;
  }
  return {contents, evidence, issue, reap};
}
