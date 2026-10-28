import type {PrevisFigure,PrevisProp,PrevisScene} from '@mioon/contracts';
import {canRedoPrevis,canUndoPrevis,emptyPrevisHistory,recordPrevisEdit,redoPrevisEdit,undoPrevisEdit} from './previs-history.ts';
import type {PrevisHistory} from './previs-history.ts';
import {previsViewDirection} from './previs-camera.ts';
import type {Vector3} from './previs-camera.ts';
import {isHeldPropKind} from './previs-scene.ts';
import {mergePrevisExports,recordPrevisExport} from './previs-keyframes.ts';

// What the open editor holds besides the saver: the scene being edited, the
// session's undo steps and the selected element. A selection is a figure or
// prop ID, 'light', or null for the camera itself.
export type PrevisSelection = string | null;
export const PREVIS_LIGHT_SELECTION = 'light';
export interface PrevisEditorModel {
  readonly scene: PrevisScene;
  readonly history: PrevisHistory;
  readonly selection: PrevisSelection;
}
const exists = (scene: PrevisScene, selection: PrevisSelection): boolean => selection === null || selection === PREVIS_LIGHT_SELECTION ||
  scene.figures.some(item => item.id === selection) || scene.props.some(item => item.id === selection);
const valid = (scene: PrevisScene, selection: PrevisSelection): PrevisSelection => exists(scene, selection) ? selection : null;
export const createPrevisEditorModel = (scene: PrevisScene): PrevisEditorModel => ({scene, history: emptyPrevisHistory(), selection: null});
/** One edit of the scene; edits sharing `key` within a moment form one undo step. */
export function editPrevisModel(model: PrevisEditorModel, scene: PrevisScene, {key = null, now = Date.now(), select}: {key?: string | null; now?: number; select?: PrevisSelection} = {}): PrevisEditorModel {
  const selection = valid(scene, select === undefined ? model.selection : select);
  if (scene === model.scene) return selection === model.selection ? model : {...model, selection};
  return {scene, history: recordPrevisEdit(model.history, model.scene, scene, {key, now}), selection};
}
// Undo and redo keep the exported images recorded since: they stay in the library.
export function undoPrevisModel(model: PrevisEditorModel): PrevisEditorModel {
  const step = undoPrevisEdit(model.history, model.scene);
  if (!step) return model;
  const scene = mergePrevisExports(step.scene, model.scene);
  return {scene, history: step.history, selection: valid(scene, model.selection)};
}
export function redoPrevisModel(model: PrevisEditorModel): PrevisEditorModel {
  const step = redoPrevisEdit(model.history, model.scene);
  if (!step) return model;
  const scene = mergePrevisExports(step.scene, model.scene);
  return {scene, history: step.history, selection: valid(scene, model.selection)};
}
/** Records an exported image on its keyframe. It is a fact, not an edit: no undo step. */
export function recordPrevisModelExport(model: PrevisEditorModel, keyframeId: string, assetId: string): PrevisEditorModel {
  const scene = recordPrevisExport(model.scene, keyframeId, assetId);
  return scene === model.scene ? model : {...model, scene};
}
export const selectPrevisElement = (model: PrevisEditorModel, selection: PrevisSelection): PrevisEditorModel =>
  valid(model.scene, selection) === model.selection ? model : {...model, selection: valid(model.scene, selection)};
/** Another version of the scene replaces this one (a reload): the session's undo steps no longer apply. */
export const replacePrevisModel = (model: PrevisEditorModel, scene: PrevisScene): PrevisEditorModel =>
  ({scene, history: emptyPrevisHistory(), selection: valid(scene, model.selection)});
export const canUndoPrevisModel = (model: PrevisEditorModel): boolean => canUndoPrevis(model.history);
export const canRedoPrevisModel = (model: PrevisEditorModel): boolean => canRedoPrevis(model.history);

// ---- Names and summaries (message keys stay in the catalog) ----
export type PrevisTranslate = (key: string, params?: Record<string, string | number>) => string;
export const PREVIS_POSE_KEYS: Readonly<Record<PrevisFigure['pose'], string>> = Object.freeze({
  stand: 'previs.pose.stand', walk: 'previs.pose.walk', sit: 'previs.pose.sit', hold: 'previs.pose.hold', 'look-back': 'previs.pose.lookBack',
});
export const PREVIS_KIND_KEYS: Readonly<Record<PrevisProp['kind'], string>> = Object.freeze({
  box: 'previs.kind.box', cylinder: 'previs.kind.cylinder', sphere: 'previs.kind.sphere', panel: 'previs.kind.panel',
  umbrella: 'previs.kind.umbrella', phone: 'previs.kind.phone', bag: 'previs.kind.bag', cup: 'previs.kind.cup',
});
export const PREVIS_HAND_KEYS = Object.freeze({left: 'previs.hand.left', right: 'previs.hand.right'} as const);
/** A figure without a name is shown by its number, which stays put when others are removed. */
export const previsFigureName = (figure: PrevisFigure, t: PrevisTranslate): string =>
  figure.name || t('previs.figure.default', {number: Number(figure.id.slice(1))});
/** A prop without a name is shown by its kind, numbered only when the scene has several of that kind. */
export function previsPropName(scene: PrevisScene, prop: PrevisProp, t: PrevisTranslate): string {
  if (prop.name) return prop.name;
  const same = scene.props.filter(item => item.kind === prop.kind), kind = t(PREVIS_KIND_KEYS[prop.kind]);
  return same.length < 2 ? kind : t('previs.prop.default', {kind, number: same.indexOf(prop) + 1});
}
export function previsElementName(scene: PrevisScene, selection: PrevisSelection, t: PrevisTranslate): string {
  if (selection === PREVIS_LIGHT_SELECTION) return t('previs.light.name');
  const figure = scene.figures.find(item => item.id === selection);
  if (figure) return previsFigureName(figure, t);
  const prop = scene.props.find(item => item.id === selection);
  return prop ? previsPropName(scene, prop, t) : t('previs.camera.name');
}
/** "2 figures · 2 props · 1 key light" for the inspector. */
export function previsSceneSummary(scene: PrevisScene, t: PrevisTranslate): string {
  return [t('previs.summary.figures', {count: scene.figures.length}), t('previs.summary.props', {count: scene.props.length}),
    t(scene.light.visible ? 'previs.summary.light' : 'previs.summary.lightOff')].join(' · ');
}
/** The detail shown next to an element in the scene outline. */
export function previsOutlineDetail(scene: PrevisScene, selection: PrevisSelection, t: PrevisTranslate, format: (value: number) => string = String): string {
  if (selection === PREVIS_LIGHT_SELECTION) return scene.light.visible ? t('previs.outline.lightDetail', {value: format(scene.light.intensity)}) : t('previs.outline.off');
  const figure = scene.figures.find(item => item.id === selection);
  if (figure) return t(PREVIS_POSE_KEYS[figure.pose]);
  const prop = scene.props.find(item => item.id === selection);
  if (!prop) return '';
  const holder = scene.figures.find(item => item.held?.propId === prop.id);
  if (holder?.held) return t('previs.outline.heldBy', {name: previsFigureName(holder, t), hand: t(PREVIS_HAND_KEYS[holder.held.hand])});
  return prop.name ? t(PREVIS_KIND_KEYS[prop.kind]) : '';
}
/** Props a figure could take in hand: the carriable ones nobody else holds. */
export const previsHoldableProps = (scene: PrevisScene, figureId: string): PrevisProp[] => scene.props.filter(prop => isHeldPropKind(prop.kind) &&
  !scene.figures.some(item => item.id !== figureId && item.held?.propId === prop.id));

// ---- Where things are, for orbiting and aiming the camera ----
export const PREVIS_FIGURE_HEIGHT = 1.75;
/** The centre of an element in metres: a standing figure's chest, a seated one's lap, a prop's middle. */
export function previsElementCenter(scene: PrevisScene, selection: PrevisSelection): Vector3 | null {
  const figure = scene.figures.find(item => item.id === selection);
  if (figure) return [figure.position[0], figure.position[1] + (figure.pose === 'sit' ? 0.7 : 1.05), figure.position[2]];
  const prop = scene.props.find(item => item.id === selection);
  if (!prop) return null;
  const holder = scene.figures.find(item => item.held?.propId === prop.id);
  if (holder) return previsElementCenter(scene, holder.id);
  return [prop.position[0], prop.position[1] + prop.size[1] / 2, prop.position[2]];
}
/** What the camera turns around in orbit mode: the selection, or a point on
 * the line of sight as deep as the scene's middle (in an empty scene the floor
 * point within ten metres, or four metres ahead), so the view does not jump
 * when orbiting starts. */
export function previsOrbitPivot(scene: PrevisScene, selection: PrevisSelection): Vector3 {
  const center = previsElementCenter(scene, selection);
  if (center) return center;
  const {position, yaw, pitch} = scene.camera, direction = previsViewDirection(yaw, pitch);
  const visible = scene.figures.some(item => item.visible) || scene.props.some(item => item.visible), middle = previsSceneCenter(scene);
  const depth = visible ? (middle[0] - position[0]) * direction[0] + (middle[1] - position[1]) * direction[1] + (middle[2] - position[2]) * direction[2] : 0;
  const floor = direction[1] < 0 ? position[1] / -direction[1] : Infinity;
  const distance = visible && depth > 1 ? Math.min(20, depth) : floor <= 10 ? floor : 4;
  return [position[0] + direction[0] * distance, position[1] + direction[1] * distance, position[2] + direction[2] * distance];
}
/** The figures and props the camera could aim at when nothing is selected: their middle. */
export function previsSceneCenter(scene: PrevisScene): Vector3 {
  const items = [...scene.figures.filter(item => item.visible).map(item => previsElementCenter(scene, item.id)!),
    ...scene.props.filter(item => item.visible).map(item => previsElementCenter(scene, item.id)!)];
  if (!items.length) return [0, 1, 0];
  const sum = items.reduce((total, item) => [total[0] + item[0], total[1] + item[1], total[2] + item[2]] as Vector3, [0, 0, 0] as Vector3);
  return [sum[0] / items.length, sum[1] / items.length, sum[2] / items.length];
}
