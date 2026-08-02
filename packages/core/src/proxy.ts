import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * A gateway that forwards to *another* gateway instead of owning one.
 *
 * The aggregating gateway (`createGateway`) starts and supervises the servers it
 * exposes. That is right for the resident daemon and wrong for a transient
 * `hypergated --stdio` spawn: a harness that launches one per session would get
 * its own private copy of every managed server, so three open editors means
 * three Postgres connections, three sets of logs, and three chances to fight
 * over a lock file.
 *
 * So when a daemon is already up, the stdio spawn becomes this: a pass-through
 * that hands `tools/list` and `tools/call` to the resident gateway over HTTP and
 * returns whatever it says. Namespacing, per-agent permissions and usage
 * recording all stay where the servers actually live, and there is exactly one
 * fleet on the machine.
 */

/** The upstream we forward to: an MCP client, or anything shaped like one. */
export interface ProxyUpstream {
  listTools(): Promise<{ tools: unknown[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Build a pass-through MCP server over an upstream client. The caller connects
 * the returned `Server` to a transport (stdio, for the harness that spawned us).
 */
export function createProxy(
  upstream: ProxyUpstream,
  info: { name: string; version: string } = { name: 'hypergate-gateway', version: '0.1.0' },
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const res = await upstream.listTools();
    return { tools: res.tools ?? [] } as never;
  });

  // Errors are deliberately not swallowed: the upstream's message ("Server "x"
  // is not ready", "Not permitted…") is more useful to the caller than anything
  // this layer could invent, and the harness renders it as the tool result.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await upstream.callTool({
      name: req.params.name,
      arguments: req.params.arguments ?? {},
    });
    return res as never;
  });

  return server;
}
