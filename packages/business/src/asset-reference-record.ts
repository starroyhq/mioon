import {mediaReferenceSchema} from '../../contracts/src/media-reference.ts';
import type {MediaReference} from '../../contracts/src/media-reference.ts';
import type {DatabaseSync} from 'node:sqlite';
import {isProjectDatabase} from './project-file/held-files.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export interface MediaLocator {readonly reference?: MediaReference; readonly referenceRevision?: number; readonly relativePath?: string}
export function hasAssetReference(value: unknown): value is Record<string, unknown> & {reference: MediaReference; referenceRevision: number} {
 return object(value) && mediaReferenceSchema.safeParse(value.reference).success && Number.isSafeInteger(value.referenceRevision) && Number(value.referenceRevision) > 0;
}
/** The old workspace remains a separate, private test/runtime context until S7.
 * A current project can never fall back to its former managed locator. */
export function validAssetLocator(db: DatabaseSync, value: unknown): boolean {
 if (isProjectDatabase(db)) return hasAssetReference(value) && !Object.hasOwn(value,'relativePath') && value.sha256 === value.reference.fullSha256 && value.sizeBytes === value.reference.sizeBytes;
 if (hasAssetReference(value)) return true;
 if (!object(value)) return false;
 const relative = value.relativePath;
 return typeof relative === 'string' && relative.length <= 4096 && relative.startsWith('media/') && !/[\\\0]/u.test(relative) && relative.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function mediaLocatorFields(value: unknown): MediaLocator {
 if (hasAssetReference(value)) return {reference: value.reference, referenceRevision: value.referenceRevision};
 return object(value) && typeof value.relativePath === 'string' ? {relativePath: value.relativePath} : {};
}
export function sameMediaLocator(left: unknown, right: unknown): boolean {
 if (hasAssetReference(left) || hasAssetReference(right)) return hasAssetReference(left) && hasAssetReference(right) && left.referenceRevision === right.referenceRevision && JSON.stringify(left.reference) === JSON.stringify(right.reference);
 return object(left) && object(right) && (!Object.hasOwn(left,'relativePath') || !Object.hasOwn(right,'relativePath') || left.relativePath === right.relativePath);
}
