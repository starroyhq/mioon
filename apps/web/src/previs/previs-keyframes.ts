import {PREVIS_LIMITS,canonicalPrevisValue} from '@mioon/contracts';
import type {PrevisCamera,PrevisKeyframe,PrevisScene} from '@mioon/contracts';
import {normalizePrevisCamera,previsShotSize} from './previs-camera.ts';
import {cleanPrevisName,nextPrevisId} from './previs-scene.ts';

// Recorded camera keyframes. Keyframes are snapshots: jumping to one moves the
// current camera there, and moving the camera afterwards leaves the keyframe
// as it was. They are shown as K1, K2, … in their current order; a keyframe
// without a name is named after the shot size of its focal length.
export type PrevisTranslate = (key: string, params?: Record<string, string | number>) => string;
const same = (a: unknown, b: unknown): boolean => canonicalPrevisValue(a) === canonicalPrevisValue(b);
export const PREVIS_SHOT_SIZE_KEYS = Object.freeze({wide: 'previs.keyframe.wide', medium: 'previs.keyframe.medium', mediumClose: 'previs.keyframe.mediumClose', close: 'previs.keyframe.close'} as const);
export const canAddPrevisKeyframe = (scene: PrevisScene): boolean => scene.keyframes.length < PREVIS_LIMITS.keyframes;
/** Records a camera (the current one by default) as a new last keyframe and
 * makes it active. IDs in `taken` (keyframes seen earlier while editing) are
 * not reused, so a cached picture never passes to a different keyframe. */
export function addPrevisKeyframe(scene: PrevisScene, camera: PrevisCamera = scene.camera, taken: readonly string[] = []): {scene: PrevisScene; id: string} {
  if (!canAddPrevisKeyframe(scene)) return {scene, id: ''};
  const id = nextPrevisId('k', [...scene.keyframes.map(item => item.id), ...taken]);
  const keyframe: PrevisKeyframe = {id, name: '', camera: normalizePrevisCamera(camera), exports: []};
  return {scene: {...scene, keyframes: [...scene.keyframes, keyframe], activeKeyframeId: id}, id};
}
export function removePrevisKeyframe(scene: PrevisScene, id: string): PrevisScene {
  if (!scene.keyframes.some(item => item.id === id)) return scene;
  return {...scene, keyframes: scene.keyframes.filter(item => item.id !== id), activeKeyframeId: scene.activeKeyframeId === id ? null : scene.activeKeyframeId};
}
export function renamePrevisKeyframe(scene: PrevisScene, id: string, name: string): PrevisScene {
  const clean = cleanPrevisName(name.trim());
  if (!scene.keyframes.some(item => item.id === id && item.name !== clean)) return scene;
  return {...scene, keyframes: scene.keyframes.map(item => item.id === id ? {...item, name: clean} : item)};
}
/** Moves a keyframe to a position in the order; positions outside the list are clamped. */
export function movePrevisKeyframe(scene: PrevisScene, id: string, index: number): PrevisScene {
  const from = scene.keyframes.findIndex(item => item.id === id), to = Math.min(scene.keyframes.length - 1, Math.max(0, Math.round(index)));
  if (from < 0 || from === to) return scene;
  const keyframes = [...scene.keyframes], [moved] = keyframes.splice(from, 1);
  keyframes.splice(to, 0, moved!);
  return {...scene, keyframes};
}
/** The current camera takes the keyframe's camera and the keyframe becomes active. */
export function jumpToPrevisKeyframe(scene: PrevisScene, id: string): PrevisScene {
  const keyframe = scene.keyframes.find(item => item.id === id);
  if (!keyframe || scene.activeKeyframeId === id && same(scene.camera, keyframe.camera)) return scene;
  return {...scene, camera: keyframe.camera, activeKeyframeId: id};
}
/** A keyframe is shown as current while the camera still looks through it. */
export function isPrevisKeyframeCurrent(scene: PrevisScene, id: string): boolean {
  const keyframe = scene.keyframes.find(item => item.id === id);
  return Boolean(keyframe && scene.activeKeyframeId === id && same(scene.camera, keyframe.camera));
}
/** Keeps an exported image on its keyframe, newest last, at most four. An
 * image belongs to one keyframe, so another keyframe that had it lets it go. */
export function recordPrevisExport(scene: PrevisScene, id: string, assetId: string): PrevisScene {
  if (!scene.keyframes.some(item => item.id === id)) return scene;
  const lower = assetId.toLowerCase();
  const keyframes = scene.keyframes.map(item => {
    const others = item.exports.filter(value => value.toLowerCase() !== lower);
    if (item.id === id) return {...item, exports: [...others, assetId].slice(-PREVIS_LIMITS.exportsPerKeyframe)};
    return others.length === item.exports.length ? item : {...item, exports: others};
  });
  return same(keyframes, scene.keyframes) ? scene : {...scene, keyframes};
}
/** Exported images stay in the library whatever the undo history holds: a
 * restored step keeps the exports the current scene records for its keyframes. */
export function mergePrevisExports(target: PrevisScene, current: PrevisScene): PrevisScene {
  const exports = new Map(current.keyframes.map(item => [item.id, item.exports]));
  let changed = false;
  const keyframes = target.keyframes.map(item => {
    const value = exports.get(item.id);
    if (!value || same(value, item.exports)) return item;
    changed = true;
    return {...item, exports: value};
  });
  return changed ? {...target, keyframes} : target;
}
export const previsKeyframeLabel = (index: number): string => `K${index + 1}`;
export function previsKeyframeName(keyframe: PrevisKeyframe, t: PrevisTranslate): string {
  return keyframe.name || t(PREVIS_SHOT_SIZE_KEYS[previsShotSize(keyframe.camera.focalLength)]);
}
/** Everything a keyframe's picture depends on; equal keys render the same picture. */
export function previsKeyframeContentKey(scene: PrevisScene, keyframe: PrevisKeyframe): string {
  return canonicalPrevisValue({figures: scene.figures, props: scene.props, light: scene.light, camera: keyframe.camera});
}
