import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {createClient, workspaceOriginOptions, schemas, operationDefinition, discoverySchemas, discoveryEffects, effectAnnotations, discoverSchema, validateDiscovery, jsonSchema, successEnvelope, errorEnvelope, ClientError, VERSION} from '@mioon/client';

import {translate} from '@mioon/i18n';
import {localizeToolDescription} from '@mioon/i18n/presentation';

import {localizedLaunchOptions} from './launch-presentation.ts';
const displayErrors = new WeakMap();
function launchFailure(text, key) {
  const error = new ClientError('VALIDATION_ERROR', text);
  displayErrors.set(error, key);
  throw error;
}

// Use the official SDK's low-level tool handlers deliberately: validation failures
// and backend errors share the same safe, structured result envelope as the CLI.
// No backend or credentials are required just to initialize/list/schema-discover.
function launchOptions(argv, onLocale) {
  // Preserve every legacy launch diagnostic when no presentation option is used.
  if (!argv.some(argument => argument === '--locale' || argument.startsWith('--locale='))) {
    let origin, supplied = false;
    for (let index = 0; index < argv.length; index++) {
      const argument = argv[index];
      if (supplied || !(argument === '--workspace-origin' || argument.startsWith('--workspace-origin=')))
        throw new ClientError('VALIDATION_ERROR', 'MCP accepts only one optional --workspace-origin UUID at process launch.');
      supplied = true;
      origin = argument === '--workspace-origin' ? argv[++index] : argument.slice('--workspace-origin='.length);
      if (origin === undefined) throw new ClientError('VALIDATION_ERROR', '--workspace-origin requires an explicit UUID.');
    }
    return Object.freeze({invocation: Object.freeze(workspaceOriginOptions(origin)), locale: undefined});
  }
  return localizedLaunchOptions(argv, value => {
    try { return workspaceOriginOptions(value); }
    catch (error) { displayErrors.set(error, 'mcp.error.origin'); throw error; }
  }, launchFailure, onLocale);
}
let invocation, locale;
try { ({invocation, locale} = launchOptions(process.argv.slice(2), value => { locale = value; })); }
catch (error) {
  const envelope = errorEnvelope(error);
  const key = displayErrors.get(error);
  process.stderr.write(`${envelope.error.code}: ${locale === undefined || !key ? envelope.error.message : translate(locale, key)}\n`);
  process.exit(2);
}
// Immutable for this process. Connection/token reloads never update this pin.
const client = createClient();
const tools = new Map(Object.keys(schemas).map(operation => {
  const definition = operationDefinition(operation);
  return [definition.toolName, {
    name: definition.toolName,
    description: localizeToolDescription(operation, definition.description, locale),
    inputSchema: definition.inputSchema,
    annotations: effectAnnotations(definition.effects),
    call: (input, options) => client.rpc(operation, input, options),
  }];
}));
for (const [name, description, call] of [
  ['doctor', 'Check authenticated local backend readiness and provider capabilities without revealing credential paths or tokens.', (_, options) => client.doctor(options)],
  ['capabilities', 'List current configured provider and per-model capabilities from the running backend. This does not submit generation.', (_, options) => client.capabilities(options)],
  ['schema', 'Discover exact shared RPC JSON Schemas, stable requestId requirements, and advisory operation effects. Works without a running backend.', input => discoverSchema(input)],
]) tools.set(`mioon_${name}`, {name: `mioon_${name}`, description: locale === undefined ? description : translate(locale, `mcp.${name}`), inputSchema: jsonSchema(discoverySchemas[name]), annotations: effectAnnotations(discoveryEffects[name]), call: (input, options) => call(validateDiscovery(name, input), options)});

const server = new Server({name: 'mioon', version: VERSION}, {
  capabilities: {tools: {}},
  instructions: locale === undefined ? 'All operations use one existing local backend and shared schemas. Prefer project_inspect, asset_inspect, shot_inspect and timeline_inspect for bounded, non-creating metadata inspection. Legacy project_get and timeline_get may initialize an empty timeline. Effect annotations are advisory, not authorization. Preserve the exact requestId and input on retry after an uncertain response. Never invent a new requestId to recover an unknown submission, automatically retry paid generation, or assume local job.cancel cancelled a remote provider job. Use provider_list before choosing models. Desktop connection files are re-read per request; credentials must never enter tool arguments. Restored workspace effectful calls require an explicit --workspace-origin UUID pinned at process launch. workspace_restore_inspect is read-only disclosure; it never authorizes or updates this process pin. Do not use a new origin to recover captured tasks or uncertain requests.' : translate(locale, 'mcp.instructions'),
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [...tools.values()].map(({call, ...definition}) => definition)}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  let result;
  try {
    const tool = tools.get(request.params.name);
    if (!tool) throw new ClientError('UNKNOWN_OPERATION', 'Unknown tool. Use tools/list to discover supported tools.');
    result = successEnvelope(await tool.call(request.params.arguments ?? {}, {signal: extra.signal, ...invocation}));
  } catch (error) { result = errorEnvelope(error); }
  return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result, isError: !result.ok};
});
try { await server.connect(new StdioServerTransport()); }
catch { process.stderr.write(`${locale === undefined ? 'Mioon MCP could not start the stdio transport.' : translate(locale, 'mcp.error.transport')}\n`); process.exitCode = 1; }
