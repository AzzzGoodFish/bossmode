// Minimal MCP server with a "hello" tool
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "test-mcp",
  version: "1.0.0",
});

server.tool("hello", "Returns a greeting message. Call this tool when asked to greet.", {
  name: z.string().describe("Name to greet"),
}, async ({ name }) => ({
  content: [{ type: "text", text: `Hello, ${name}! This is from the test MCP server.` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
