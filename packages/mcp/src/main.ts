#!/usr/bin/env node
/**
 * kommentarwache-mcp: a stdio MCP server for coding agents. Every tool is one command
 * from the catalogue, carried out by calling the kommentarwache REST API with your
 * token, so nothing here needs a database.
 *
 *   KW_URL=https://moderation.example.org KW_TOKEN=kw_... npx -y kommentarwache-mcp --stdio
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { COMMANDS, COMMAND_NAMES, type CommandName } from '@kommentarwache/contract';

const baseUrl = (process.env['KW_URL'] ?? 'http://localhost:8080').replace(/\/+$/, '');
const token = process.env['KW_TOKEN'] ?? '';

/** Build the REST call for a command: path params from the input, the rest as query or body. */
export function restCall(
  name: CommandName,
  input: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const spec = COMMANDS[name];
  const rest: Record<string, unknown> = { ...input };
  const path = spec.path.replace(/:(\w+)/g, (_, key: string) => {
    const v = rest[key];
    delete rest[key];
    return encodeURIComponent(String(v));
  });
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
  };
  if (spec.method === 'GET') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(rest))
      if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.toString();
    return { url: `${baseUrl}${path}${qs ? `?${qs}` : ''}`, init: { method: 'GET', headers } };
  }
  headers['content-type'] = 'application/json';
  return {
    url: `${baseUrl}${path}`,
    init: { method: spec.method, headers, body: JSON.stringify(rest) },
  };
}

async function main() {
  if (!token) {
    console.error(
      'KW_TOKEN is not set; create one with `kw token create --name <agent> --scopes moderate,review`',
    );
    process.exit(2);
  }
  const server = new McpServer({ name: 'kommentarwache', version: '0.1.0' });
  for (const name of COMMAND_NAMES) {
    const spec = COMMANDS[name];
    // The catalogue is heterogeneous, so the SDK's per-tool generics are cast once here;
    // the server validates the input against the same schema.
    const handler = async (input: Record<string, unknown>): Promise<CallToolResult> => {
      const { url, init } = restCall(name, input);
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
        const text = await res.text();
        if (!res.ok)
          return {
            content: [{ type: 'text', text: `${res.status}: ${text.slice(0, 2000)}` }],
            isError: true,
          };
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `request failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    };
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
      handler as never,
    );
  }
  await server.connect(new StdioServerTransport());
}

if (process.argv.includes('--stdio') || !process.argv.includes('--help')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.log('usage: KW_URL=... KW_TOKEN=... kommentarwache-mcp --stdio');
}
