import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const settingsPage = readFileSync(resolve(root, "web/src/pages/SettingsPage.tsx"), "utf8");

describe("MCP Settings product copy", () => {
  it("shows a real empty state and actionable next step", () => {
    // Assignment pointer moved to the member card (batch profile-plain).
    expect(settingsPage).toContain("Per-member toggle lives in the member card");
    expect(settingsPage).toContain("No MCP servers configured.");
    expect(settingsPage).toContain("Check whether your configured servers can connect.");
    expect(settingsPage).toContain("Secrets stay on this device and are hidden after saving.");
    expect(settingsPage).toContain("Advanced configuration");
  });

  it("does not expose implementation copy, paths, or transport details on the default surface", () => {
    expect(settingsPage).not.toContain("settings.configPath");
    expect(settingsPage).not.toContain("Uses native MCP config format");
    expect(settingsPage).not.toContain("Direct MCP tools");
    expect(settingsPage).not.toContain("proxy tool");
    expect(settingsPage).not.toContain("HTTP/stdio");
    expect(settingsPage).not.toContain("Errors are sanitized");
  });
});
