export type ActivationSource = "room_mention" | "private_instruction" | "self_start" | "system";

const THIRTY_MIN_MS = 30 * 60_000;
const latestActivation = new Map<string, { source: ActivationSource; at: number }>();

function key(roomId: string, agentName: string): string {
  return `${roomId}:${agentName}`;
}

export function setActivationSource(roomId: string, agentName: string, source: ActivationSource): void {
  latestActivation.set(key(roomId, agentName), { source, at: Date.now() });
}

export function getActivationSource(roomId: string, agentName: string): ActivationSource | null {
  const entry = latestActivation.get(key(roomId, agentName));
  if (!entry) return null;
  if (Date.now() - entry.at > THIRTY_MIN_MS) return null;
  return entry.source;
}

export function clearActivationSource(roomId: string, agentName: string): void {
  latestActivation.delete(key(roomId, agentName));
}

export function clearAllActivationSources(): void {
  latestActivation.clear();
}
