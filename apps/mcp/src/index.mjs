import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createClient, schemas, operationDefinition, discoverySchemas, discoverSchema, validateDiscovery, jsonSchema, successEnvelope, errorEnvelope, ClientError, VERSION} from '@video-workbench/client';

// Use the official SDK's low-level tool handlers deliberately: validation failures
// and backend errors share the same safe, structured result envelope as the CLI.
// No backend or credentials are required just to initialize/list/schema-discover.
const client = createClient();
const tools = new Map(Object.keys(schemas).map(operation => {
  const definition = operationDefinition(operation);
  return [definition.toolName, {
    name: definition.toolName,
    description: definition.description,
    inputSchema: definition.inputSchema,
    annotations: {readOnlyHint: operation.endsWith('.list') || (operation.endsWith('.get') && operation !== 'timeline.get'), destructiveHint: operation === 'edge.delete' || operation === 'timeline.clip.remove', idempotentHint: definition.requiresRequestId || operation.endsWith('.list') || operation.endsWith('.get'), openWorldHint: ['generation.submit', 'job.retry', 'job.reconcile'].includes(operation)},
    call: (input, options) => client.rpc(operation, input, options),
  }];
}));
for (const [name, description, call] of [
  ['doctor', 'Check authenticated local backend readiness and provider capabilities without revealing credential paths or tokens.', (_, options) => client.doctor(options)],
  ['capabilities', 'List current configured provider and per-model capabilities from the running backend. This does not submit generation.', (_, options) => client.capabilities(options)],
  ['schema', 'Discover exact shared RPC JSON Schemas and stable requestId requirements. Works without a running backend.', input => discoverSchema(input)],
]) tools.set(`workbench_${name}`, {name: `workbench_${name}`, description, inputSchema: jsonSchema(discoverySchemas[name]), annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}, call: (input, options) => call(validateDiscovery(name, input), options)});

const server = new Server({name: 'video-workbench', version: VERSION}, {
  capabilities: {tools: {}},
  instructions: 'All operations use one existing local backend and shared schemas. Preserve the exact requestId and input on retry after an uncertain response. Never invent a new requestId to recover an unknown submission, automatically retry paid generation, or assume local job.cancel cancelled a remote provider job. Use provider_list before choosing models. Desktop connection files are re-read per request; credentials must never enter tool arguments.',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [...tools.values()].map(({call, ...definition}) => definition)}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  let result;
  try {
    const tool = tools.get(request.params.name);
    if (!tool) throw new ClientError('UNKNOWN_OPERATION', 'Unknown tool. Use tools/list to discover supported tools.');
    result = successEnvelope(await tool.call(request.params.arguments ?? {}, {signal: extra.signal}));
  } catch (error) { result = errorEnvelope(error); }
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, isError: !result.ok};
});
try { await server.connect(new StdioServerTransport()); }
catch { process.stderr.write('Video Workbench MCP could not start the stdio transport.\n'); process.exitCode = 1; }
