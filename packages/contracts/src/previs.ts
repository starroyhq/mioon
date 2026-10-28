import {z} from 'zod';

type Rec = Record<string, unknown>;
// Camera previs (schema 64). A previs node is a canvas node of type 'previs'
// whose record carries one bounded scene: mannequins, props, one key light, the
// current camera and up to 24 recorded camera keyframes. The editor renders it
// in the browser; an exported keyframe image enters the library through
// asset.import and its asset ID is kept on the keyframe (the newest four).
// Thumbnails are a separate disposable cache, never part of the node, a
// project package or a receipt.
//
// Units are metres, degrees and millimetres; +Y is up and the ground is y=0.
// A camera with yaw 0 and pitch 0 looks along -Z; positive yaw turns left
// (counter-clockwise seen from above) and positive pitch looks up. A figure or
// prop with rotation 0 faces +Z. Focal lengths are for a 36 mm long frame edge.
// Every number keeps at most three decimals, so a saved scene compares exactly.
export const PREVIS_SCENE_SCHEMA_VERSION = 1 as const;
export const PREVIS_POSES = Object.freeze(['stand', 'walk', 'sit', 'hold', 'look-back'] as const);
export const PREVIS_PROP_KINDS = Object.freeze(['box', 'cylinder', 'sphere', 'panel', 'umbrella', 'phone', 'bag', 'cup'] as const);
// Props a mannequin can carry in one hand.
export const PREVIS_HELD_PROP_KINDS = Object.freeze(['umbrella', 'phone', 'bag', 'cup'] as const);
export const PREVIS_HANDS = Object.freeze(['left', 'right'] as const);
export const PREVIS_MUTATION_OPERATIONS = Object.freeze(['previs.create', 'previs.scene.set'] as const);
export const PREVIS_THUMBNAIL_CARD = 'card' as const;
export const PREVIS_THUMBNAIL_MIME_TYPE = 'image/jpeg' as const;
export const PREVIS_LIMITS = Object.freeze({
  figures: 8, props: 24, keyframes: 24, exportsPerKeyframe: 4, nameLength: 20, labelLength: 150,
  // A scene at every item limit fits sceneBytes; a whole node row stays far
  // below the 32 KiB rows Mio reads when it inspects the canvas.
  sceneBytes: 16384, nodeBytes: 24576, responseBytes: 24576,
  // Autosave writes often: only the newest scene saves of a node keep receipts.
  sceneReceiptsPerNode: 4, createsPerProject: 256, createsGlobal: 1024,
  thumbnailBytes: 65536, thumbnailEdge: 384, thumbnailBase64: 87384,
  thumbnailsPerNode: 25, thumbnailsPerProject: 1000, thumbnailsGlobal: 2048,
});

const threeDecimals = (value: number): boolean => Number(value.toFixed(3)) === value;
const measure = (min: number, max: number) => z.number().finite().min(min).max(max).refine(threeDecimals, 'Keep at most three decimals');
/** The value a scene keeps for a finite number: three decimals, never -0. */
export function roundPrevisNumber(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}
// Code-unit key order, independent of locale; the same function runs in the
// browser and the backend.
export const canonicalPrevisValue = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Rec).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const encoder = new TextEncoder();
/** UTF-8 bytes of a scene's canonical JSON. */
export const previsSceneBytes = (scene: unknown): number => encoder.encode(canonicalPrevisValue(scene)).length;

const id = z.string().uuid(), key = z.string().min(8).max(200), revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().min(1).max(40);
// No control characters or unpaired surrogates, so a name never grows when escaped.
const name = z.string().max(PREVIS_LIMITS.nameLength).regex(/^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff]*$/u, 'Names cannot contain control characters');
const figureId = z.string().regex(/^f[1-9][0-9]{0,3}$/), propId = z.string().regex(/^p[1-9][0-9]{0,3}$/), keyframeId = z.string().regex(/^k[1-9][0-9]{0,3}$/);
const coordinate = measure(-100, 100), angle = measure(-180, 180), tilt = measure(-90, 90), extent = measure(0.01, 20);
const vector = z.tuple([coordinate, coordinate, coordinate]);
export const previsCameraSchema = z.object({position: vector, yaw: angle, pitch: tilt, focalLength: measure(10, 300)}).strict();
export const previsFigureSchema = z.object({id: figureId, name, visible: z.boolean(), position: vector, rotation: angle, pose: z.enum(PREVIS_POSES),
  held: z.object({propId, hand: z.enum(PREVIS_HANDS)}).strict().nullable()}).strict();
// Sizes are width, height and depth in metres; a cylinder or sphere uses the
// width as its diameter.
export const previsPropSchema = z.object({id: propId, kind: z.enum(PREVIS_PROP_KINDS), name, visible: z.boolean(), position: vector, rotation: angle,
  size: z.tuple([extent, extent, extent])}).strict();
export const previsLightSchema = z.object({visible: z.boolean(), azimuth: angle, elevation: tilt, intensity: measure(0, 4)}).strict();
// Exports are the newest exported images of a keyframe, oldest first.
export const previsKeyframeSchema = z.object({id: keyframeId, name, camera: previsCameraSchema,
  exports: z.array(id).max(PREVIS_LIMITS.exportsPerKeyframe)}).strict();
const sceneShape = z.object({schemaVersion: z.literal(PREVIS_SCENE_SCHEMA_VERSION),
  figures: z.array(previsFigureSchema).max(PREVIS_LIMITS.figures), props: z.array(previsPropSchema).max(PREVIS_LIMITS.props),
  light: previsLightSchema, camera: previsCameraSchema, keyframes: z.array(previsKeyframeSchema).max(PREVIS_LIMITS.keyframes),
  activeKeyframeId: keyframeId.nullable()}).strict();
export type PrevisScene = z.infer<typeof sceneShape>;
export type PrevisCamera = z.infer<typeof previsCameraSchema>;
export type PrevisFigure = z.infer<typeof previsFigureSchema>;
export type PrevisProp = z.infer<typeof previsPropSchema>;
export type PrevisKeyframe = z.infer<typeof previsKeyframeSchema>;
const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;
/** The first rule a structurally valid scene breaks, or null. */
export function previsSceneIssue(scene: PrevisScene): string | null {
  if (!distinct(scene.figures.map(item => item.id)) || !distinct(scene.props.map(item => item.id)) || !distinct(scene.keyframes.map(item => item.id))) return 'Element IDs must be distinct';
  const kinds = new Map(scene.props.map(item => [item.id, item.kind]));
  const held = scene.figures.flatMap(item => item.held ? [item.held.propId] : []);
  if (!distinct(held)) return 'A prop is held by one figure at most';
  if (held.some(item => !(PREVIS_HELD_PROP_KINDS as readonly string[]).includes(kinds.get(item) ?? ''))) return 'Only an umbrella, phone, bag or cup can be held';
  if (scene.activeKeyframeId !== null && !scene.keyframes.some(item => item.id === scene.activeKeyframeId)) return 'The active keyframe must exist';
  if (!distinct(scene.keyframes.flatMap(item => item.exports.map(asset => asset.toLowerCase())))) return 'An exported image belongs to one keyframe';
  if (previsSceneBytes(scene) > PREVIS_LIMITS.sceneBytes) return 'The scene exceeds 16 KiB';
  return null;
}
export const previsSceneSchema = sceneShape.superRefine((scene, context) => {
  const issue = previsSceneIssue(scene);
  if (issue) context.addIssue({code: z.ZodIssueCode.custom, message: issue});
});
/** The scene of a new previs node: one standing figure, the key light and an
 * eye-level camera. Names stay empty; the editor shows localized defaults. */
export function defaultPrevisScene(): PrevisScene {
  return {schemaVersion: PREVIS_SCENE_SCHEMA_VERSION,
    figures: [{id: 'f1', name: '', visible: true, position: [0, 0, 0], rotation: 0, pose: 'stand', held: null}], props: [],
    light: {visible: true, azimuth: 45, elevation: 45, intensity: 1},
    camera: {position: [0, 1.6, 4], yaw: 0, pitch: -4, focalLength: 35}, keyframes: [], activeKeyframeId: null};
}

const canvasPosition = z.object({x: z.number().finite(), y: z.number().finite()}).strict();
const label = z.string().max(PREVIS_LIMITS.labelLength);
// `revision` advances on every change of the node; `sceneRevision` only when
// the scene is saved, so moving or renaming the node never conflicts with it.
export const previsNodeRecordSchema = z.object({id, projectId: id, type: z.literal('previs'), label, text: z.literal(''), position: canvasPosition,
  revision, sceneRevision: revision, scene: previsSceneSchema, createdAt: timestamp}).strict()
  .refine(value => value.sceneRevision <= value.revision, 'A scene revision never passes its node revision');
export type PrevisNodeRecord = z.infer<typeof previsNodeRecordSchema>;
export const isPrevisScene = (value: unknown): value is PrevisScene => previsSceneSchema.safeParse(value).success;
export const isPrevisNodeRecord = (value: unknown): value is PrevisNodeRecord => previsNodeRecordSchema.safeParse(value).success;

// A thumbnail slot is the node card or one keyframe of the current scene.
const slot = z.string().regex(/^(?:card|k[1-9][0-9]{0,3})$/);
export const previsThumbnailSlotSchema = slot;
const base64 = z.string().min(4).max(PREVIS_LIMITS.thumbnailBase64).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0, 'Invalid base64 length');
const edge = z.number().int().min(1).max(PREVIS_LIMITS.thumbnailEdge);
export const previsThumbnailSchema = z.object({slot, sceneRevision: revision, width: edge, height: edge,
  byteLength: z.number().int().min(1).max(PREVIS_LIMITS.thumbnailBytes), updatedAt: timestamp}).strict();
export type PrevisThumbnail = z.infer<typeof previsThumbnailSchema>;
const thumbnailSetResponseSchema = previsThumbnailSchema.extend({projectId: id, nodeId: id}).strict();
const thumbnailGetResponseSchema = z.object({projectId: id, nodeId: id,
  items: z.array(previsThumbnailSchema.extend({dataBase64: base64}).strict()).max(PREVIS_LIMITS.thumbnailsPerNode)}).strict();
export type PrevisThumbnailSetResponse = z.infer<typeof thumbnailSetResponseSchema>;
export type PrevisThumbnailGetResponse = z.infer<typeof thumbnailGetResponseSchema>;

export const previsSchemas = Object.freeze({
  'previs.create': z.object({projectId: id, label: label.optional(), position: canvasPosition, requestId: key}).strict(),
  'previs.scene.set': z.object({projectId: id, nodeId: id, expectedSceneRevision: revision, scene: previsSceneSchema, requestId: key}).strict(),
  'previs.thumbnail.set': z.object({projectId: id, nodeId: id, slot, sceneRevision: revision, dataBase64: base64}).strict(),
  'previs.thumbnail.get': z.object({projectId: id, nodeId: id, slots: z.array(slot).min(1).max(PREVIS_LIMITS.thumbnailsPerNode)}).strict()
    .refine(value => distinct(value.slots), 'Slots must be distinct'),
});
export const previsDescriptions = Object.freeze({
  'previs.create': '在画布上新建一个机位预演节点，带默认场景（一个站立人偶、主光和视平线机位）；只在本机保存，不渲染、不调用模型、不付费；使用必填稳定requestId精确重放',
  'previs.scene.set': '按场景修订号整体保存一个预演节点的场景：人偶、道具、主光、当前机位和关键帧，节点名称和位置不变；同时删除已不存在关键帧的缩略图；使用必填稳定requestId精确重放',
  'previs.thumbnail.set': '保存预演节点卡片或当前场景某个关键帧的JPEG缩略图（长边不超过384像素、不超过64KB），按节点和位置覆盖；只是可重建的缓存，不留回执，不进项目包',
  'previs.thumbnail.get': '只读获取预演节点卡片或关键帧的缩略图；没有缩略图的位置不返回，不渲染',
});
const readEffect = {readOnly: true, idempotent: true, destructive: false, openWorld: false,
  databaseWrite: false, fileWrite: false, externalIO: false, localProcess: false, paidGeneration: false} as const;
export const previsEffects = Object.freeze({
  'previs.create': Object.freeze({...readEffect, readOnly: false, databaseWrite: true,
    notes: 'Creates one canvas node of type previs with the default local scene. Required stable requestId replays the original acknowledgement. No rendering, media, process, network or paid generation.'}),
  'previs.scene.set': Object.freeze({...readEffect, readOnly: false, destructive: true, databaseWrite: true,
    notes: 'Replaces the whole bounded scene of one owned previs node under scene revision CAS; its label and position are kept. Removes cached thumbnails of keyframes the scene no longer has. Required stable requestId replays the acknowledgement of the newest four saves of the node; an older save is answered as a revision conflict and never applied twice. No rendering, media, network or paid generation.'}),
  'previs.thumbnail.set': Object.freeze({...readEffect, readOnly: false, destructive: true, databaseWrite: true,
    notes: 'Stores one bounded baseline or progressive JPEG for the card or an existing keyframe of an owned previs node at its current scene revision, replacing that slot and evicting the oldest thumbnails at capacity. Disposable derived cache: no receipt, never in project packages; the destructive hint is limited to cache entries.'}),
  'previs.thumbnail.get': Object.freeze({...readEffect,
    notes: 'Reads cached JPEG thumbnails of one owned previs node by slot. Missing slots are omitted; no rendering, repair or writes.'}),
});

const schemaFor = (operation: string): z.ZodTypeAny | null => Object.hasOwn(previsSchemas, operation) ? (previsSchemas as Record<string, z.ZodTypeAny>)[operation]! : null;
/** The acknowledgement a previs mutation must return for its exact input. A
 * replayed save is the node as that save left it. */
export function isPrevisMutationResponse(operation: unknown, input: unknown, result: unknown): boolean {
  const schema = typeof operation === 'string' ? schemaFor(operation) : null;
  if (!schema || !(PREVIS_MUTATION_OPERATIONS as readonly unknown[]).includes(operation) || !schema.safeParse(input).success || !isPrevisNodeRecord(result)) return false;
  const request = input as Rec;
  if (result.projectId !== request.projectId) return false;
  if (operation === 'previs.create') return result.revision === 1 && result.sceneRevision === 1 && result.label === (request.label ?? '') &&
    canonicalPrevisValue(result.position) === canonicalPrevisValue(request.position);
  return result.id === request.nodeId && result.sceneRevision === (request.expectedSceneRevision as number) + 1 &&
    canonicalPrevisValue(result.scene) === canonicalPrevisValue(request.scene);
}
const decodedBytes = (value: string): number => value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
export function isPrevisThumbnailSetResponse(input: unknown, result: unknown): boolean {
  if (!previsSchemas['previs.thumbnail.set'].safeParse(input).success) return false;
  const parsed = thumbnailSetResponseSchema.safeParse(result);
  if (!parsed.success) return false;
  const request = input as Rec, value = parsed.data;
  return value.projectId === request.projectId && value.nodeId === request.nodeId && value.slot === request.slot &&
    value.sceneRevision === request.sceneRevision && value.byteLength === decodedBytes(request.dataBase64 as string);
}
/** Items come in the requested slot order; a slot without a thumbnail is left out. */
export function isPrevisThumbnailGetResponse(input: unknown, result: unknown): boolean {
  if (!previsSchemas['previs.thumbnail.get'].safeParse(input).success) return false;
  const parsed = thumbnailGetResponseSchema.safeParse(result);
  if (!parsed.success) return false;
  const request = input as {projectId: string; nodeId: string; slots: string[]}, value = parsed.data;
  const positions = value.items.map(item => request.slots.indexOf(item.slot));
  return value.projectId === request.projectId && value.nodeId === request.nodeId && positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)) &&
    value.items.every(item => item.byteLength === decodedBytes(item.dataBase64));
}
