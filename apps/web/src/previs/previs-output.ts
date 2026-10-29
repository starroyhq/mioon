import {previsFramedElements} from '@mioon/contracts';
import type {PrevisCamera,PrevisScene} from '@mioon/contracts';
import {isReferenceEdge,referenceForShot} from '../reference-connections.ts';
import {previsFigureName,previsPropName} from './previs-editor-state.ts';
import {previsKeyframeLabel} from './previs-keyframes.ts';
import type {PrevisTranslate} from './previs-keyframes.ts';

// How a previs node feeds shots. A keyframe image becomes a shot's first
// frame (`referenceAssetIds`) or last frame (`lastFrameAssetId`); a plain
// canvas link from the previs node to the shot shows which keyframe it is.
// Labels are derived from the shot's current frames, never stored.
export type PrevisFrameRole = 'first' | 'last';
export interface PrevisShotView {
  readonly id: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly orderIndex: number;
  readonly aspectRatio?: string;
  readonly referenceAssetIds?: readonly string[];
  readonly lastFrameAssetId?: string | null;
  readonly revision: number;
}
export interface PrevisEdgeView {readonly id: string; readonly source: string; readonly target: string; readonly kind?: string}
export interface PrevisFrameUse {readonly shot: PrevisShotView; readonly role: PrevisFrameRole}
const lower = (value: unknown): string => typeof value === 'string' ? value.toLowerCase() : '';
export const previsShotFirstFrame = (shot: PrevisShotView): string | null => shot.referenceAssetIds?.[0] ?? null;
export const previsShotLastFrame = (shot: PrevisShotView): string | null => shot.lastFrameAssetId ?? null;
const frameOf = (shot: PrevisShotView, role: PrevisFrameRole): string | null => role === 'first' ? previsShotFirstFrame(shot) : previsShotLastFrame(shot);
/** Shots a visual link connects this previs node to, in storyboard order. */
export function previsConnectedShots(nodeId: string, shots: readonly PrevisShotView[], edges: readonly PrevisEdgeView[]): PrevisShotView[] {
  const targets = new Set(edges.filter(edge => edge.source === nodeId && !isReferenceEdge(edge)).map(edge => edge.target));
  return shots.filter(shot => targets.has(shot.id)).sort((a, b) => a.orderIndex - b.orderIndex);
}
/** The position of the keyframe that exported an image, or -1. */
export function previsKeyframeOfAsset(scene: PrevisScene, assetId: string | null | undefined): number {
  const value = lower(assetId);
  return value ? scene.keyframes.findIndex(item => item.exports.some(asset => asset.toLowerCase() === value)) : -1;
}
/** Which keyframe supplies a shot's first and last frame, by position. */
export function previsShotFrames(scene: PrevisScene, shot: PrevisShotView): {first: number; last: number} {
  return {first: previsKeyframeOfAsset(scene, previsShotFirstFrame(shot)), last: previsKeyframeOfAsset(scene, previsShotLastFrame(shot))};
}
/** "首帧 · K2", "尾帧 · K3" or both for a link from the previs node to a shot; null when neither comes from it. */
export function previsEdgeLabel(scene: PrevisScene, shot: PrevisShotView, t: PrevisTranslate): string | null {
  const frames = previsShotFrames(scene, shot), parts: string[] = [];
  if (frames.first >= 0) parts.push(t('previs.edge.first', {label: previsKeyframeLabel(frames.first)}));
  if (frames.last >= 0) parts.push(t('previs.edge.last', {label: previsKeyframeLabel(frames.last)}));
  return parts.length ? parts.join(' / ') : null;
}
/** The shot frames each keyframe's images supply, keyed by keyframe ID. */
export function previsKeyframeUses(scene: PrevisScene, shots: readonly PrevisShotView[]): Map<string, PrevisFrameUse[]> {
  const uses = new Map<string, PrevisFrameUse[]>();
  for (const shot of [...shots].sort((a, b) => a.orderIndex - b.orderIndex)) for (const role of ['first', 'last'] as const) {
    const index = previsKeyframeOfAsset(scene, frameOf(shot, role));
    if (index < 0) continue;
    const id = scene.keyframes[index]!.id;
    uses.set(id, [...(uses.get(id) ?? []), {shot, role}]);
  }
  return uses;
}
/** Whether a keyframe's images already supply this frame of the shot. */
export function previsKeyframeSupplies(scene: PrevisScene, keyframeId: string, shot: PrevisShotView, role: PrevisFrameRole): boolean {
  const index = previsKeyframeOfAsset(scene, frameOf(shot, role));
  return index >= 0 && scene.keyframes[index]!.id === keyframeId;
}
const ratioValue = (value: unknown): number | null => {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(value.trim()) : null;
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
};
/** Why a keyframe image cannot become this frame of the shot, or null:
 * the shot's aspect ratio differs from the previs frame, a canvas link
 * already controls its first frame, or the image is already its other frame. */
export type PrevisFrameIssue = 'aspect' | 'reference' | 'duplicate';
export function previsFrameIssue({shot, role, ratio, edges, assetId = null}: {shot: PrevisShotView; role: PrevisFrameRole; ratio: string; edges: readonly PrevisEdgeView[]; assetId?: string | null}): PrevisFrameIssue | null {
  const shotRatio = ratioValue(shot.aspectRatio ?? '9:16'), frameRatio = ratioValue(ratio);
  if (shotRatio === null || frameRatio === null || Math.abs(shotRatio - frameRatio) > 0.01) return 'aspect';
  if (role === 'first' && referenceForShot(edges as readonly unknown[], shot.id)) return 'reference';
  const other = frameOf(shot, role === 'first' ? 'last' : 'first');
  if (assetId && other && lower(other) === lower(assetId)) return 'duplicate';
  return null;
}
/** Reasons App can refuse at the moment of setting: unsaved shot text, edits
 * awaiting confirmation, or the shot is gone. */
export type PrevisFrameRefusal = PrevisFrameIssue | 'text' | 'pending' | 'missing';
export const PREVIS_FRAME_ISSUE_KEYS: Readonly<Record<PrevisFrameRefusal, string>> = Object.freeze({
  aspect: 'previs.frame.issueAspect', reference: 'previs.frame.issueReference', duplicate: 'previs.frame.issueDuplicate',
  text: 'previs.frame.issueText', pending: 'previs.frame.issuePending', missing: 'previs.frame.issueMissing',
});
// ---- What the editor asks App to do ----
export interface PrevisImportRequest {readonly projectId: string; readonly name: string; readonly dataBase64: string; readonly sha256: string; readonly width: number; readonly height: number}
export type PrevisImportOutcome = {readonly status: 'imported'; readonly assetId: string} | {readonly status: 'failed'; readonly code: string} | {readonly status: 'unknown'};
export interface PrevisFrameRequest {readonly projectId: string; readonly nodeId: string; readonly shotId: string; readonly role: PrevisFrameRole; readonly assetId: string}
/** What undoing a set frame restores: the shot's previous first-frame list or last frame, and the link it added. */
export interface PrevisFrameUndo {readonly projectId: string; readonly nodeId: string; readonly shotId: string; readonly role: PrevisFrameRole; readonly assetId: string; readonly previous: readonly string[] | string | null; readonly edgeId: string | null}
export type PrevisFrameOutcome = {readonly status: 'applied'; readonly undo: PrevisFrameUndo} | {readonly status: 'refused'; readonly reason: PrevisFrameRefusal} | {readonly status: 'failed'};
/** Undo is refused when the frame has changed since (`changed`) or for the reasons setting is. */
export type PrevisUndoOutcome = {readonly status: 'undone'} | {readonly status: 'refused'; readonly reason: PrevisFrameRefusal | 'changed'} | {readonly status: 'failed'};
// ---- What a camera frames (the frustum math is shared with Mio's previs tool) ----
/** Names of the visible figures and props a camera shows in the output frame. */
export function previsFramedNames(scene: PrevisScene, camera: PrevisCamera, aspect: number, t: PrevisTranslate): string[] {
  const framed = previsFramedElements(scene, camera, aspect);
  return [...scene.figures.filter(figure => framed.figures.includes(figure.id)).map(figure => previsFigureName(figure, t)),
    ...scene.props.filter(prop => framed.props.includes(prop.id)).map(prop => previsPropName(scene, prop, t))];
}
/** "镜头 03" style number of a shot in storyboard order. */
export const previsShotNumber = (shot: PrevisShotView): string => String(shot.orderIndex + 1).padStart(2, '0');
