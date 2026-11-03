import {assertProjectDatabase} from '../store-runtime.ts';
const tables={runs:'mio_runs',steps:'mio_steps',changes:'mio_changes',origins:'mio_job_origins',imports:'mio_imports',claims:'mio_edit_claims'} as const;
/** A selected table never grants connection authority. */
export function mioTable(db: unknown, kind: keyof typeof tables): string {
 assertProjectDatabase(db);return tables[kind];
}
