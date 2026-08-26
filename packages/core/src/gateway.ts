import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
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
 * Namespace a human-readable label the way descriptions are namespaced, so the
 * `query` tool of two different servers is still tellable apart in a client
 * that shows titles rather than the raw `<server>__<tool>` name.
 */
const nsLabel = (id: string, label: string): string => `[${id}] ${label}`;

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
  /** Human-readable label, preferred over `name` by clients that show one. */
  title?: string;
  /**
   * Behavioural hints. Worth setting on every builtin: a client reads
   * `readOnlyHint` to decide whether a call needs the user's approval, and MCP
   * defaults `destructiveHint` to `true`, so a tool that is not read-only and
   * leaves it unset is treated as destructive.
   */
  annotations?: ToolAnnotations;
  /** Returns JSON-serializable data; the gateway wraps it as text content. */
  call(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/**
 * What the gateway tells a connecting agent about itself, returned in the
 * `initialize` result.
 *
 * This exists because tool descriptions were not enough. An agent that hits
 * "flyctl: not logged in" has to already suspect that a local vault might hold
 * that token before it thinks to look through fifty namespaced tools for one
 * that could help; the ones that did not look asked the user to paste a key
 * into the chat instead, which is the exact failure the vault was built to
 * prevent. `instructions` is the one channel every harness reads regardless of
 * how it treats tool metadata, so the fact that keys are available here belongs
 * in it.
 *
 * Deliberately short. It earns its place in every context window by naming the
 * three things an agent cannot infer from the tool list: that the keys are
 * here, that asking the user to paste one is the wrong move, and that a refusal
 * is a request rather than a wall.
 */
export const GATEWAY_INSTRUCTIONS = `Hypergate is a local gateway, and it is how MCP servers, command-line tools, and credentials are managed on this machine. Route those needs through it rather than improvising. Tools are namespaced "<server>__<tool>"; its own tools are under "hypergate__".

This machine's API keys and access tokens live in Hypergate's credential vault. When a command or API call needs one:

1. Call hypergate__credentials_list to see what exists. Rows with "allowed": true are yours to fetch.
2. Call hypergate__credential_env with the id to get it as environment variables, then set those on the process that needs it (or run the command through "hypergate run -- <command>", which injects them for you).
3. If a credential you need is not allowed, call hypergate__credential_request with the id and a short reason. That files a request with the user and returns a URL. Give the user that URL so they can approve it, then retry.

Command-line tools are Hypergate's job too. Before installing a CLI yourself or telling the user to:

1. Call hypergate__clis_list to see what is installed (pass "query" to search the catalog for tools to add).
2. If a tool is missing, call hypergate__cli_install_request with its id (or npm package / Homebrew formula) and a short reason. The user approves it in Hypergate, which runs the install and shows them the log; call hypergate__clis_list again to see it land.

MCP servers are Hypergate's job too. Before telling the user to edit a config file or install a server themselves:

1. Call hypergate__server_resolve with a registry name (ideally fully qualified, like "com.microsoft/azure") to see exactly what would run, pinned to a version, and what setting it up would take on this machine. It adds nothing.
2. If it is not configured yet, call hypergate__server_install_request with the name and a short reason. The user approves it in Hypergate, which adds and starts the server; call hypergate__server_resolve again to confirm.

Do not ask the user to paste a secret into this conversation, and do not ask them to re-authenticate a CLI by hand. Fetch the key, or request access to it.`;

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
  const server = new Server(info, { capabilities: { tools: {} }, instructions: GATEWAY_INSTRUCTIONS });
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
    const tools: Tool[] = builtins.map((t) => ({
      name: `${BUILTIN_NS}${NS}${t.name}`,
      description: `[${BUILTIN_NS}] ${t.description}`,
      inputSchema: t.inputSchema as Tool['inputSchema'],
      ...(t.title ? { title: nsLabel(BUILTIN_NS, t.title) } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    for (const id of supervisor.ids()) {
      if (!allowed(id)) continue;
      const client = supervisor.client(id);
      if (!client) continue;
      try {
        const res = await client.listTools();
        for (const t of res.tools) {
          // Spread first, then override only what the namespace rewrites.
          // Everything a tool carries beyond name/description/inputSchema —
          // `annotations`, `outputSchema`, `icons`, `_meta` — belongs to the
          // upstream server and has to survive the hop. The hints are why:
          // a client reads `readOnlyHint` to decide whether a call needs the
          // user's approval and `destructiveHint` to warn before one, so
          // rebuilding the tool from three fields made every proxied tool look
          // unannotated — costing a read-only tool its auto-approval and a
          // destructive one its warning, and quietly weakening the metadata of
          // every server Hypergate fronts. Spreading also carries whatever
          // field MCP adds next, instead of dropping it until someone notices.
          tools.push({
            ...t,
            name: `${id}${NS}${t.name}`,
            description: t.description ? `[${id}] ${t.description}` : `[${id}] ${t.name}`,
            ...(t.title ? { title: nsLabel(id, t.title) } : {}),
            ...(t.annotations?.title
              ? { annotations: { ...t.annotations, title: nsLabel(id, t.annotations.title) } }
              : {}),
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
