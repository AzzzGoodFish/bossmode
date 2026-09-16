import { describe, expect, it } from "vitest";
import { canonicalJson, defined, objectJson, optionalJson, parseObject, requireObject } from "../../src/kernel/json.js";

describe("shared JSON mechanics", () => {
  it("checks object containers once without copying values or validating domain fields", () => {
    const value = { unknownExtension: true, optional: undefined };
    expect(requireObject(value)).toBe(value);
    expect(requireObject(Object.create(null))).toEqual({});
    for (const invalid of [null, undefined, [], "secret-payload", 0, false]) {
      expect(() => requireObject(invalid, "Invalid configuration container")).toThrow("Invalid configuration container");
    }
  });

  it("round-trips ordinary objects, keeps optional-field behavior and does not discard falsy values", () => {
    expect(parseObject(objectJson({ a: undefined, b: false, c: 0, d: "", e: null })))
      .toEqual({ b: false, c: 0, d: "", e: null });
    expect(optionalJson(null)).toBeNull();
    expect(optionalJson(undefined)).toBeNull();
    expect(optionalJson({})).toBe("{}");
    expect(defined({ a: null, b: undefined, c: 0, d: false, e: "" })).toEqual({ c: 0, d: false, e: "" });
  });

  it("rejects non-object or malformed stored values without exposing their source", () => {
    for (const text of ["null", "[]", "true", '"secret-token"', '{"apiKey":"secret-token",']) {
      expect(() => parseObject(text)).toThrow("Invalid JSON object");
      try { parseObject(text); } catch (error) { expect(String(error)).not.toContain("secret-token"); }
    }
    for (const value of [[], null, { toJSON: () => null }, { toJSON: () => [] }, { toJSON: () => undefined }]) {
      expect(() => objectJson(value)).toThrow(/JSON object/);
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => objectJson(cycle)).toThrow("Invalid JSON object");
  });

  it("canonicalizes nested object keys while retaining array order and JSON primitives", () => {
    expect(canonicalJson({ z: [false, null, 1, "x"], a: { y: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"y":2},"z":[false,null,1,"x"]}');
    const shared = { b: 1 };
    expect(canonicalJson({ z: shared, a: shared })).toBe('{"a":{"b":1},"z":{"b":1}}');
    expect(canonicalJson(Object.assign(Object.create(null), { z: 1 }))).toBe('{"z":1}');
  });

  it("rejects lossy canonical values instead of silently changing durable identity", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const symbol = { [Symbol("secret")]: "secret-token" };
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, { a: undefined }, [undefined], new Array(2), new Date(), cycle, symbol]) {
      expect(() => canonicalJson(value, "Invalid delivery JSON")).toThrow(/Invalid delivery JSON/);
    }
  });
});
