/**
 * The MCP server, generated from the command catalogue: one tool per command, run
 * in-process through runCommand under the caller's token. Served over streamable HTTP at
 * /mcp (stateless, so any instance can answer) and, by the kommentarwache-mcp package,
 * over stdio against the REST API.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Kysely } from 'kysely';
import { COMMANDS, COMMAND_NAMES, type CommandName } from '@kommentarwache/contract';
import { CommandError, runCommand } from '../commands/run.js';
import type { DB } from '../db/types.js';
import type { ActivePipeline } from '../providers/registry.js';
import type { AuthedActor } from '../api/auth.js';

export const MCP_SERVER_INFO = { name: 'kommentarwache', version: '0.1.0' };

/**
 * Register one catalogue command as a tool. The catalogue is a heterogeneous record, so
 * the SDK's per-tool generics cannot be inferred in a loop; the input is validated by
 * the command's own schema inside runCommand anyway.
 */
export function registerCommandTool(
  server: McpServer,
  name: CommandName,
  handler: (input: Record<string, unknown>) => Promise<CallToolResult>,
): void {
  const spec = COMMANDS[name];
  server.registerTool(
    name,
    {
      description: spec.description,
      inputSchema: spec.input as never,
      annotations: {
        readOnlyHint: !spec.mutating,
        destructiveHint: name === 'act_on_comment',
        openWorldHint: true,
      },
    },
    ((input: Record<string, unknown>) => handler(input)) as never,
  );
}

export function createMcpServer(deps: {
  db: Kysely<DB>;
  pipeline: () => Promise<ActivePipeline>;
  actor: AuthedActor;
}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  for (const name of COMMAND_NAMES) {
    registerCommandTool(server, name, async (input) => {
      try {
        const result = await runCommand(
          name,
          { db: deps.db, pipeline: deps.pipeline, actor: deps.actor, via: 'mcp' },
          input,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message =
          err instanceof CommandError ? `${err.status}: ${err.message}` : (err as Error).message;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    });
  }
  return server;
}

/** Answer one HTTP request to /mcp for an authenticated actor, statelessly. */
export async function handleMcpRequest(
  deps: { db: Kysely<DB>; pipeline: () => Promise<ActivePipeline>; actor: AuthedActor },
  request: Request,
): Promise<Response> {
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
