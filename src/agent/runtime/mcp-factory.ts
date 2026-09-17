import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getDatabase } from "../../data/database.js";
import { createMcpOauthStorage } from "../../member/mcp.js";

/** Native vendor entry with an explicitly bound SQL credential authority. */
export async function loadDatabaseMcpFactory(adapterPath: string): Promise<{ name: string; factory: ExtensionFactory }> {
  const authStorage = createMcpOauthStorage(getDatabase());
  const entry = pathToFileURL(join(dirname(adapterPath), "host-factory.js")).href;
  const { createMcpAdapter } = await import(entry);
  return { name: "pi-mcp-adapter", factory: createMcpAdapter({ authStorage }) };
}
