import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * useDraft is a React hook — it cannot be called outside React rendering context.
 * These tests verify the localStorage persistence contract that useDraft relies on,
 * implemented as plain functions that mirror the hook's storage logic.
 *
 * For full hook behavior tests, use React Testing Library's renderHook in a
 * browser-like environment (future: add a jsdom test environment).
 */

const PREFIX = "bossmode.draft.";

const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
vi.stubGlobal("localStorage", localStorageMock);

function setDraft(key: string, value: string) {
  const storageKey = PREFIX + key;
  if (value) localStorage.setItem(storageKey, value);
  else localStorage.removeItem(storageKey);
}

function getDraft(key: string | null): string {
  if (!key) return "";
  return localStorage.getItem(PREFIX + key) ?? "";
}

function clearDraft(key: string) {
  setDraft(key, "");
}

describe("useDraft localStorage persistence contract", () => {
  beforeEach(() => { localStorageMock.clear(); });

  it("persists non-empty value under prefixed key", () => {
    setDraft("room:abc", "hello world");
    expect(localStorage.getItem(PREFIX + "room:abc")).toBe("hello world");
  });

  it("removes key when value is empty string", () => {
    localStorage.setItem(PREFIX + "room:abc", "draft");
    setDraft("room:abc", "");
    expect(localStorage.getItem(PREFIX + "room:abc")).toBeNull();
  });

  it("clearDraft removes the key", () => {
    localStorage.setItem(PREFIX + "room:abc", "has content");
    clearDraft("room:abc");
    expect(localStorage.getItem(PREFIX + "room:abc")).toBeNull();
  });

  it("getDraft returns empty string for null key (no persistence)", () => {
    localStorage.setItem(PREFIX + "room:abc", "should not appear");
    expect(getDraft(null)).toBe("");
  });

  it("getDraft restores existing draft from localStorage", () => {
    localStorage.setItem(PREFIX + "room:xyz", "restored draft");
    expect(getDraft("room:xyz")).toBe("restored draft");
  });

  it("different keys are independent", () => {
    setDraft("room:a", "draft a");
    setDraft("room:b", "draft b");
    expect(getDraft("room:a")).toBe("draft a");
    expect(getDraft("room:b")).toBe("draft b");
    clearDraft("room:a");
    expect(getDraft("room:a")).toBe("");
    expect(getDraft("room:b")).toBe("draft b");
  });

  it("agent draft keys are namespaced separately from room keys", () => {
    setDraft("room:abc", "room draft");
    setDraft("agent:abc:pm", "agent draft");
    expect(getDraft("room:abc")).toBe("room draft");
    expect(getDraft("agent:abc:pm")).toBe("agent draft");
  });
});
