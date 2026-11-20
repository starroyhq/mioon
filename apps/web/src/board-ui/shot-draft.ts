/** GP: 21-10 shot-property draft reconciliation.
 *
 * A draft that the user has not changed follows the row's saved values. A dirty
 * draft keeps its text and the revision editing started on, so a save after an
 * external write returns the shared revision conflict instead of overwriting.
 */
export interface ShotDraftValues {
  readonly title: string;
  readonly prompt: string;
  readonly duration: number;
}
export interface ShotDraftState {
  readonly shotId: string | null;
  readonly revision: number | null;
  readonly values: ShotDraftValues;
  readonly dirty: boolean;
}
export interface ShotDraftRow {
  readonly id: string;
  readonly revision: number;
  readonly title?: unknown;
  readonly prompt?: unknown;
  readonly duration?: unknown;
}
const valuesOf = (shot: ShotDraftRow): ShotDraftValues => ({
  title: typeof shot.title === 'string' ? shot.title : '',
  prompt: typeof shot.prompt === 'string' ? shot.prompt : '',
  duration: Number.isSafeInteger(shot.duration) ? Number(shot.duration) : 4,
});
export function reconcileShotDraft(previous: ShotDraftState | null, shot: ShotDraftRow | null): ShotDraftState {
  if (!shot || !Number.isSafeInteger(shot.revision)) {
    return {shotId: null, revision: null, values: {title: '', prompt: '', duration: 4}, dirty: false};
  }
  if (!previous || previous.shotId !== shot.id || !previous.dirty) {
    return {shotId: shot.id, revision: shot.revision, values: valuesOf(shot), dirty: false};
  }
  return previous;
}
