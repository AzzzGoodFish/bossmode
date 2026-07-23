import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { userActionError } from "../../web/src/utils/user-error.js";

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("P1 user-language hygiene", () => {
  it("uses the English Settings terminology baseline", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain('title="Settings"');
    expect(sidebar).toContain('title: "Extensions"');
    expect(sidebar).not.toContain("Built-in Updates");
    expect(sidebar).toContain("No Rooms yet. Click + to create one.");
    expect(sidebar).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("keeps member controls free of implementation and mixed-language copy", () => {
    const station = source("web/src/components/StationPanel.tsx");
    for (const phrase of ["Weak identity hint", "Agent hint is read-only", "runtime actions", "instance rebuild", "Full reload", "model prefill", "fault recovery", "MCP registry", "globally disabled", "Compact room-local overrides", "Keeps prompt, tools and session", "not in available models", "System → Models"]) {
      expect(station).not.toContain(phrase);
    }
    expect(station).not.toMatch(/[\u3400-\u9fff]/u);
    expect(station).toContain("No model connected");
    expect(station).not.toContain(">{server.transport}<");
    expect(station).toContain("Couldn’t load MCP servers.");
    expect(station).toContain("MCP servers are turned off. Turn them on in Settings → Integrations.");
  });

  it("does not expose runtime or storage implementation labels on everyday surfaces", () => {
    const activity = source("web/src/components/ActivityTab.tsx");
    const roomSettings = source("web/src/components/RoomSettingsDialog.tsx");
    const models = source("web/src/components/ModelPicker.tsx");
    expect(activity).not.toContain('member?.runtime || "pi-sdk"');
    expect(roomSettings).not.toMatch(/legacy\/global|knowledge docs tree|through[^.]{0,80}\btools\b/i);
    expect(models).not.toMatch(/Import credentials|Model Credentials|not in available models/);
  });

  it("uses English chat activity labels", () => {
    const dateLabels = source("web/src/utils/message-date.ts");
    expect(dateLabels).toContain('return "Today"');
    expect(dateLabels).toContain('toLocaleDateString("en-US"');
    expect(dateLabels).not.toMatch(/zh-(?:CN|TW)|[\u3400-\u9fff]/u);
    const chat = source("web/src/components/ChatArea.tsx");
    expect(chat).toContain('"updated the document"');
    expect(chat).toContain('"edited the document"');
  });

  it("formats action-aware errors without exposing raw implementation details", () => {
    expect(userActionError("save this task", "Check the title, then try again."))
      .toBe("Couldn’t save this task. Check the title, then try again.");
    const activeSources = [
      "web/src/pages/SettingsPage.tsx",
      "web/src/components/StationPanel.tsx",
      "web/src/components/ActivityTab.tsx",
      "web/src/pages/Main.tsx",
      "web/src/pages/TaskDetailPage.tsx",
      "web/src/pages/KnowledgePage.tsx",
    ].map(source).join("\n");
    expect(activeSources).not.toMatch(/toast\((err|error)\.?message|\$\{err\.message\}/);
  });
});
