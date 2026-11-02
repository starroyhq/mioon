import {isProjectDatabase} from '../project-file/connection.ts';

const tables = {
  runs: ['agent_task_runs_v2', 'mio_runs'],
  steps: ['agent_task_steps_v2', 'mio_steps'],
  changes: ['agent_task_changes_v2', 'mio_changes'],
  origins: ['agent_task_job_origins_v2', 'mio_job_origins'],
  imports: ['agent_task_imports_v2', 'mio_imports'],
  claims: ['agent_task_edit_claims_v2', 'mio_edit_claims'],
} as const;

/** Both layouts are fixed by their opener. Callers select a known table name;
 * no marker probing, SQL rewriting or compatibility tables are involved. */
export function mioTable(db: unknown, kind: keyof typeof tables): string {
  return tables[kind][db instanceof DatabaseSync && isProjectDatabase(db) ? 1 : 0];
}
import {DatabaseSync} from 'node:sqlite';
