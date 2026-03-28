#!/usr/bin/env node
// Bossmode MCP Server — stdio transport, spawned by Claude CLI
// Receives config via environment variables:
//   BOSSMODE_SERVER — bossmode HTTP server URL (e.g., http://127.0.0.1:8080)
//   BOSSMODE_ROOM — room ID
//   BOSSMODE_AGENT — agent name
//   BOSSMODE_MEMBERS — comma-separated room member names

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER = process.env.BOSSMODE_SERVER || "http://127.0.0.1:8080";
const ROOM = process.env.BOSSMODE_ROOM || "";
const AGENT = process.env.BOSSMODE_AGENT || "";
const MEMBERS = (process.env.BOSSMODE_MEMBERS || "").split(",").filter(Boolean);

async function callbackTool(tool: string, params: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${SERVER}/internal/tool-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, room: ROOM, agent: AGENT, params }),
  });
  const data = await res.json();
  return JSON.stringify(data);
}

const server = new McpServer({
  name: "bossmode",
  version: "1.0.0",
});

// Chat tool — with optional target and mentions
const otherMembers = MEMBERS.filter((m) => m !== AGENT);
server.tool(
  "chat",
  `Post a message. target="room" (default) sends to group chat visible to all. target="user" sends a private reply only the user sees. Optionally mention agents to activate them. Available agents: ${otherMembers.join(", ")}`,
  {
    message: z.string().describe("Message to post"),
    target: z.string().optional().describe('"room" (default, everyone sees) or "user" (private reply)'),
    mentions: z.array(z.string()).optional().describe("Agent names to mention and activate"),
  },
  async ({ message, target, mentions }) => {
    await callbackTool("chat", { message, target, mentions });
    const targetText = target === "user" ? "Private reply sent." : "Message sent to room.";
    const mentionText = mentions?.length ? ` Mentioned: ${mentions.join(", ")}` : "";
    return { content: [{ type: "text", text: `${targetText}${mentionText}` }] };
  },
);

// Query room messages — read chat history
server.tool(
  "query_room_messages",
  "Read recent messages from the group chat room to understand the conversation context.",
  {
    limit: z.number().optional().describe("Number of messages to retrieve (default 50)"),
  },
  async ({ limit }) => {
    const result = await callbackTool("query_room_messages", { limit });
    return { content: [{ type: "text", text: result }] };
  },
);

// Save knowledge tool
server.tool(
  "save_knowledge",
  "Save knowledge to the project knowledge base for future reference.",
  {
    title: z.string().describe("Title for the knowledge entry"),
    content: z.string().describe("Content of the knowledge entry"),
  },
  async ({ title, content }) => {
    await callbackTool("save_knowledge", { title, content });
    return { content: [{ type: "text", text: `Knowledge saved: ${title}` }] };
  },
);

// Query knowledge tool
server.tool(
  "query_knowledge",
  "Query the project knowledge base. Returns matching entries.",
  {
    query: z.string().optional().describe("Search query (omit to list all)"),
  },
  async ({ query }) => {
    const result = await callbackTool("query_knowledge", { query });
    return { content: [{ type: "text", text: result }] };
  },
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
