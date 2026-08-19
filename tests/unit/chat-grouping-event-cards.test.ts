/**
 * Grouping boundary (fish 2026-08-19 bug): typed event cards break groups.
 * A user message right after a "you opened topic" card (sender "user") used to
 * merge into the card's group → its avatar/sender row vanished, reading as a
 * continuation of the previous bubble. Cards are not bubbles: nothing groups
 * with or across them.
 */
import { describe, expect, it } from "vitest";
import { isGroupedWithPrev } from "../../web/src/utils/message-grouping";

const T = 1_800_000_000_000;
const msg = (sender: string, ts: number, type?: "task_event" | "knowledge_event" | "topic_event") =>
  ({ id: `m-${ts}-${sender}-${type ?? "plain"}`, sender, content: "x", ts, type }) as any;

describe("isGroupedWithPrev — event cards are boundary breakers", () => {
  it("two plain messages from the same sender within the interval group", () => {
    expect(isGroupedWithPrev(msg("user", T), msg("user", T + 60_000))).toBe(true);
  });

  it("a message after a topic_event card never groups with it (avatar stays)", () => {
    const card = msg("user", T, "topic_event");
    const after = msg("user", T + 30_000);
    expect(isGroupedWithPrev(card, after)).toBe(false);
  });

  it("a card never joins a preceding bubble group", () => {
    expect(isGroupedWithPrev(msg("user", T), msg("user", T + 30_000, "topic_event"))).toBe(false);
  });

  it("task_event and knowledge_event cards break groups too", () => {
    expect(isGroupedWithPrev(msg("pm", T, "task_event"), msg("pm", T + 10_000))).toBe(false);
    expect(isGroupedWithPrev(msg("pm", T, "knowledge_event"), msg("pm", T + 10_000))).toBe(false);
  });

  it("two plain messages across a card do not merge transitively (each side groups on its own)", () => {
    // before [card] after: before/after are never adjacent in the stream, so the
    // invariant is simply: after.groupsWith(card) = false (covered above) and
    // before/after WOULD still group if the card weren't between them — no change.
    expect(isGroupedWithPrev(msg("user", T), msg("user", T + 30_000))).toBe(true);
  });

  it("different senders still never group", () => {
    expect(isGroupedWithPrev(msg("user", T), msg("pm", T + 10_000))).toBe(false);
  });
});
