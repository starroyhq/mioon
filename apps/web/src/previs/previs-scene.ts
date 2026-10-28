import {PREVIS_HELD_PROP_KINDS,PREVIS_LIMITS,roundPrevisNumber} from '@mioon/contracts';
import type {PrevisFigure,PrevisProp,PrevisScene} from '@mioon/contracts';

// Pure scene edits for the previs editor. Every edit returns a new scene that
// still satisfies the contract: numbers rounded to three decimals and kept in
// range, IDs unique, held props valid. Nothing here touches three.js.
export type PrevisPropKind = PrevisProp['kind'];
export type PrevisPose = PrevisFigure['pose'];
export type PrevisElementPrefix = 'f' | 'p' | 'k';
export const PREVIS_POSE_ORDER: readonly PrevisPose[] = Object.freeze(['stand', 'walk', 'sit', 'hold', 'look-back']);
export const PREVIS_PROP_ORDER: readonly PrevisPropKind[] = Object.freeze(['box', 'cylinder', 'sphere', 'panel', 'umbrella', 'phone', 'bag', 'cup']);
// Width, height and depth in metres; a cylinder or sphere uses the width as its diameter.
export const PREVIS_PROP_SIZES: Readonly<Record<PrevisPropKind, readonly [number, number, number]>> = Object.freeze({
  box: [1, 1, 1], cylinder: [0.5, 1, 0.5], sphere: [0.5, 0.5, 0.5], panel: [2, 2, 0.05],
  umbrella: [1, 0.9, 1], phone: [0.07, 0.15, 0.01], bag: [0.35, 0.3, 0.12], cup: [0.08, 0.1, 0.08],
});
export const isHeldPropKind = (kind: string): boolean => (PREVIS_HELD_PROP_KINDS as readonly string[]).includes(kind);
/** A name the scene accepts: no control characters or lone surrogates, at
 * most 20 UTF-16 units, cut between whole characters. */
export function cleanPrevisName(value: string): string {
  let result = '';
  for (const character of value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')) {
    if (character.length === 1 && /[\ud800-\udfff]/u.test(character)) continue;
    if (result.length + character.length > PREVIS_LIMITS.nameLength) break;
    result += character;
  }
  return result;
}
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const coordinate = (value: number): number => roundPrevisNumber(clamp(value, -100, 100));
const angle = (value: number): number => { const wrapped = ((value + 180) % 360 + 360) % 360 - 180; return roundPrevisNumber(wrapped === -180 ? 180 : wrapped); };
const extent = (value: number): number => roundPrevisNumber(clamp(value, 0.01, 20));
type Vector = [number, number, number];
const vector = (value: readonly number[]): Vector => [coordinate(value[0]!), coordinate(value[1]!), coordinate(value[2]!)];

/** The next free element ID: one past the highest, or the lowest free one after 9999. */
export function nextPrevisId(prefix: PrevisElementPrefix, ids: readonly string[]): string {
  const used = new Set(ids.filter(id => id.startsWith(prefix)).map(id => Number(id.slice(1))).filter(Number.isInteger));
  const highest = Math.max(0, ...used);
  if (highest < 9999) return `${prefix}${highest + 1}`;
  for (let value = 1; value <= 9999; value++) if (!used.has(value)) return `${prefix}${value}`;
  throw new Error('No previs element ID is free');
}
const allIds = (scene: PrevisScene): string[] => [...scene.figures.map(item => item.id), ...scene.props.map(item => item.id), ...scene.keyframes.map(item => item.id)];
// New elements stand in a row in front of the default camera.
function freeSpot(scene: PrevisScene): Vector {
  const taken = [...scene.figures, ...scene.props].map(item => item.position);
  for (let step = 0; step < 40; step++) {
    const x = roundPrevisNumber((step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.8), z = roundPrevisNumber(-Math.floor(step / 9) * 0.8);
    if (!taken.some(position => Math.hypot(position[0] - x, position[2] - z) < 0.5)) return [x, 0, z];
  }
  return [0, 0, 0];
}
export const canAddPrevisFigure = (scene: PrevisScene): boolean => scene.figures.length < PREVIS_LIMITS.figures;
export const canAddPrevisProp = (scene: PrevisScene): boolean => scene.props.length < PREVIS_LIMITS.props;
export function addPrevisFigure(scene: PrevisScene): {scene: PrevisScene; id: string} {
  if (!canAddPrevisFigure(scene)) return {scene, id: ''};
  const id = nextPrevisId('f', allIds(scene));
  const figure: PrevisFigure = {id, name: '', visible: true, position: freeSpot(scene), rotation: 0, pose: 'stand', held: null};
  return {scene: {...scene, figures: [...scene.figures, figure]}, id};
}
export function addPrevisProp(scene: PrevisScene, kind: PrevisPropKind): {scene: PrevisScene; id: string} {
  if (!canAddPrevisProp(scene)) return {scene, id: ''};
  const id = nextPrevisId('p', allIds(scene)), size = [...PREVIS_PROP_SIZES[kind]] as Vector;
  const prop: PrevisProp = {id, kind, name: '', visible: true, position: freeSpot(scene), rotation: 0, size};
  return {scene: {...scene, props: [...scene.props, prop]}, id};
}
/** Removes a figure or prop; a removed prop is let go by whoever held it. */
export function removePrevisElement(scene: PrevisScene, id: string): PrevisScene {
  if (scene.figures.some(item => item.id === id)) return {...scene, figures: scene.figures.filter(item => item.id !== id)};
  if (!scene.props.some(item => item.id === id)) return scene;
  return {...scene, props: scene.props.filter(item => item.id !== id),
    figures: scene.figures.map(item => item.held?.propId === id ? {...item, held: null} : item)};
}
export interface PrevisFigurePatch {name?: string; visible?: boolean; position?: readonly number[]; rotation?: number; pose?: PrevisPose}
export function updatePrevisFigure(scene: PrevisScene, id: string, patch: PrevisFigurePatch): PrevisScene {
  return {...scene, figures: scene.figures.map(item => item.id !== id ? item : {...item,
    ...(patch.name !== undefined ? {name: cleanPrevisName(patch.name)} : {}),
    ...(patch.visible !== undefined ? {visible: patch.visible} : {}),
    ...(patch.position ? {position: vector(patch.position)} : {}),
    ...(patch.rotation !== undefined ? {rotation: angle(patch.rotation)} : {}),
    ...(patch.pose ? {pose: patch.pose} : {})})};
}
export interface PrevisPropPatch {name?: string; visible?: boolean; position?: readonly number[]; rotation?: number; size?: readonly number[]}
export function updatePrevisProp(scene: PrevisScene, id: string, patch: PrevisPropPatch): PrevisScene {
  return {...scene, props: scene.props.map(item => item.id !== id ? item : {...item,
    ...(patch.name !== undefined ? {name: cleanPrevisName(patch.name)} : {}),
    ...(patch.visible !== undefined ? {visible: patch.visible} : {}),
    ...(patch.position ? {position: vector(patch.position)} : {}),
    ...(patch.rotation !== undefined ? {rotation: angle(patch.rotation)} : {}),
    ...(patch.size ? {size: [extent(patch.size[0]!), extent(patch.size[1]!), extent(patch.size[2]!)] as Vector} : {})})};
}
export interface PrevisLightPatch {visible?: boolean; azimuth?: number; elevation?: number; intensity?: number}
export function updatePrevisLight(scene: PrevisScene, patch: PrevisLightPatch): PrevisScene {
  const light = scene.light;
  return {...scene, light: {visible: patch.visible ?? light.visible, azimuth: patch.azimuth === undefined ? light.azimuth : angle(patch.azimuth),
    elevation: patch.elevation === undefined ? light.elevation : roundPrevisNumber(clamp(patch.elevation, -90, 90)),
    intensity: patch.intensity === undefined ? light.intensity : roundPrevisNumber(clamp(patch.intensity, 0, 4))}};
}
/** A figure takes a prop in one hand, or puts it down with null. A prop has one holder. */
export function holdPrevisProp(scene: PrevisScene, figureId: string, propId: string | null, hand: 'left' | 'right' = 'right'): PrevisScene {
  if (propId !== null && !scene.props.some(item => item.id === propId && isHeldPropKind(item.kind))) return scene;
  return {...scene, figures: scene.figures.map(item => {
    if (item.id === figureId) return {...item, held: propId === null ? null : {propId, hand}};
    return propId !== null && item.held?.propId === propId ? {...item, held: null} : item;
  })};
}
export function previsSceneCounts(scene: PrevisScene): {figures: number; props: number; lights: number; keyframes: number} {
  return {figures: scene.figures.length, props: scene.props.length, lights: scene.light.visible ? 1 : 0, keyframes: scene.keyframes.length};
}
/** Which figure holds a prop, and in which hand. */
export function previsPropHolder(scene: PrevisScene, propId: string): {figure: PrevisFigure; hand: 'left' | 'right'} | null {
  const figure = scene.figures.find(item => item.held?.propId === propId);
  return figure?.held ? {figure, hand: figure.held.hand} : null;
}
