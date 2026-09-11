import { describe, expect, it } from "vitest";
import { createWebSocketUrl } from "./websocket-url";
describe("createWebSocketUrl", () => {
  it("keeps the daemon's root-path contract", () =>
    expect(createWebSocketUrl("http://host:12530/chat", "test")).toBe(
      "ws://host:12530/?token=test",
    ));
  it("uses secure WebSockets for HTTPS", () =>
    expect(createWebSocketUrl("https://host/chat", "test")).toBe(
      "wss://host/?token=test",
    ));
  it("can point Vite's browser connection at the isolated daemon port", () =>
    expect(
      createWebSocketUrl("http://dev.example.test:18783/", "test", "12530"),
    ).toBe("ws://dev.example.test:12530/?token=test"));
  it("never carries navigation fragments or unrelated query values", () =>
    expect(
      createWebSocketUrl("http://host/path?unrelated=yes#fragment", "test"),
    ).toBe("ws://host/?token=test"));
  it("encodes a token as one query value", () =>
    expect(
      new URL(
        createWebSocketUrl("http://host/", "test&key=other"),
      ).searchParams.get("token"),
    ).toBe("test&key=other"));
  it("supports IPv6 hosts without concatenating invalid authority strings", () =>
    expect(createWebSocketUrl("http://[::1]:18783/", "test", "12530")).toBe(
      "ws://[::1]:12530/?token=test",
    ));
});
