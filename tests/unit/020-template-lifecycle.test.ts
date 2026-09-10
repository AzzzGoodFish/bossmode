import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { saveAgentDefinition } from "../../src/workforce/agent-store.js";
import { SettingsRepository } from "../../src/storage/repositories/settings.js";
import { getDefaultConfig } from "../../src/shared/config.js";
let fixture: ReturnType<typeof coreFixture>;
describe("template lifecycle S5", () => {
  beforeEach(() => {
    fixture = coreFixture();
    new SettingsRepository(fixture.db).importConfig(getDefaultConfig());
    saveAgentDefinition("general", "---\nname: general\ntags: [builtin]\n---\nG\n");
    saveAgentDefinition("custom_x", "---\nname: custom_x\n---\nC\n");
  });
  afterEach(() => fixture.close());

  it("falls back referencing members to general and posts dm warning", async () => {
    // Exercise the retained explicit lifecycle helper, not a retired template API.
    const reg = await import("../../src/workspace/member-registry.js");
    const life = await import("../../src/workforce/template-lifecycle.js");
    const dm = await import("../../src/workspace/dm-message-store.js");

    const m = reg.createMember({ name: "dave", agentTemplate: "custom_x" });
    expect(m.agentTemplate).toBe("custom_x");

    // Explicit fallback does not require implicit filesystem template discovery.
    const result = life.fallbackMembersToGeneral("custom_x");
    expect(result.updatedMemberIds).toContain(m.id);
    expect(reg.getMember(m.id)!.agentTemplate).toBe("general");
    const msgs = dm.readAllDmMessages(m.id);
    expect(msgs.some((x) => x.sender === "system" && /general/i.test(x.content))).toBe(true);
  });

  it("general and factory-shipped names are immutable", async () => {
    const life = await import("../../src/workforce/template-lifecycle.js");
    const { listFactoryTemplateNames } = await import("../../src/workforce/agent-store.js");
    expect(life.isImmutableTemplate("general")).toBe(true);
    const factory = listFactoryTemplateNames();
    expect(factory.length).toBeGreaterThan(0);
    // Seeded roles (developer/qa/pm/…) live in package templates/agents — immutable even without tags
    for (const name of ["developer", "qa", "pm", "architect", "designer"]) {
      if (factory.includes(name)) {
        expect(life.isImmutableTemplate(name)).toBe(true);
      }
    }
    // Custom name not in factory → mutable (unless tags:builtin on loaded def)
    expect(life.isImmutableTemplate("custom_x_not_factory")).toBe(false);
  });
});
