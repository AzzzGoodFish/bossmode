/**
 * OAuth submit pre-parse (fish 2026-09-04, architect spec ①②③):
 * bare code / full redirect URL / code#state / query string all pass;
 * a URL without a code, and a URL whose state belongs to another login
 * attempt, are rejected with pointed messages instead of pi's opaque
 * "State mismatch".
 */
import { describe, expect, it } from "vitest";
import { validateOAuthSubmitInput } from "../../src/config/oauth.js";

const JOB = { authUrl: "https://auth.openai.com/authorize?client_id=abc&state=expected-state-123&code_challenge=x" };

describe("oauth submit input pre-validation", () => {
  it("bare code passes", () => {
    expect(() => validateOAuthSubmitInput(JOB, "cd_abc123")).not.toThrow();
  });

  it("full redirect URL with matching state passes", () => {
    const url = "http://localhost:1455/callback?code=cd_abc123&state=expected-state-123";
    expect(() => validateOAuthSubmitInput(JOB, url)).not.toThrow();
  });

  it("bare query string with matching state passes", () => {
    expect(() => validateOAuthSubmitInput(JOB, "code=cd_abc123&state=expected-state-123")).not.toThrow();
  });

  it("code#state passes (no state check — fragment form)", () => {
    expect(() => validateOAuthSubmitInput(JOB, "cd_abc123#expected-state-123")).not.toThrow();
  });

  it("blank passes (select-option prompts)", () => {
    expect(() => validateOAuthSubmitInput(JOB, "")).not.toThrow();
  });

  it("URL without a code is rejected with a clear message", () => {
    expect(() => validateOAuthSubmitInput(JOB, "http://localhost:1455/callback?state=expected-state-123"))
      .toThrow(/No authorization code/);
  });

  it("URL from a different login attempt (state mismatch) is rejected with the real reason", () => {
    const url = "http://localhost:1455/callback?code=cd_abc123&state=81159d-some-other-login";
    expect(() => validateOAuthSubmitInput(JOB, url)).toThrow(/DIFFERENT login attempt/);
  });

  it("no authUrl on the job → no pre-check (pi decides)", () => {
    expect(() => validateOAuthSubmitInput({}, "http://localhost:1455/?code=x&state=whatever")).not.toThrow();
  });
});
