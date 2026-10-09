import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createClient, schemas, operationDefinition, discoverySchemas, discoveryEffects, effectAnnotations, discoverSchema, validateDiscovery, jsonSchema, successEnvelope, errorEnvelope, ClientError, VERSION} from '@mioon/client';

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
    annotations: effectAnnotations(definition.effects),
    call: (input, options) => client.rpc(operation, input, options),
  }];
}));
for (const [name, description, call] of [
  ['doctor', 'Check authenticated local backend readiness and provider capabilities without revealing credential paths or tokens.', (_, options) => client.doctor(options)],
  ['capabilities', 'List current configured provider and per-model capabilities from the running backend. This does not submit generation.', (_, options) => client.capabilities(options)],
  ['schema', 'Discover exact shared RPC JSON Schemas, stable requestId requirements, and advisory operation effects. Works without a running backend.', input => discoverSchema(input)],
]) tools.set(`mioon_${name}`, {name: `mioon_${name}`, description, inputSchema: jsonSchema(discoverySchemas[name]), annotations: effectAnnotations(discoveryEffects[name]), call: (input, options) => call(validateDiscovery(name, input), options)});

const server = new Server({name: 'mioon', version: VERSION}, {
  capabilities: {tools: {}},
  instructions: 'All operations use one existing local backend and shared schemas. Prefer project_inspect, asset_inspect, shot_inspect and timeline_inspect for bounded, non-creating metadata inspection. Legacy project_get and timeline_get may initialize an empty timeline. Effect annotations are advisory, not authorization. Preserve the exact requestId and input on retry after an uncertain response. Never invent a new requestId to recover an unknown submission, automatically retry paid generation, or assume local job.cancel cancelled a remote provider job. Use provider_list before choosing models. Desktop connection files are re-read per request; credentials must never enter tool arguments.',
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
catch { process.stderr.write('Mioon MCP could not start the stdio transport.\n'); process.exitCode = 1; }
