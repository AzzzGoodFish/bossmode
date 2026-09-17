import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { openDatabase } from "../../src/data/database.js";
import { importMcpConfiguration, readMcpConfiguration } from "../../src/member/mcp.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

it("reads one complete MCP configuration while another connection commits a replacement", () => {
  const before = { label: "before", mcpServers: { old: { command: "node", args: ["old.js"] } } };
  const after = { label: "after", mcpServers: { next: { command: "node", args: ["next.js"] } } };
  importMcpConfiguration(before, "global", fixture.db);
  const writer = openDatabase(fixture.db.path);
  const get = fixture.db.get.bind(fixture.db);
  let replaced = false;
  vi.spyOn(fixture.db, "get").mockImplementation((sql, ...params) => {
    const value = get(sql, ...params);
    if (!replaced && sql.startsWith("SELECT * FROM mcp_config")) {
      replaced = true;
      importMcpConfiguration(after, "global", writer);
    }
    return value;
  });
  try {
    expect(readMcpConfiguration("global", fixture.db)).toEqual(before);
    expect(replaced).toBe(true);
    expect(readMcpConfiguration("global", fixture.db)).toEqual(after);
  } finally { writer.close(); }
});

it("can read configuration with query_only enabled", () => {
  const config = { mcpServers: { demo: { command: "node" } } };
  importMcpConfiguration(config, "global", fixture.db);
  fixture.db.exec("PRAGMA query_only=ON");
  expect(readMcpConfiguration("global", fixture.db)).toEqual(config);
});
