import {lstatSync, realpathSync} from 'node:fs';
import {AppError} from '../../contracts/src/app-error.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';

export interface OutputFileIdentity {readonly dev: string; readonly ino: string; readonly birthtimeNs: string}
export function outputFileIdentity(info: {dev: bigint; ino: bigint; birthtimeNs: bigint}): OutputFileIdentity {
  return {dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs)};
}
export function sameOutputIdentity(a: OutputFileIdentity, b: OutputFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}
const owners = new WeakMap<ProjectStore, {root: OutputFileIdentity; project: OutputFileIdentity}>();
const admissions=new WeakMap<ProjectStore,Set<()=>void>>();
const admissionFailures=new WeakSet<object>();
export function isProjectOutputAdmissionFailure(value:unknown):boolean{return value!==null&&typeof value==='object'&&admissionFailures.has(value);}
/** Service-owned application admission also fences asynchronous publishers;
 * accepting the RPC earlier cannot outlive a lost application owner. */
export function registerProjectOutputAdmission(store:ProjectStore,guard:()=>void):()=>void{
  if(!isProjectStore(store))throw new TypeError('An exact live project owner is required');
  const guards=admissions.get(store)??new Set<()=>void>();admissions.set(store,guards);guards.add(guard);
  return()=>{guards.delete(guard);if(!guards.size)admissions.delete(store);};
}
export function registerProjectOutputStore(store: ProjectStore): void {
  if (!isProjectStore(store)) throw new TypeError('Output publication requires the exact live project owner');
  if (owners.has(store)) return;
  const root = lstatSync(store.projectDir, {bigint: true}), project = lstatSync(store.projectFile, {bigint: true});
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(store.projectDir) !== store.projectDir ||
      !project.isFile() || project.isSymbolicLink() || project.nlink !== 1n || !isProjectFileHeld(outputFileIdentity(project))) {
    throw new AppError('PROJECT_UNAVAILABLE', '项目位置已改变，请重新打开项目', 409);
  }
  owners.set(store, {root: outputFileIdentity(root), project: outputFileIdentity(project)});
}
export function assertProjectOutputStore(store: ProjectStore): OutputFileIdentity {
  for(const admission of admissions.get(store)??[])try{admission();}catch(error){if(error!==null&&typeof error==='object')admissionFailures.add(error);throw error;}
  registerProjectOutputStore(store);
  const owner = owners.get(store)!;
  const root = lstatSync(store.projectDir, {bigint: true}), project = lstatSync(store.projectFile, {bigint: true});
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(store.projectDir) !== store.projectDir ||
      !project.isFile() || project.isSymbolicLink() || !sameOutputIdentity(owner.root, outputFileIdentity(root)) ||
      !sameOutputIdentity(owner.project, outputFileIdentity(project)) || !isProjectFileHeld(outputFileIdentity(project))) {
    throw new AppError('PROJECT_UNAVAILABLE', '项目位置已改变，请重新打开项目', 409);
  }
  return owner.root;
}
