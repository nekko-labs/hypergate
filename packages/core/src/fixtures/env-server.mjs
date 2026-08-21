// A stdio MCP server that reports its own environment variables, used by the
// credential-vault tests to prove that a `credentialRefs` entry really reaches
// the spawned child's env (and that nothing else leaked in with it).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'envprobe', version: '0.0.1' });
server.tool('env', 'Return the value of one environment variable, or "" when unset.', { name: z.string() }, async ({ name }) => ({
  content: [{ type: 'text', text: process.env[name] ?? '' }],
}));
await server.connect(new StdioServerTransport());
