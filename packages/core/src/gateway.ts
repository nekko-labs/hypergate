import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Supervisor } from './supervisor.js';

/** Separator between a server id and its tool name in the aggregated namespace. */
export const NS = '__';

/**
 * Build the aggregating MCP gateway: one MCP server that fans out to every
 * ready managed server. Tools are namespaced `${serverId}__${tool}` and calls
 * are routed to the owning server's client. The caller connects the returned
 * Server to a transport (stdio for spawn-based clients; HTTP/SSE for URL ones).
 */
export function createGateway(
  supervisor: Supervisor,
  info: { name: string; version: string } = { name: 'hypergate-gateway', version: '0.1.0' },
  opts: { caller?: string; allowServer?: (serverId: string) => boolean } = {},
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
  const caller = opts.caller ?? 'unknown client';
  // Per-agent scoping: when provided, a server the caller isn't allowed to see
  // is hidden from tools/list and its tools/call is refused. Default = allow all.
  const allowed = (id: string): boolean => (opts.allowServer ? opts.allowServer(id) : true);
  const bytes = (v: unknown): number => {
    try {
      return Buffer.byteLength(JSON.stringify(v ?? {}));
    } catch {
      return 0;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
    for (const id of supervisor.ids()) {
      if (!allowed(id)) continue;
      const client = supervisor.client(id);
      if (!client) continue;
      try {
        const res = await client.listTools();
        for (const t of res.tools) {
          tools.push({
            name: `${id}${NS}${t.name}`,
            description: t.description ? `[${id}] ${t.description}` : `[${id}] ${t.name}`,
            inputSchema: t.inputSchema,
          });
        }
      } catch {
        /* a server that went away is simply skipped */
      }
    }
    return { tools } as never;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const full = req.params.name;
    const idx = full.indexOf(NS);
    if (idx < 0) throw new Error(`Unknown tool "${full}" — expected "<server>${NS}<tool>".`);
    const id = full.slice(0, idx);
    const name = full.slice(idx + NS.length);
    if (!allowed(id)) throw new Error(`Not permitted: this client may not call server "${id}".`);
    const client = supervisor.client(id);
    if (!client) throw new Error(`Server "${id}" is not ready.`);

    const args = req.params.arguments ?? {};
    const startedAt = Date.now();
    const record = (ok: boolean, bytesOut: number, error?: string): void =>
      supervisor.record({
        at: new Date().toISOString(),
        serverId: id,
        server: supervisor.status(id)?.name ?? id,
        tool: name,
        client: caller,
        ok,
        ms: Date.now() - startedAt,
        bytesIn: bytes(args),
        bytesOut,
        error,
      });

    try {
      const res = await client.callTool({ name, arguments: args });
      const isErr = !!(res && typeof res === 'object' && (res as { isError?: boolean }).isError);
      record(!isErr, bytes(res), isErr ? 'tool reported an error' : undefined);
      return res as never;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(false, 0, msg);
      throw e;
    }
  });

  return server;
}
