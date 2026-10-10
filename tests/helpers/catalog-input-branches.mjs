import assert from 'node:assert/strict';
import {schemas} from '@mioon/contracts';
import {jsonSchema} from '../../packages/client/src/index.mjs';

// Keep the union tree: each branch must match its corresponding Zod object,
// in order. Never merge properties or skip an unfamiliar input schema.
export function objectShape(schema) {
  assert.ok(schema && schema._def, 'A registered Zod input schema is required');
  const source = schema;
  while (schema._def.typeName === 'ZodEffects') schema = schema._def.schema;
  if (schema._def.typeName === 'ZodUnion') {
    assert.ok(Array.isArray(schema._def.options) && schema._def.options.length > 0);
    return {kind: 'union', source, branches: schema._def.options.map(objectShape)};
  }
  assert.equal(schema._def.typeName, 'ZodObject', 'Public inputs must be objects or object unions');
  assert.equal(schema._def.unknownKeys, 'strict', 'Every public input object must reject extras');
  return {kind: 'object', source, shape: schema.shape};
}

function resolved(value, root, references = new Set()) {
  if (Array.isArray(value)) return value.map(item => resolved(item, root, references));
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$ref')) {
    assert.equal(typeof value.$ref, 'string');
    assert.ok(value.$ref.startsWith('#/'), 'Catalog references must be local JSON pointers');
    assert.ok(!references.has(value.$ref), 'Catalog input reference must not be cyclic');
    let target = root;
    for (const segment of value.$ref.slice(2).split('/')) {
      const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
      assert.ok(target && Object.hasOwn(target, key), `Missing catalog reference ${value.$ref}`);
      target = target[key];
    }
    const next = new Set(references); next.add(value.$ref);
    const {$ref, ...siblings} = value;
    return {...resolved(target, root, next), ...resolved(siblings, root, references)};
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema')
    .map(([key, item]) => [key, resolved(item, root, references)]));
}

export function assertOperationInputBranches(definition) {
  assert.ok(Object.hasOwn(schemas, definition.operation), `Unknown catalog operation ${definition.operation}`);
  const root = definition.inputSchema, leaves = [];
  function compare(actual, expected, label) {
    assert.equal(actual.type, 'object', `${label} object input`);
    if (expected.kind === 'union') {
      assert.ok(Array.isArray(actual.anyOf), `${label} retains explicit union branches`);
      assert.equal(actual.anyOf.length, expected.branches.length, `${label} branch count`);
      assert.equal(Object.hasOwn(actual, 'properties'), false, `${label} must not flatten branch properties`);
      assert.equal(Object.hasOwn(actual, 'oneOf'), false, `${label} exact anyOf representation`);
      expected.branches.forEach((branch, index) => compare(actual.anyOf[index], branch, `${label} branch ${index}`));
      return;
    }
    assert.equal(actual.additionalProperties, false, `${label} rejects extra properties`);
    assert.ok(actual.properties && typeof actual.properties === 'object' && !Array.isArray(actual.properties));
    assert.deepEqual(Object.keys(actual.properties).sort(), Object.keys(expected.shape).sort(), `${label} exact fields`);
    const required = Object.entries(expected.shape).filter(([, field]) => !field.safeParse(undefined).success)
      .map(([name]) => name).sort();
    assert.deepEqual([...(actual.required || [])].sort(), required, `${label} required fields`);
    const standalone = jsonSchema(expected.source);
    assert.deepEqual(resolved(actual, root), resolved(standalone, standalone), `${label} exact branch constraints/order`);
    leaves.push({properties: actual.properties, required});
  }
  compare(root, objectShape(schemas[definition.operation]), definition.operation);
  const requiresRequestId = leaves.every(branch => branch.required.includes('requestId'));
  assert.equal(definition.requiresRequestId, requiresRequestId, `${definition.operation} common required request key`);
  return {branches: leaves, requiresRequestId,
    optionalRequestId: !requiresRequestId && leaves.some(branch => Object.hasOwn(branch.properties, 'requestId'))};
}

export function optionalRequestIdOperations(catalog) {
  assert.deepEqual(catalog.operations.map(item => item.operation).sort(), Object.keys(schemas).sort(), 'Complete catalog is audited');
  return catalog.operations.filter(definition => assertOperationInputBranches(definition).optionalRequestId)
    .map(definition => definition.operation).sort();
}
