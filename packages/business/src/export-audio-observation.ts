import type {DatabaseSync} from 'node:sqlite';

export interface ExportAudioObservationEntry {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  task: Promise<unknown>;
}
export interface ExportAudioObservationAdmission {
  active: ExportAudioObservationEntry | null;
  stopped: boolean;
  shutdownFailure: unknown;
}

// One owner-bound permit for final-file and current-mix audio observations. Store wrappers
// around the same native database share it. There is no queue or result cache.
// The operation that acquired it retains its task until its exact child closes;
// an unconfirmed termination remains a sticky owner-wide shutdown failure.
const admissions = new WeakMap<DatabaseSync, ExportAudioObservationAdmission>();

export function exportAudioObservationAdmission(db: DatabaseSync): ExportAudioObservationAdmission {
  let admission = admissions.get(db);
  if (!admission) {
    admission = {active: null, stopped: false, shutdownFailure: undefined};
    admissions.set(db, admission);
  }
  return admission;
}
