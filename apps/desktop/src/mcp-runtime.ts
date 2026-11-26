import {runInCliUtility} from './cli-runtime-stdio.ts';

runInCliUtility(async stdin => {
  const [{runMcp}, {DrainingMcpTransport}] = await Promise.all([
    import('../../mcp/src/run.ts'), import('../../mcp/src/stdio-drain.ts'),
  ]);
  const transport = new DrainingMcpTransport(stdin);
  const server = await runMcp(transport);
  if (server) {
    await transport.drained;
    await server.close();
  }
}, 'Mioon MCP could not start the desktop runtime.');
