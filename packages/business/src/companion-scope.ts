import path from 'node:path';
import type {LocalDraftStorage} from './local-drafts.ts';
import type {AppDocumentStore} from './app-db/stores.ts';

type CompanionDocuments = Pick<AppDocumentStore, 'read' | 'write'>;

/** A companion ACK must follow the app transaction's commit. The app port
 * rejects nesting, so an enclosing transaction cannot retain an uncommitted
 * write after one of these synchronous companion APIs reports success. */
export function createAppCompanionDocuments({documents, tx}: {documents: CompanionDocuments; tx<T>(write: () => T): T}): CompanionDocuments {
  return {
    read: name => documents.read(name),
    write: (name, text) => { tx(() => documents.write(name, text)); },
  };
}

/** Scope files are selected only by the trusted host composition. Validation
 * still uses the companion's private root and never opens a SQLite file. */
export function validateCompanionScope(root: string, storage: LocalDraftStorage, databaseFile?: string) {
  if (databaseFile !== undefined && (!path.isAbsolute(databaseFile) || path.dirname(path.resolve(databaseFile)) !== path.resolve(root))) {
    throw new TypeError('The scope database must belong to the companion directory');
  }
  const directory = storage.validatePrivateDirectory(root);
  const db = storage.validateManagedFile(databaseFile ?? path.join(root, 'workbench.sqlite'), {root});
  return {directory, db};
}
