import {z} from 'zod';

const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
function invalid(): never {
  throw Object.assign(new Error('Invalid frozen timeline delivery name'), {code: 'INVALID_TIMELINE_SNAPSHOT'});
}

// Display metadata is exact, never trimmed, normalized, or inferred from project
// state. 120 UTF-16 units imply at most 360 UTF-8 bytes (within the 480-byte cap).
export const timelineDeliveryNameSchema = z.string().min(1).max(120)
  .regex(/\S/u, 'Delivery name must not be blank')
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$(?![\s\S])/u, 'Delivery name must not contain control or line characters')
  .regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/, 'Delivery name must contain valid Unicode');
export type TimelineDeliveryNameInput = {deliveryName?: string};

export function isTimelineDeliveryNameInput(value: unknown, purpose?: unknown): value is TimelineDeliveryNameInput {
  return object(value) && (!own(value, 'deliveryName') ||
    (purpose === undefined || purpose === 'export') && timelineDeliveryNameSchema.safeParse(value.deliveryName).success);
}

export function timelineDeliveryNameFields(value: unknown): TimelineDeliveryNameInput {
  if (!isTimelineDeliveryNameInput(value)) invalid();
  return own(value, 'deliveryName') ? {deliveryName: timelineDeliveryNameSchema.parse(value.deliveryName)} : {};
}

export function isTimelineDeliveryNameSnapshot(snapshot: unknown, options: {purpose?: unknown; input?: unknown} = {}): boolean {
  if (!object(snapshot) || !isTimelineDeliveryNameInput(snapshot)) return false;
  if (own(snapshot, 'deliveryName') && own(options, 'purpose') && options.purpose !== 'export') return false;
  if (!own(options, 'input')) return true;
  if (!isTimelineDeliveryNameInput(options.input)) return false;
  return own(snapshot, 'deliveryName') === own(options.input, 'deliveryName') &&
    snapshot.deliveryName === options.input.deliveryName;
}

// Receipt reconstruction must preserve own-property presence independently for
// the display title and the opt-in encoding profile. Never synthesize undefined.
export function timelineRenderDeliveryFields(snapshot: unknown): TimelineDeliveryNameInput & {exportSettings?: unknown} {
  if (!object(snapshot)) invalid();
  const result: TimelineDeliveryNameInput & {exportSettings?: unknown} = timelineDeliveryNameFields(snapshot);
  if (own(snapshot, 'delivery')) {
    if (!object(snapshot.delivery) || !own(snapshot.delivery, 'exportSettings')) invalid();
    result.exportSettings = snapshot.delivery.exportSettings;
  }
  return result;
}

export function hasTimelineDeliveryIdentity(record: unknown): boolean {
  return object(record) && object(record.snapshot) &&
    (own(record.snapshot, 'delivery') || own(record.snapshot, 'deliveryName'));
}

// SQL only reports whether a bounded original receipt contains either optional
// immutable field. It never extracts or trusts that receipt's metadata here.
export const TIMELINE_DELIVERY_RECEIPT_SQL = "COALESCE(json_type(response,'$.snapshot.delivery'),json_type(response,'$.snapshot.deliveryName'))";

function boundedText(value: string, maxUnits: number, maxBytes: number): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > maxUnits || encoder.encode(result + character).length > maxBytes) break;
    result += character;
  }
  return result;
}

function filenameStem(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, '_')
    .replace(/^[. ]+|[. ]+$/gu, '');
  // The extension is exclusively ours, even if the display title resembles one.
  const stem = safe.replace(/(?:\.[A-Za-z0-9]{1,16})+$/u, '').replace(/[. ]+$/u, '') || 'export';
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(stem) ? `_${stem}` : stem;
}

export function timelineDeliveryBasename(deliveryName: string, exportId: string): string {
  if (!timelineDeliveryNameSchema.safeParse(deliveryName).success ||
      typeof exportId !== 'string' || exportId.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(exportId)) invalid();
  const suffix = `-${exportId.slice(-12).toLowerCase()}.mp4`;
  const stem = boundedText(filenameStem(deliveryName), 160 - suffix.length, 180 - encoder.encode(suffix).length).replace(/[. ]+$/u, '') || 'export';
  return stem + suffix;
}

export function timelineDeliveryContentDisposition(deliveryName: string, exportId: string): string {
  return dispositionForBasename(timelineDeliveryBasename(deliveryName, exportId));
}

function dispositionForBasename(basename: string): string {
  const fallback = basename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  const encoded = encodeURIComponent(basename).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Desktop clients accept only the exact canonical download spelling. Full
// export/asset binding is verified by the transport before this parser is used.
export function parseTimelineDeliveryContentDisposition(header: unknown, exportId: string): string | null {
  if (typeof header !== 'string' || header.length > 1500 ||
      typeof exportId !== 'string' || exportId.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(exportId)) return null;
  const matched = /^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''([^;\s]+)$/u.exec(header);
  if (!matched) return null;
  let basename: string;
  try { basename = decodeURIComponent(matched[1] as string); } catch { return null; }
  const suffix = `-${exportId.slice(-12).toLowerCase()}.mp4`;
  if (!basename.endsWith(suffix) || basename.length > 160 || encoder.encode(basename).length > 180) return null;
  const stem = basename.slice(0, -suffix.length);
  if (!stem || /^[. ]|[. ]$/u.test(stem) ||
      /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(stem) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(stem) ||
      !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(stem)) return null;
  return header === dispositionForBasename(basename) ? basename : null;
}
