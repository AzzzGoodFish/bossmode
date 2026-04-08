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

/** Max chars for tool result text. ~6K tokens, aligned with Claude Code conventions. */
const MAX_RESULT_CHARS = 25_000;

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) +
    `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

async function callbackTool(tool: string, params: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${SERVER}/internal/tool-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, room: ROOM, agent: AGENT, params }),
  });
  const data = await res.json();
  return truncateResult(JSON.stringify(data));
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
  "Query the project knowledge base. Without a query, returns entry summaries (titles + types). With a query, returns full content of matching entries.",
  {
    query: z.string().optional().describe("Search query to filter entries by title/content. Omit to list all entry summaries."),
  },
  async ({ query }) => {
    const result = await callbackTool("query_knowledge", { query });
    return { content: [{ type: "text", text: result }] };
  },
);

// Update knowledge tool
server.tool(
  "update_knowledge",
  "Update an existing knowledge entry in the project knowledge base. Use query_knowledge first to find entry IDs.",
  {
    entryId: z.string().describe("ID of the entry to update"),
    title: z.string().describe("New title for the entry"),
    content: z.string().describe("New content for the entry"),
  },
  async ({ entryId, title, content }) => {
    const result = await callbackTool("update_knowledge", { entryId, title, content });
    const data = JSON.parse(result);
    if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
    return { content: [{ type: "text", text: `Knowledge updated: ${title}` }] };
  },
);

// Delete knowledge tool
server.tool(
  "delete_knowledge",
  "Delete a knowledge entry from the project knowledge base. Use query_knowledge first to find entry IDs.",
  {
    entryId: z.string().describe("ID of the entry to delete"),
  },
  async ({ entryId }) => {
    const result = await callbackTool("delete_knowledge", { entryId });
    const data = JSON.parse(result);
    if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
    return { content: [{ type: "text", text: `Knowledge entry deleted.` }] };
  },
);

// Write summary tool — used by summarizer agent to create topic summaries
server.tool(
  "write_summary",
  "Create a topic-based summary message that covers a range of messages. Only callable by the summarizer agent.",
  {
    title: z.string().describe("Short topic title for this summary segment"),
    summary: z.string().describe("1-3 sentence summary of the key content, decisions, and conclusions"),
    from_id: z.string().describe("Message ID of the first message in this segment"),
    to_id: z.string().describe("Message ID of the last message in this segment"),
  },
  async ({ title, summary, from_id, to_id }) => {
    const result = await callbackTool("write_summary", { title, summary, from_id, to_id });
    const data = JSON.parse(result);
    if (!data.ok) return { content: [{ type: "text", text: `Failed: ${data.error}` }] };
    return { content: [{ type: "text", text: `Summary created: "${title}" (${data.coveredCount} messages)` }] };
  },
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
