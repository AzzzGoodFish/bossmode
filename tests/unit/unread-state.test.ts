import { describe, it, expect } from "vitest";

/**
 * Unit tests for unread state management logic (Layout.tsx).
 * Tests the decision logic in isolation — given an event + current state, what unread state changes?
 */

// Event types that trigger agent tab red dots
const UNREAD_EVENT_TYPES = new Set(["message_end", "agent_end", "user_steer"]);

interface UnreadDecision {
  addUnreadRoom?: string;
  addUnreadTab?: { roomId: string; tabKey: string };
}

/**
 * Pure decision function extracted from Layout's handleWsEvent.
 * Returns what unread state changes should be made.
 */
function decideUnread(
  event: { type: string; roomId?: string; agent?: string; message?: any; event?: any },
  selectedRoomId: string | null,
  activeTabKey: string,
): UnreadDecision {
  if (event.type === "room:message") {
    // F6: user's own messages don't trigger
    if (event.message?.sender === "user") return {};

    if (event.roomId !== selectedRoomId) {
      // F1: different room → sidebar red dot
      return { addUnreadRoom: event.roomId };
    } else if (activeTabKey !== "room") {
      // F3: same room, not on room tab → tab red dot
      return { addUnreadTab: { roomId: event.roomId!, tabKey: "room" } };
    }
    return {};
  }

  if (event.type === "agent:event" && event.roomId === selectedRoomId) {
    const eventType = event.event?.type;
    if (!UNREAD_EVENT_TYPES.has(eventType)) return {};

    if (activeTabKey !== event.agent) {
      // F2: not viewing this agent → tab red dot
      return { addUnreadTab: { roomId: event.roomId!, tabKey: event.agent! } };
    }
  }

  return {};
}

describe("Unread state decision logic", () => {
  const ROOM_A = "room-a";
  const ROOM_B = "room-b";

  // ---- F1: Sidebar Room unread ----

  describe("F1: Sidebar Room unread red dot", () => {
    it("room:message from different room → addUnreadRoom", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_B, message: { sender: "pm" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadRoom).toBe(ROOM_B);
    });

    it("room:message from current room → no sidebar unread", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_A, message: { sender: "pm" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadRoom).toBeUndefined();
    });
  });

  // ---- F2: Agent tab unread ----

  describe("F2: Agent tab unread red dot", () => {
    it("agent:event (message_end) while on room tab → addUnreadTab for agent", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "message_end" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toEqual({ roomId: ROOM_A, tabKey: "developer" });
    });

    it("agent:event (agent_end) while on different agent tab → addUnreadTab", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "agent_end" } },
        ROOM_A,
        "pm",
      );
      expect(result.addUnreadTab).toEqual({ roomId: ROOM_A, tabKey: "developer" });
    });

    it("agent:event (user_steer) while on different tab → addUnreadTab", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "qa", event: { type: "user_steer" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toEqual({ roomId: ROOM_A, tabKey: "qa" });
    });
  });

  // ---- F3: Room tab unread ----

  describe("F3: Room tab unread red dot", () => {
    it("room:message while on agent tab → addUnreadTab for room", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_A, message: { sender: "pm" } },
        ROOM_A,
        "developer",
      );
      expect(result.addUnreadTab).toEqual({ roomId: ROOM_A, tabKey: "room" });
    });
  });

  // ---- F6: User's own messages don't trigger ----

  describe("F6: User's own messages filtered", () => {
    it("room:message from user in different room → no unread", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_B, message: { sender: "user" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadRoom).toBeUndefined();
      expect(result.addUnreadTab).toBeUndefined();
    });

    it("room:message from user in same room → no unread", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_A, message: { sender: "user" } },
        ROOM_A,
        "developer",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });
  });

  // ---- TC-08: Current agent tab doesn't trigger ----

  describe("TC-08: Current agent tab no red dot", () => {
    it("agent:event while viewing that agent → no unread", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "message_end" } },
        ROOM_A,
        "developer",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });
  });

  // ---- TC-09: Agent status changes don't trigger ----

  describe("TC-09: Agent status changes don't trigger", () => {
    it("agent:status event → no unread", () => {
      const result = decideUnread(
        { type: "agent:status", roomId: ROOM_A, agent: "developer" },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadRoom).toBeUndefined();
      expect(result.addUnreadTab).toBeUndefined();
    });
  });

  // ---- High-frequency events filtered ----

  describe("High-frequency agent:event types filtered", () => {
    it("message_update does not trigger unread", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "message_update" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });

    it("tool_start does not trigger unread", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "tool_start" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });

    it("cli:stdout does not trigger unread", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_A, agent: "developer", event: { type: "cli:stdout" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });
  });

  // ---- Edge: agent:event from different room ----

  describe("Edge cases", () => {
    it("agent:event from non-selected room → no tab unread", () => {
      const result = decideUnread(
        { type: "agent:event", roomId: ROOM_B, agent: "developer", event: { type: "message_end" } },
        ROOM_A,
        "room",
      );
      expect(result.addUnreadTab).toBeUndefined();
    });

    it("no selected room → room:message → sidebar unread", () => {
      const result = decideUnread(
        { type: "room:message", roomId: ROOM_A, message: { sender: "pm" } },
        null,
        "room",
      );
      expect(result.addUnreadRoom).toBe(ROOM_A);
    });
  });
});
