import { describe, expect, it } from "vitest";
import { parseNeedResponseParam } from "../../src/engine/tools.js";

const members = [
  { id: "rm_dev", name: "developer" },
  { id: "rm_qa", name: "qa" },
  { id: "rm_pm", name: "pm" },
];

describe("parseNeedResponseParam", () => {
  it("omits → empty list (FYI)", () => {
    expect(parseNeedResponseParam(undefined, members, ["developer"], ["rm_dev"])).toEqual({ ok: true, names: [] });
  });

  it("rejects boolean (no longer accepted)", () => {
    const r = parseNeedResponseParam(true, members, ["developer"], ["rm_dev"]);
    expect(r.ok).toBe(false);
  });

  it("keeps only @-mentioned names from the list", () => {
    const r = parseNeedResponseParam(
      ["developer", "qa", "architect"],
      members,
      ["developer", "pm"],
      ["rm_dev", "rm_pm"],
    );
    expect(r).toEqual({ ok: true, names: ["developer"] });
  });

  it("resolves member id refs to names", () => {
    const r = parseNeedResponseParam(["rm_qa"], members, ["qa"], ["rm_qa"]);
    expect(r).toEqual({ ok: true, names: ["qa"] });
  });
});
