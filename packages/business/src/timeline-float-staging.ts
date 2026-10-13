import path from 'node:path';
import {open} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {constants,openSync,fstatSync,lstatSync,closeSync,unlinkSync,rmdirSync} from 'node:fs';
import type {Stats} from 'node:fs';

interface FloatStagingRuntime {
  checkMediaEffect(beforeEffect?: () => void, signal?: AbortSignal): void;
  createPrivateTemporaryDirectory(root: string, prefix: string): string;
  validatePrivateDirectory(root: string): unknown;
}
interface Options {readonly signal?: AbortSignal; readonly beforeEffect?: () => void}
const changed = (): Error => Object.assign(new Error('The local render staging files changed.'), {code:'INVALID_TIMELINE_SNAPSHOT'});
const same = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;

/** Only the opt-in float renderer uses this private, bounded, flat staging set.
 * No scan/recursive deletion or same-name replacement adoption is permitted.
 * The caller retains this object until its exact unconfirmed child closes. */
export function createTimelineFloatStaging(destination: string, options: Options, runtime: FloatStagingRuntime): {
  readonly work: string;
  effect(): void;
  reserve(file: string): void;
  openOwnedFile(file: string): Promise<FileHandle>;
  writeOwnedFile(file: string, bytes: string | Uint8Array): Promise<void>;
  cleanup(): boolean;
} {
  runtime.checkMediaEffect(options.beforeEffect,options.signal);
  const work = runtime.createPrivateTemporaryDirectory(path.dirname(destination),'.timeline-render-');
  const directoryFd = openSync(work,constants.O_RDONLY | constants.O_NOFOLLOW), directory = fstatSync(directoryFd);
  const files = new Map<string,{fd: number; identity: Stats}>();
  const ownsDirectory = (): boolean => {
    try { const current=lstatSync(work);return current.isDirectory()&&!current.isSymbolicLink()&&same(directory,current); } catch { return false; }
  };
  const ownsFile = (file: string, entry: {identity: Stats}): boolean => {
    try { const current=lstatSync(file);return current.isFile()&&!current.isSymbolicLink()&&current.nlink===1&&same(entry.identity,current)&&current.uid===directory.uid&&!(current.mode&0o077); } catch { return false; }
  };
  const effect = (): void => {
    runtime.checkMediaEffect(options.beforeEffect,options.signal);
    if(!ownsDirectory())throw changed();
    runtime.validatePrivateDirectory(work);
    for(const [file,entry] of files)if(!ownsFile(file,entry))throw changed();
  };
  const reserve = (file: string): void => {
    effect();
    if(path.dirname(file)!==work||files.has(file)||files.size>=512)throw changed();
    const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    files.set(file,{fd,identity:fstatSync(fd)});
  };
  const openOwnedFile = async (file: string): Promise<FileHandle> => {
    reserve(file);const entry=files.get(file)!;let handle: FileHandle | undefined;
    try {
      handle=await open(file,constants.O_WRONLY|constants.O_NOFOLLOW);effect();
      const current=await handle.stat();effect();
      if(!current.isFile()||!same(entry.identity,current))throw changed();
      return handle;
    } catch(error) { await handle?.close().catch(()=>{});throw error; }
  };
  const writeOwnedFile = async (file: string, bytes: string | Uint8Array): Promise<void> => {
    const handle=await openOwnedFile(file);let failed=false;
    try { effect();await handle.writeFile(bytes);effect(); }
    catch(error) { failed=true;throw error; }
    finally { await handle.close().catch(error=>{if(!failed)throw error;}); }
  };
  const cleanup = (): boolean => {
    let confirmed=true;
    try {
      for(const [file,entry] of files) {
        if(!ownsDirectory()){confirmed=false;break;}
        if(ownsFile(file,entry)){try{unlinkSync(file);}catch{confirmed=false;}}else confirmed=false;
      }
      if(ownsDirectory()){try{rmdirSync(work);}catch{confirmed=false;}}else confirmed=false;
    } finally {
      for(const entry of files.values())try{closeSync(entry.fd);}catch{confirmed=false;}
      try{closeSync(directoryFd);}catch{confirmed=false;}
    }
    return confirmed;
  };
  return {work,effect,reserve,openOwnedFile,writeOwnedFile,cleanup};
}
