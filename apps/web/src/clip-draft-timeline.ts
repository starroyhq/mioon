import {FORMAT5_TIMELINE_FORMAT, isTimelineRecord} from '@mioon/contracts';
import {isFormat5Timeline} from '@mioon/contracts/project-format5';

/** The clip draft acknowledgement validates the exact timeline record the
 * editor will display. Format 5 keeps board/shot fields the legacy format-4
 * validator intentionally rejects; using the format-5 validator keeps the
 * acknowledgement strict instead of widening the saved-value comparison. */
export function clipDraftTimelineAccepted(value: unknown, projectId: string, format5: boolean): boolean {
  return value !== null && (format5
    ? isFormat5Timeline(value, {projectId})
    : isTimelineRecord(value, {projectId, ...(format5 ? {format: FORMAT5_TIMELINE_FORMAT} : {})}));
}
