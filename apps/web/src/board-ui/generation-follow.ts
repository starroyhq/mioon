/** GP: when a Format-5 generation completes while its shot clip is in follow
 * mode, the board's selected version advances and the main-track clip must
 * switch through the unified `board-version` action. The workbench effect and
 * the RPC integration test share this pure decision table. */
type Row = Record<string, maybe>;
type maybe = unknown;
export interface Format5FollowJob {readonly id: string; readonly status?: string; readonly shotId?: string; readonly versionId?: string | null}
export interface Format5FollowShot {readonly id: string; readonly selectedVersionId?: string | null}
export interface Format5FollowClip {
  readonly id: string; readonly versionId?: string | null;
  readonly sequenceSource?: {readonly nodeId?: string; readonly versionMode?: string} | null;
}
export interface Format5GenerationFollow {
  readonly key: string; readonly jobId: string; readonly shotId: string; readonly versionId: string;
}
/** Jobs that finished with a version, whose shot already follows that version,
 * and whose main-track clip is still on an older media revision. */
export function pendingFormat5GenerationFollows(jobs: readonly (Format5FollowJob | Row)[],
  shots: readonly (Format5FollowShot | Row)[], clips: readonly (Format5FollowClip | Row)[],
  handled: ReadonlySet<string>): readonly Format5GenerationFollow[] {
  const result: Format5GenerationFollow[] = [];
  const shotsById = new Map(shots.map(shot => [String((shot as Row).id), shot as Row]));
  for (const raw of jobs) {
    const job = raw as Row;
    const shotId = typeof job.shotId === 'string' ? job.shotId : null;
    const versionId = typeof job.versionId === 'string' ? job.versionId : null;
    if (job.status !== 'succeeded' || !shotId || !versionId || typeof job.id !== 'string') continue;
    const key = `${job.id}:${versionId}`;
    if (handled.has(key)) continue;
    const shot = shotsById.get(shotId);
    if (!shot || shot.selectedVersionId !== versionId) continue;
    const clip = clips.find(item => {
      const row = item as Row;
      const source = row.sequenceSource as Row | null | undefined;
      return source?.nodeId === shotId && source.versionMode === 'follow';
    }) as Row | undefined;
    if (!clip || clip.versionId === versionId) continue;
    result.push({key, jobId: String(job.id), shotId, versionId});
  }
  return result;
}
