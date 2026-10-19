import assert from 'node:assert/strict';
import {schemas} from '@mioon/contracts';
import {jsonSchema} from '../../packages/client/src/index.ts';

interface ZodDefLike {readonly typeName?: string; readonly schema?: ZodLike; readonly options?: readonly ZodLike[]; readonly unknownKeys?: string; readonly [key: string]: unknown}
interface ZodLike {readonly _def: ZodDefLike; readonly shape?: Record<string, ZodLike>; safeParse(value: unknown): {success: boolean}}
type ObjectShape =
  | {kind: 'union'; source: ZodLike; branches: ObjectShape[]}
  | {kind: 'object'; source: ZodLike; shape: Record<string, ZodLike>};
export interface CatalogOperationDefinition {
  readonly operation: string;
  readonly requiresRequestId?: unknown;
  readonly inputSchema: unknown;
}
export interface CatalogOperationBranchResult {
  readonly branches: {properties: Record<string, unknown>; required: string[]}[];
  readonly requiresRequestId: boolean;
  readonly optionalRequestId: boolean;
}
export interface InputCatalog {readonly operations: readonly CatalogOperationDefinition[]}

// Keep the union tree: each branch must match its corresponding Zod object,
// in order. Never merge properties or skip an unfamiliar input schema.
export function objectShape(schema: ZodLike): ObjectShape {
  assert.ok(schema && schema._def, 'A registered Zod input schema is required');
  const source = schema;
  let current: ZodLike = schema;
  while (current._def.typeName === 'ZodEffects' && current._def.schema) current = current._def.schema;
  if (current._def.typeName === 'ZodUnion') {
    assert.ok(Array.isArray(current._def.options) && current._def.options.length > 0);
    return {kind: 'union', source, branches: current._def.options.map((option: ZodLike) => objectShape(option))};
  }
  assert.equal(current._def.typeName, 'ZodObject', 'Public inputs must be objects or object unions');
  assert.equal(current._def.unknownKeys, 'strict', 'Every public input object must reject extras');
  return {kind: 'object', source, shape: current.shape ?? {}};
}

function resolved(value: unknown, root: unknown, references: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => resolved(item, root, references));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, '$ref')) {
    assert.equal(typeof record.$ref, 'string');
    const reference = record.$ref as string;
    assert.ok(reference.startsWith('#/'), 'Catalog references must be local JSON pointers');
    assert.ok(!references.has(reference), 'Catalog input reference must not be cyclic');
    let target: unknown = root;
    for (const segment of reference.slice(2).split('/')) {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      assert.ok(target && typeof target === 'object' && Object.hasOwn(target, key), `Missing catalog reference ${reference}`);
      target = (target as Record<string, unknown>)[key];
    }
    const next = new Set(references); next.add(reference);
    const {$ref: _ref, ...siblings} = record;
    return {...resolved(target, root, next) as Record<string, unknown>, ...resolved(siblings, root, references) as Record<string, unknown>};
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$schema')
    .map(([key, item]) => [key, resolved(item, root, references)]));
}

export function assertOperationInputBranches(definition: CatalogOperationDefinition): CatalogOperationBranchResult {
  assert.ok(Object.hasOwn(schemas, definition.operation), `Unknown catalog operation ${definition.operation}`);
  const root = definition.inputSchema, leaves: {properties: Record<string, unknown>; required: string[]}[] = [];
  function compare(actual: unknown, expected: ObjectShape, label: string): void {
    const actualObject = actual as Record<string, unknown>;
    assert.equal(actualObject.type, 'object', `${label} object input`);
    if (expected.kind === 'union') {
      assert.ok(Array.isArray(actualObject.anyOf), `${label} retains explicit union branches`);
      const branches = actualObject.anyOf as unknown[];
      assert.equal(branches.length, expected.branches.length, `${label} branch count`);
      assert.equal(Object.hasOwn(actualObject, 'properties'), false, `${label} must not flatten branch properties`);
      assert.equal(Object.hasOwn(actualObject, 'oneOf'), false, `${label} exact anyOf representation`);
      expected.branches.forEach((branch: ObjectShape, index: number) => compare(branches[index], branch, `${label} branch ${index}`));
      return;
    }
    assert.equal(actualObject.additionalProperties, false, `${label} rejects extra properties`);
    const properties = actualObject.properties as Record<string, unknown> | undefined;
    assert.ok(properties && typeof properties === 'object' && !Array.isArray(properties));
    assert.deepEqual(Object.keys(properties).sort(), Object.keys(expected.shape).sort(), `${label} exact fields`);
    const required = Object.entries(expected.shape).filter(([, field]) => !field.safeParse(undefined).success)
      .map(([name]) => name).sort();
    assert.deepEqual([...(actualObject.required as unknown[] || [])].sort(), required, `${label} required fields`);
    const standalone = jsonSchema(expected.source as never);
    assert.deepEqual(resolved(actual, root), resolved(standalone, standalone), `${label} exact branch constraints/order`);
    leaves.push({properties, required});
  }
  compare(root, objectShape(schemas[definition.operation as keyof typeof schemas] as unknown as ZodLike), definition.operation);
  const requiresRequestId = leaves.every(branch => branch.required.includes('requestId'));
  assert.equal(definition.requiresRequestId, requiresRequestId, `${definition.operation} common required request key`);
  return {branches: leaves, requiresRequestId,
    optionalRequestId: !requiresRequestId && leaves.some(branch => Object.hasOwn(branch.properties, 'requestId'))};
}

export function optionalRequestIdOperations(catalog: InputCatalog): string[] {
  assert.deepEqual(catalog.operations.map((item: CatalogOperationDefinition) => item.operation).sort(), Object.keys(schemas).sort(), 'Complete catalog is audited');
  return catalog.operations.filter((definition: CatalogOperationDefinition) => assertOperationInputBranches(definition).optionalRequestId)
    .map((definition: CatalogOperationDefinition) => definition.operation).sort();
}
