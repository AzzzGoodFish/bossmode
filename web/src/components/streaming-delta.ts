export function appendStreamDelta(current: string | null | undefined, delta: unknown): string | null {
  if (typeof delta !== "string" || delta.length === 0) return current ?? null;
  return `${current ?? ""}${delta}`;
}

export function finalStreamContent(finalContent: unknown, liveContent: string | null | undefined): string | null {
  if (typeof finalContent === "string" && finalContent.length > 0) return finalContent;
  return liveContent && liveContent.length > 0 ? liveContent : null;
}
