import { describe, expect, it } from "vitest";
import { diffStatForTool, eventSearchText, isStationActionEvent, latestActionSummary } from "../../web/src/components/agent-event-utils";

// Local test helper mirrors UI grouping contract: unclosed turns are valid.
function groupTurns(events: any[]): any[][] {
  const turns: any[][] = [];
  let current: any[] = [];
  for (const event of events) {
    if (event.type === "agent_start" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(event);
    if (event.type === "agent_end") {
      turns.push(current);
      current = [];
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

describe("agent event UI helpers", () => {
  it("summarizes tool_start as running lifecycle action", () => {
    const summary = latestActionSummary([
      { type: "message_update", text: "partial", ts: 1 },
      { type: "tool_start", toolName: "Edit", args: { file_path: "web/src/pages/Main.tsx" }, ts: 2 },
    ]);

    expect(summary).toMatchObject({ kind: "tool-running", label: "RUNNING · Edit", detail: "web/src/pages/Main.tsx" });
  });

  it("summarizes successful and failed tool_end lifecycle actions", () => {
    const done = latestActionSummary([
      { type: "tool_start", toolName: "Bash", args: { command: "npm test" }, ts: 1 },
      { type: "tool_end", toolName: "Bash", result: "ok", ts: 2 },
    ]);
    const failed = latestActionSummary([
      { type: "tool_start", toolName: "Bash", args: { command: "npm test" }, ts: 1 },
      { type: "tool_end", toolName: "Bash", isError: true, result: "Command failed", ts: 2 },
    ]);

    expect(done).toMatchObject({ kind: "tool-done", label: "DONE · Bash", detail: "ok" });
    expect(failed).toMatchObject({ kind: "tool-error", label: "ERROR · Bash", detail: "Command failed" });
    expect(isStationActionEvent({ type: "tool_end", toolName: "Bash" })).toBe(true);
    expect(isStationActionEvent({ type: "tool_end", toolName: "Bash", isError: true })).toBe(true);
  });

  it("keeps latest displayable tool lifecycle when streaming noise follows", () => {
    const summary = latestActionSummary([
      { type: "tool_start", toolName: "Bash", args: { command: "npm test" }, ts: 1 },
      { type: "tool_update", text: "...", ts: 2 },
      { type: "message_start", ts: 3 },
      { type: "message_update", text: "draft", ts: 4 },
    ]);

    expect(summary).toMatchObject({ kind: "tool-running", label: "RUNNING · Bash", detail: "npm test" });
  });

  it("prefers final reply text over thinking when message_end contains both", () => {
    const summary = latestActionSummary([{ type: "message_end", thinking: "private chain", text: "final answer", ts: 3 }]);

    expect(summary).toMatchObject({ kind: "reply", label: "REPLY", detail: "final answer" });
  });

  it("searches command and file path fields", () => {
    expect(eventSearchText({ type: "tool_start", toolName: "Bash", args: { command: "npm test" } })).toContain("npm test");
    expect(eventSearchText({ type: "tool_start", toolName: "Read", args: { file_path: "src/index.ts" } })).toContain("src/index.ts");
  });

  it("computes diffstat only for edit/write tools", () => {
    expect(diffStatForTool({ type: "tool_start", toolName: "Edit", args: { old_string: "a\nb", new_string: "a\nb\nc" } })).toEqual({ added: 3, removed: 2 });
    expect(diffStatForTool({ type: "tool_start", toolName: "Write", args: { content: "a\nb" } })).toEqual({ added: 2, removed: 0 });
    expect(diffStatForTool({ type: "tool_start", toolName: "Bash", args: { command: "cat > x" } })).toBeNull();
  });

  it("groups turns without requiring a closing agent_end", () => {
    expect(groupTurns([
      { type: "agent_start", ts: 1 },
      { type: "tool_start", ts: 2 },
      { type: "agent_end", ts: 3 },
      { type: "agent_start", ts: 4 },
      { type: "message_end", ts: 5 },
    ])).toHaveLength(2);
  });
});
