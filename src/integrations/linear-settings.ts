import { readConfig, writeConfig } from "../shared/config.js";
import { getRoom, updateRoomLinearIntegration } from "../workspace/room-store.js";
import type { RoomLinearIntegration } from "../shared/types.js";

export function getLinearApiKey(): string | undefined {
  try { return readConfig().integrations?.linear?.apiKey; } catch { return undefined; }
}

export function setLinearApiKey(apiKey: string): void {
  const cfg = readConfig();
  cfg.integrations = { ...(cfg.integrations || {}), linear: { apiKey } };
  writeConfig(cfg);
}

export function clearLinearApiKey(): void {
  const cfg = readConfig();
  if (cfg.integrations?.linear) delete cfg.integrations.linear;
  if (cfg.integrations && Object.keys(cfg.integrations).length === 0) delete cfg.integrations;
  writeConfig(cfg);
}

export function getRoomLinearIntegration(roomId: string): RoomLinearIntegration | undefined {
  return getRoom(roomId)?.integrations?.linear;
}

export function saveRoomLinearIntegration(roomId: string, config: RoomLinearIntegration | null): RoomLinearIntegration | undefined {
  return updateRoomLinearIntegration(roomId, config)?.integrations?.linear;
}
