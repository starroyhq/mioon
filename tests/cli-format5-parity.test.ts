import test from 'node:test';
import assert from 'node:assert/strict';
import {publicOperationSchemas} from '../packages/contracts/src/public-operations.ts';
import {operationDefinition} from '../packages/client/src/index.ts';
import {isMcpOperationAllowed} from '../apps/mcp/src/tool-policy.ts';
import {listAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';

/** Each format-5 Mio tool and its CLI/MCP counterpart. Public history
 * commands take their cursor from the caller. */
const MIO_TO_PUBLIC: Readonly<Record<string,string>> = Object.freeze({
  'sequence.tool.edit':'sequence.action.edit',
  'sequence.tool.board':'sequence.board.edit',
  'sequence.tool.reference':'sequence.reference.edit',
  'sequence.tool.subject':'sequence.subject.edit',
  'sequence.tool.previs':'sequence.previs.edit',
  'sequence.tool.timeline':'sequence.timeline.edit',
  'sequence.tool.clip':'sequence.clip.edit',
  'sequence.tool.undo':'sequence.undo',
  'sequence.inspect':'sequence.inspect',
  'sequence.board.get':'sequence.board.get',
  'sequence.generation-inputs.get':'sequence.generation-inputs.get',
  'clip.audio.export':'clip.audio.export',
});
const HOST_FIELDS = new Set(['projectId','requestId']);
const properties = (schema: unknown): string[] =>
  schema && typeof schema === 'object' && 'properties' in schema && schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties as Record<string,unknown>).filter(key => !HOST_FIELDS.has(key)).sort() : [];
const required = (schema: unknown): unknown[] =>
  schema && typeof schema === 'object' && Array.isArray((schema as {required?:unknown[]}).required)
    ? (schema as {required:unknown[]}).required.filter(field => !HOST_FIELDS.has(String(field))) : [];
const branches = (schema: unknown): Record<string,unknown>[] => {
  if (!schema || typeof schema !== 'object') return [];
  const value = schema as {anyOf?:unknown[]; oneOf?:unknown[]};
  return [...(Array.isArray(value.anyOf) ? value.anyOf : []), ...(Array.isArray(value.oneOf) ? value.oneOf : [])]
    .filter((item):item is Record<string,unknown> => Boolean(item && typeof item === 'object'));
};
const actionKinds = (schema: unknown): string[] => branches(schema).map(branch => {
  const kind = (branch.properties as {kind?:{const?:unknown}} | undefined)?.kind?.const;
  return typeof kind === 'string' ? kind : '';
}).filter(Boolean).sort();

test('every Mio format-5 tool has one CLI/MCP operation, including new tools', () => {
  const tools = listAgentTaskTools(false,true).filter(tool => Object.hasOwn(MIO_TO_PUBLIC, tool.operation));
  const expected = listAgentTaskTools(false,true).filter(tool =>
    tool.operation.startsWith('sequence.') || tool.operation==='clip.audio.export').map(tool => tool.operation).sort();
  assert.deepEqual(tools.map(tool => tool.operation).sort(), expected);
  assert.deepEqual(Object.keys(MIO_TO_PUBLIC).sort(), expected);
  for (const [mioOperation, publicOperation] of Object.entries(MIO_TO_PUBLIC)) {
    assert.ok(Object.hasOwn(publicOperationSchemas, publicOperation), `${mioOperation} -> ${publicOperation}`);
    assert.equal(isMcpOperationAllowed(publicOperation), true, `${publicOperation} must appear in MCP tools/list`);
    const definition = operationDefinition(publicOperation);
    assert.equal(definition.command, publicOperation.replaceAll('.', ' '));
    assert.equal(definition.toolName, publicOperation.replaceAll('.', '_'));
  }
});

test('action wrappers reuse the exact Mio action branches; only host projectId/requestId differ', () => {
  for (const tool of listAgentTaskTools(false,true,true)) {
    const publicOperation = MIO_TO_PUBLIC[tool.operation];
    if (!publicOperation || !tool.operation.startsWith('sequence.tool.') || tool.operation==='sequence.tool.undo') continue;
    const publicSchema = operationDefinition(publicOperation).inputSchema;
    assert.deepEqual(actionKinds(tool.parameters), actionKinds(publicSchema), tool.operation);
    const mioBranches = branches(tool.parameters), publicBranches = branches(publicSchema);
    for (const branch of mioBranches) {
      const kind = (branch.properties as {kind?:{const?:unknown}} | undefined)?.kind?.const;
      const match = publicBranches.find(candidate =>
        (candidate.properties as {kind?:{const?:unknown}} | undefined)?.kind?.const===kind);
      assert.ok(match, `${tool.operation}:${String(kind)}`);
      assert.deepEqual(properties(match), properties(branch), `${tool.operation}:${String(kind)}`);
      assert.deepEqual(required(match), required(branch), `${tool.operation}:${String(kind)}`);
    }
  }
});

test('Mio exposes saved asset ranges in both formats and gates project FPS editing', () => {
  const timeline = (format6Development: boolean) => listAgentTaskTools(false, true, format6Development)
    .find(tool => tool.operation === 'sequence.tool.timeline');
  const branch = (format6Development: boolean) => branches(timeline(format6Development)?.parameters)
    .find(item => (item.properties as {kind?: {const?: unknown}} | undefined)?.kind?.const === 'insert-asset');
  assert.equal(properties(branch(false)).includes('assetRange'), true);
  assert.equal(properties(branch(true)).includes('assetRange'), true);
  assert.match(timeline(false)!.description, /assetRange/u);
  assert.match(timeline(true)!.description, /assetRange/u);
  assert.doesNotMatch(timeline(false)!.description, /fps-set/u);
  assert.match(timeline(true)!.description, /fps-set/u);
});

test('public undo and redo require a named action and exact cursor; Mio supplies its own cursor', () => {
  const mioUndo = listAgentTaskTools(false,true).find(tool => tool.operation==='sequence.tool.undo');
  assert.ok(mioUndo);
  assert.deepEqual(properties(mioUndo.parameters), ['actionId']);
  assert.deepEqual(required(mioUndo.parameters), []);
  assert.equal(Object.hasOwn(publicOperationSchemas, 'sequence.undo-action'), false);

  const request = {projectId: '10000000-0000-4000-8000-000000000001',
    actionId: '10000000-0000-4000-8000-000000000002', requestId: 'history-request-1',
    expected: {position: 1, revision: 2}};
  for (const operation of ['sequence.undo', 'sequence.redo'] as const) {
    const schema = publicOperationSchemas[operation];
    assert.equal(isMcpOperationAllowed(operation), true);
    assert.equal(schema.safeParse(request).success, true);
    for (const field of ['projectId', 'actionId', 'requestId', 'expected'] as const) {
      assert.equal(schema.safeParse({...request, [field]: undefined}).success, false, `${operation} requires ${field}`);
    }
    assert.equal(schema.safeParse({...request, expected: {position: 1}}).success, false);
    assert.equal(schema.safeParse({...request, expected: {revision: 2}}).success, false);
  }
});

test('read and non-action format-5 wrappers keep their bounded fields', () => {
  for (const operation of ['sequence.inspect','sequence.board.get','sequence.generation-inputs.get']) {
    const tool = listAgentTaskTools(false,true).find(item => item.operation===operation);
    assert.ok(tool, operation);
    const publicSchema = operationDefinition(operation).inputSchema;
    assert.deepEqual(properties(publicSchema), properties(tool.parameters), operation);
    assert.deepEqual(required(publicSchema).sort(), required(tool.parameters).sort(), operation);
  }
});
