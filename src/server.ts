/**
 * Server construction.
 *
 * `buildServer` is a factory rather than a side effect of importing this
 * module. That is what makes the server testable in-process: a test can build
 * one against a fake fetch, list its tools, and call them, without a
 * subprocess, a socket, or a real Hudu instance.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { HuduClient, type HuduClientDeps } from './api/client.js';
import { type Config, loadConfig } from './config.js';
import { executeTool, prepareTool, type PreparedTool, shouldRegister } from './tools/define.js';
import { allToolDefinitions } from './tools/index.js';

export const SERVER_NAME = 'hudu-mcp-server';
export const SERVER_VERSION = '0.1.0';

export interface BuildServerOptions {
  readonly config?: Config;
  readonly env?: NodeJS.ProcessEnv;
  readonly deps?: HuduClientDeps;
}

export interface BuiltServer {
  readonly server: McpServer;
  readonly config: Config;
  readonly client: HuduClient;
  /** Tools actually registered under this configuration. */
  readonly tools: readonly PreparedTool[];
  /** Tools withheld, with the reason — used by diagnostics and by tests. */
  readonly withheld: readonly { name: string; reason: string }[];
}

function withholdReason(tool: ReturnType<typeof prepareTool>, config: Config): string {
  if (config.readOnly) return 'HUDU_READ_ONLY is set; only Read tools are registered.';
  if (tool.definition.requiresPasswordReveal) return 'HUDU_ALLOW_PASSWORD_REVEAL is not set.';
  if (tool.definition.requiresExportFlag) return 'HUDU_ALLOW_EXPORTS is not set.';
  return 'HUDU_ALLOW_DESTRUCTIVE is not set.';
}

export function buildServer(options: BuildServerOptions = {}): BuiltServer {
  const config = options.config ?? loadConfig(options.env ?? process.env, SERVER_VERSION);
  const client = new HuduClient(config, options.deps ?? {});

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for the Hudu IT documentation platform. Hudu organises everything under a ' +
        'Company, so most work starts with hudu_list_companies to resolve a customer name to ' +
        'an id.\n\n' +
        'Two properties of this API change how you should read results. First, no list ' +
        'endpoint returns a total count, so a full page means "there is probably more" and ' +
        'nothing more precise than that — never describe a list as complete without checking ' +
        '`page_was_full`. Second, stored passwords and TOTP secrets are withheld from every ' +
        'response by default; password records still list their name, username, URL and ' +
        'company, which is enough for most questions.',
    },
  );

  const registered: PreparedTool[] = [];
  const withheld: { name: string; reason: string }[] = [];

  for (const definition of allToolDefinitions()) {
    const prepared = prepareTool(definition);

    if (!shouldRegister(definition, config)) {
      withheld.push({ name: prepared.name, reason: withholdReason(prepared, config) });
      continue;
    }

    server.registerTool(
      prepared.name,
      {
        title: prepared.title,
        description: prepared.description,
        inputSchema: prepared.inputSchema,
        annotations: { title: prepared.title, ...prepared.annotations },
      },
      async (args: Record<string, unknown>) => executeTool(prepared, args, { client, config }),
    );

    registered.push(prepared);
  }

  return { server, config, client, tools: registered, withheld };
}
