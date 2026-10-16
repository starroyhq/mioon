/** Fixed candidate presentation adapter. URLs contain managed identities only;
 * the server still proves the original receipt and published output on read. */
import {timelineRenderDeliveryFields} from '@mioon/contracts/timeline-delivery';
import {readOpacityCandidateApplication} from './opacity-candidate-application.ts';

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
export interface CandidateRenderPresentation {
  readonly record: Readonly<Value>;
  readonly previewHref: string | null;
  readonly downloadHref: string | null;
}
export function opacityCandidateRenderPresentation(
  applicationToken: unknown,
  value: unknown,
  {projectId, timelineId, connected, heldExportIds = []}: {projectId: unknown; timelineId?: unknown; connected: boolean; heldExportIds?: readonly string[]},
): CandidateRenderPresentation | null {
  try {
    const application = readOpacityCandidateApplication(applicationToken);
    if (!application || !object(value) || value.projectId !== projectId || typeof value.id !== 'string' ||
        !object(value.snapshot) || !object(value.snapshot.timeline) || timelineId !== undefined && value.snapshot.timeline.id !== timelineId) return null;
    const input = {projectId, requestId: value.requestId, expectedRevision: value.timelineRevision, purpose: value.purpose,
      exportId: value.id, ...(timelineId === undefined ? {} : {timelineId}), ...timelineRenderDeliveryFields(value.snapshot)};
    if (!application.isTimelineRenderRecord(value, input)) return null;
    const ready = connected && value.status === 'succeeded' && !heldExportIds.includes(value.id);
    return Object.freeze({record: value,
      previewHref: ready ? `/media/${String(value.assetId)}?preview=1&exportId=${value.id}` : null,
      downloadHref: ready && value.purpose === 'export' ? `/media/${String(value.assetId)}?download=1&exportId=${value.id}` : null});
  } catch {return null;}
}
