import { onCatalogChanged } from "../config/catalog.js";
import { refreshAllInstanceModelRegistries } from "../agent/orchestrator/agent-manager.js";

/** Configuration reports changes; only the composition root connects them to execution. */
export function wireConfiguration(): () => void {
  return onCatalogChanged(async () => { await refreshAllInstanceModelRegistries(); });
}
