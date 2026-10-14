/** Standalone parsing/reference math only. This is not project LUT support.
 * No file, URL, renderer, storage, colour-space detection or provider APIs.
 * See docs/CUBE-LUT-REFERENCE.md for the deliberately restricted profile.
 */
export const CUBE_3D_PROFILE = 'mioon-cube3d-normalized-tetrahedral-v1';
export const CUBE_3D_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  minSize: 2,
  maxSize: 65,
  lineBytes: 250,
  nonDataLines: 4096,
  numberCharacters: 64,
});

export type CubeRgb = readonly [number, number, number];
export type Cube3DMetadata = Readonly<{
  profileId: typeof CUBE_3D_PROFILE;
  size: number;
  title: string | null;
  domainMin: readonly [0, 0, 0];
  domainMax: readonly [1, 1, 1];
  rowCount: number;
  rowOrder: 'red-fastest';
  interpolation: 'tetrahedral';
  numericPrecision: 'float64';
}>;

// Opaque handles cannot be manufactured by typed consumers. The private table
// registry also rejects forged/JSON-cloned handles at runtime, in constant time.
declare const cube3DBrand: unique symbol;
export type Cube3D = Readonly<{metadata: Cube3DMetadata; [cube3DBrand]: true}>;
const tables = new WeakMap<Cube3D, Float64Array>();

export type Cube3DErrorCode = 'CUBE_INPUT_INVALID' | 'CUBE_RESOURCE_LIMIT' |
  'CUBE_ENCODING_INVALID' | 'CUBE_HEADER_INVALID' | 'CUBE_UNSUPPORTED_DIRECTIVE' |
  'CUBE_SIZE_INVALID' | 'CUBE_DOMAIN_UNSUPPORTED' | 'CUBE_NUMBER_INVALID' |
  'CUBE_ROW_INVALID' | 'CUBE_ROW_COUNT' | 'CUBE_OUTPUT_RANGE' |
  'CUBE_HANDLE_INVALID' | 'CUBE_RGB_INVALID' | 'CUBE_STRENGTH_INVALID';
export type Cube3DError = Error & {readonly code: Cube3DErrorCode; readonly line: number | null};

function failure(code: Cube3DErrorCode, line: number | null = null): Cube3DError {
  // Never echo source text, titles, paths or attacker-controlled directives.
  return Object.assign(new Error('The LUT does not satisfy the bounded 3D reference profile.'), {code, line});
}

const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
function parseNumber(token: string, line: number): number {
  if (token.length > CUBE_3D_LIMITS.numberCharacters || !numberToken.test(token))
    throw failure('CUBE_NUMBER_INVALID', line);
  const value = Number(token);
  // Reject overflow and a nonzero mantissa that silently underflows to zero.
  if (!Number.isFinite(value) || (value === 0 && /[1-9]/u.test(token.split(/[eE]/u)[0])))
    throw failure('CUBE_NUMBER_INVALID', line);
  return value === 0 ? 0 : value;
}

function parseRow(tokens: readonly string[], line: number): [number, number, number] {
  if (tokens.length !== 3) throw failure('CUBE_ROW_INVALID', line);
  return [parseNumber(tokens[0], line), parseNumber(tokens[1], line), parseNumber(tokens[2], line)];
}

/** Parse supplied text, never a filename/URL. Accepted characters are ASCII;
 * therefore the accepted source's UTF-8 byte count equals its string length.
 * Headers precede data; unknown/duplicate/mixed/shaper directives fail closed.
 */
export function parseCube3D(source: string): Cube3D {
  if (typeof source !== 'string') throw failure('CUBE_INPUT_INVALID');
  if (source.length > CUBE_3D_LIMITS.sourceBytes) throw failure('CUBE_RESOURCE_LIMIT');
  let size: number | undefined;
  let title: string | null = null;
  let table: Float64Array | undefined;
  let rowCount = 0, nonDataLines = 0, lineNumber = 0;
  const headers = new Set<string>();

  // Scan one bounded line at a time rather than splitting an entire source
  // into unbounded tokens/rows. The table is allocated only after size checks.
  for (let offset = 0; offset < source.length;) {
    lineNumber++;
    const newline = source.indexOf('\n', offset);
    const end = newline === -1 ? source.length : newline;
    const contentEnd = newline !== -1 && source.charCodeAt(end - 1) === 13 ? end - 1 : end;
    if (contentEnd - offset > CUBE_3D_LIMITS.lineBytes) throw failure('CUBE_RESOURCE_LIMIT', lineNumber);
    const raw = source.slice(offset, contentEnd);
    offset = newline === -1 ? source.length : newline + 1;
    if (/[^\x09\x20-\x7e]/u.test(raw)) throw failure('CUBE_ENCODING_INVALID', lineNumber);
    const line = raw.trim();
    const blankOrComment = !line || line.startsWith('#');
    const tokens = line.split(/[ \t]+/u);
    const directive = tokens[0];
    const header = ['TITLE', 'LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'].includes(directive);

    if (blankOrComment || header) {
      if (++nonDataLines > CUBE_3D_LIMITS.nonDataLines) throw failure('CUBE_RESOURCE_LIMIT', lineNumber);
      if (blankOrComment) continue;
      if (rowCount > 0 || headers.has(directive)) throw failure('CUBE_HEADER_INVALID', lineNumber);
      headers.add(directive);
      if (directive === 'TITLE') {
        const match = /^TITLE[ \t]+"([\x20-\x21\x23-\x7e]*)"$/u.exec(line);
        if (!match) throw failure('CUBE_HEADER_INVALID', lineNumber);
        title = match[1]; // Preserve literal spaces, # and backslashes; no escapes.
      } else if (directive === 'LUT_3D_SIZE') {
        if (tokens.length !== 2 || !/^[1-9]\d*$/u.test(tokens[1])) throw failure('CUBE_SIZE_INVALID', lineNumber);
        size = Number(tokens[1]);
        if (!Number.isSafeInteger(size) || size < CUBE_3D_LIMITS.minSize || size > CUBE_3D_LIMITS.maxSize)
          throw failure('CUBE_SIZE_INVALID', lineNumber);
        table = new Float64Array(size ** 3 * 3);
      } else {
        const domain = parseRow(tokens.slice(1), lineNumber);
        const required = directive === 'DOMAIN_MIN' ? 0 : 1;
        if (domain.some(value => value !== required)) throw failure('CUBE_DOMAIN_UNSUPPORTED', lineNumber);
      }
      continue;
    }

    // A directive must never be treated as ignorable metadata. Invalid numeric
    // words (NaN/Infinity included) are rejected too, without partial parsing.
    if (/^[A-Za-z_]/u.test(directive)) throw failure('CUBE_UNSUPPORTED_DIRECTIVE', lineNumber);
    if (size === undefined || table === undefined) throw failure('CUBE_HEADER_INVALID', lineNumber);
    if (rowCount === size ** 3) throw failure('CUBE_ROW_COUNT', lineNumber);
    const row = parseRow(tokens, lineNumber);
    if (row.some(value => value < 0 || value > 1)) throw failure('CUBE_OUTPUT_RANGE', lineNumber);
    table.set(row, rowCount * 3);
    rowCount++;
  }
  if (size === undefined || table === undefined) throw failure('CUBE_HEADER_INVALID');
  if (rowCount !== size ** 3) throw failure('CUBE_ROW_COUNT');
  const metadata: Cube3DMetadata = Object.freeze({
    profileId: CUBE_3D_PROFILE, size, title,
    domainMin: Object.freeze([0, 0, 0] as const),
    domainMax: Object.freeze([1, 1, 1] as const),
    rowCount, rowOrder: 'red-fastest', interpolation: 'tetrahedral', numericPrecision: 'float64',
  });
  const result = Object.freeze({metadata}) as Cube3D;
  tables.set(result, table);
  return result;
}

function requireTable(cube: Cube3D): Float64Array {
  const table = tables.get(cube);
  if (!table) throw failure('CUBE_HANDLE_INVALID');
  return table;
}

/** Deterministic semantic text, not a digest or proof of project ownership.
 * Header order, defaults, LF, round-trip decimal spelling and -0 are fixed.
 * Comments/spacing are discarded; title is preserved. Output ends in one LF.
 */
export function canonicalCube3D(cube: Cube3D): string {
  const table = requireTable(cube);
  const {size, title} = cube.metadata;
  const lines = title === null ? [] : [`TITLE "${title}"`];
  lines.push(`LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1');
  for (let index = 0; index < table.length; index += 3)
    lines.push(`${table[index]} ${table[index + 1]} ${table[index + 2]}`);
  return `${lines.join('\n')}\n`;
}

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const clampRoundoff = (value: number): number => Math.max(0, Math.min(1, value));

function snapshotRgb(rgb: CubeRgb): [number, number, number] {
  if (!Array.isArray(rgb) || Object.getOwnPropertyDescriptor(rgb, 'length')?.value !== 3)
    throw failure('CUBE_RGB_INVALID');
  const result: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const descriptor = Object.getOwnPropertyDescriptor(rgb, String(axis));
    // Never invoke coordinate accessors or caller-overridden array methods,
    // and never fill holes from inherited properties. Sample one stable copy.
    if (!descriptor || !('value' in descriptor) || !unit(descriptor.value)) throw failure('CUBE_RGB_INVALID');
    result[axis] = descriptor.value;
  }
  return result;
}

/** Reference tetrahedral sampling in caller-supplied normalized RGB code
 * values, followed by componentwise input*(1-strength) + mapped*strength.
 * No transfer/primaries conversion, alpha handling, extrapolation or renderer.
 * Invalid input/strength fails even at strength zero; zero is exact bypass.
 */
export function sampleCube3D(cube: Cube3D, rgb: CubeRgb, strength = 1): CubeRgb {
  const table = requireTable(cube);
  const input = snapshotRgb(rgb);
  if (!unit(strength)) throw failure('CUBE_STRENGTH_INVALID');
  if (strength === 0) return Object.freeze(input);

  const size = cube.metadata.size;
  const position = input.map(value => value * (size - 1));
  // At the top face choose the last cell with fraction 1, never an index N.
  const low = position.map(value => Math.min(Math.floor(value), size - 2));
  const fraction = position.map((value, axis) => value - low[axis]);
  // Descending fractions pick one of six tetrahedra on the 000--111 diagonal.
  // Ties are R then G then B, explicitly independent of sort stability.
  const axes = [0, 1, 2].sort((a, b) => fraction[b] - fraction[a] || a - b);
  const [a, b, c] = axes;
  const weights = [1 - fraction[a], fraction[a] - fraction[b], fraction[b] - fraction[c], fraction[c]];
  const stride = [1, size, size * size];
  const first = low[0] + size * low[1] + size * size * low[2];
  const vertices = [first, first + stride[a], first + stride[a] + stride[b], first + 1 + size + size * size];
  const output: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    let mapped = 0;
    for (let corner = 0; corner < 4; corner++) mapped += weights[corner] * table[vertices[corner] * 3 + channel];
    mapped = clampRoundoff(mapped);
    output[channel] = strength === 1 ? mapped : clampRoundoff(input[channel] * (1 - strength) + mapped * strength);
  }
  return Object.freeze(output);
}
