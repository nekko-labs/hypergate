import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Supervisor } from './supervisor.js';

/** Separator between a server id and its tool name in the aggregated namespace. */
export const NS = '__';

/**
 * The namespace the gateway's own built-in tools live under. Reserved: the
 * daemon refuses to add a managed server with this id, so `hypergate__*` can
 * never be shadowed by (or shadow) a real server's tools.
 */
export const BUILTIN_NS = 'hypergate';

/**
 * A tool the gateway itself provides (not routed to any managed server) —
 * e.g. the credential vault's `credentials_list` / `credential_env`. The host
 * builds these per-request with the caller's scope closed over, so the tool
 * body never has to re-derive who is asking. Calls are recorded through the
 * same usage path as routed tools, so analytics shows them per caller.
 */
export interface GatewayBuiltinTool {
  /** Bare name; exposed as `hypergate__${name}`. */
  name: string;
  description: string;
  inputSchema: unknown;
  /** Returns JSON-serializable data; the gateway wraps it as text content. */
  call(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/**
 * Build the aggregating MCP gateway: one MCP server that fans out to every
 * ready managed server. Tools are namespaced `${serverId}__${tool}` and calls
 * are routed to the owning server's client. The caller connects the returned
 * Server to a transport (stdio for spawn-based clients; HTTP/SSE for URL ones).
 */
export function createGateway(
  supervisor: Supervisor,
  info: { name: string; version: string } = { name: 'hypergate-gateway', version: '0.1.0' },
  opts: { caller?: string; allowServer?: (serverId: string) => boolean; builtins?: GatewayBuiltinTool[] } = {},
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });
  const caller = opts.caller ?? 'unknown client';
  const builtins = opts.builtins ?? [];
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

  const record = (tool: string, serverId: string, serverName: string, startedAt: number, args: unknown) =>
    (ok: boolean, bytesOut: number, error?: string): void =>
      supervisor.record({
        at: new Date().toISOString(),
        serverId,
        server: serverName,
        tool,
        client: caller,
        ok,
        ms: Date.now() - startedAt,
        bytesIn: bytes(args),
        bytesOut,
        error,
      });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: { name: string; description?: string; inputSchema: unknown }[] = builtins.map((t) => ({
      name: `${BUILTIN_NS}${NS}${t.name}`,
      description: `[${BUILTIN_NS}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
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
    const args = req.params.arguments ?? {};

    // The gateway's own tools: same recording, no routing. Handled before the
    // per-server permission check because builtins carry their caller's scope
    // inside themselves (the host closes over it when building them).
    if (id === BUILTIN_NS) {
      const tool = builtins.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool "${full}".`);
      const done = record(name, BUILTIN_NS, 'Hypergate', Date.now(), args);
      try {
        const data = await tool.call(args as Record<string, unknown>);
        const res = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        done(true, bytes(res));
        return res as never;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        done(false, 0, msg);
        throw e;
      }
    }

    if (!allowed(id)) throw new Error(`Not permitted: this client may not call server "${id}".`);
    const client = supervisor.client(id);
    if (!client) throw new Error(`Server "${id}" is not ready.`);

    const done = record(name, id, supervisor.status(id)?.name ?? id, Date.now(), args);
    try {
      const res = await client.callTool({ name, arguments: args });
      const isErr = !!(res && typeof res === 'object' && (res as { isError?: boolean }).isError);
      done(!isErr, bytes(res), isErr ? 'tool reported an error' : undefined);
      return res as never;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      done(false, 0, msg);
      throw e;
    }
  });

  return server;
}
