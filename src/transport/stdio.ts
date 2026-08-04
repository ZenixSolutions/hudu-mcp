/**
 * stdio transport.
 *
 * The transport knows nothing about Hudu and the domain knows nothing about the
 * transport; swapping in Streamable HTTP later is a change confined to this
 * directory.
 *
 * One rule matters more than the rest here: on stdio, stdout is the protocol
 * channel. Anything written to it that is not a JSON-RPC frame corrupts the
 * session. All diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { BuiltServer } from '../server.js';

export async function runStdio(built: BuiltServer): Promise<void> {
  const transport = new StdioServerTransport();
  await built.server.connect(transport);

  const mode = built.config.readOnly ? 'read-only' : 'read-write';
  process.stderr.write(
    `hudu-mcp: connected over stdio in ${mode} mode; ` +
      `${built.tools.length} tool(s) registered, ${built.withheld.length} withheld.\n`,
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(`hudu-mcp: received ${signal}, shutting down.\n`);
    void built.server.close().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
