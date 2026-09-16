/**
 * WebSocket test client — connects to the bossmode WS server,
 * sends commands, and collects events for assertion.
 */
import WebSocket from "ws";
import type { WsServerEvent, WsClientCommand } from "../../src/kernel/types.js";

export interface WsTestClient {
  ws: WebSocket;
  events: WsServerEvent[];
  /** Send a typed command */
  send(cmd: WsClientCommand): void;
  /** Wait for an event matching a predicate, with timeout */
  waitFor(predicate: (e: WsServerEvent) => boolean, timeoutMs?: number): Promise<WsServerEvent>;
  /** Wait for N events of a given type */
  waitForCount(type: WsServerEvent["type"], count: number, timeoutMs?: number): Promise<WsServerEvent[]>;
  /** Close the connection */
  close(): Promise<void>;
}

export function createWsClient(wsUrl: string, token: string): Promise<WsTestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}?token=${token}`);
    const events: WsServerEvent[] = [];

    ws.on("open", () => {
      const client: WsTestClient = {
        ws,
        events,

        send(cmd: WsClientCommand) {
          ws.send(JSON.stringify(cmd));
        },

        waitFor(predicate, timeoutMs = 5000) {
          // Check already-received events first
          const existing = events.find(predicate);
          if (existing) return Promise.resolve(existing);

          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`WS waitFor timed out after ${timeoutMs}ms. Events received: ${JSON.stringify(events)}`));
            }, timeoutMs);

            function onMessage(data: WebSocket.Data) {
              try {
                const event = JSON.parse(data.toString()) as WsServerEvent;
                if (predicate(event)) {
                  cleanup();
                  resolve(event);
                }
              } catch { /* ignore parse errors */ }
            }

            function cleanup() {
              clearTimeout(timer);
              ws.off("message", onMessage);
            }

            ws.on("message", onMessage);
          });
        },

        async waitForCount(type, count, timeoutMs = 5000) {
          const collected: WsServerEvent[] = [];

          // Check already-received events
          for (const e of events) {
            if (e.type === type) collected.push(e);
            if (collected.length >= count) return collected;
          }

          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`WS waitForCount(${type}, ${count}) timed out. Got ${collected.length}. Events: ${JSON.stringify(events)}`));
            }, timeoutMs);

            function onMessage(data: WebSocket.Data) {
              try {
                const event = JSON.parse(data.toString()) as WsServerEvent;
                if (event.type === type) collected.push(event);
                if (collected.length >= count) {
                  cleanup();
                  resolve(collected);
                }
              } catch { /* ignore */ }
            }

            function cleanup() {
              clearTimeout(timer);
              ws.off("message", onMessage);
            }

            ws.on("message", onMessage);
          });
        },

        close() {
          return new Promise((resolve) => {
            ws.on("close", () => resolve());
            ws.close();
          });
        },
      };

      resolve(client);
    });

    ws.on("error", reject);

    // Collect all events
    ws.on("message", (data: WebSocket.Data) => {
      try {
        events.push(JSON.parse(data.toString()) as WsServerEvent);
      } catch { /* ignore */ }
    });
  });
}
