import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig, getUserDisplayName, writeConfig } from "../../src/config/settings.js";
import { coreFixture } from "../helpers/core-fixture.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => fixture.close());
function setUsername(username: string): void {
  writeConfig({ ...getDefaultConfig(), auth: { username, passwordHash: "fixture-only" } });
}

describe("getUserDisplayName", () => {
  it("follows the stored login name", () => {
    setUsername("lhy");
    expect(getUserDisplayName()).toBe("lhy");
  });
  it("falls back to User when username is empty", () => {
    setUsername("");
    expect(getUserDisplayName()).toBe("User");
  });
  it("falls back to User when configuration is not initialized", () => {
    expect(getUserDisplayName()).toBe("User");
  });
  it("trims whitespace", () => {
    setUsername("  lhy  ");
    expect(getUserDisplayName()).toBe("lhy");
  });
});
