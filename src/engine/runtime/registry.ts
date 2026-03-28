// Runtime Registry — loads enabled runtimes from config
import type { AgentRuntime, RuntimesConfig } from "./types.js";
import { logger } from "../../foundation/logger.js";

export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();

  async init(config: RuntimesConfig): Promise<void> {
    for (const [name, conf] of Object.entries(config.runtimes)) {
      if (!conf.enabled) continue;

      // Runtimes are registered externally via register()
      const runtime = this.runtimes.get(name);
      if (runtime) {
        const result = await runtime.detect();
        if (result.available) {
          logger.info("runtime", `${name}: detected`, { version: result.version, path: result.path });
        } else {
          logger.warn("runtime", `${name}: not available`, { error: result.error });
          this.runtimes.delete(name);
        }
      }
    }
  }

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  get(name: string): AgentRuntime | undefined {
    return this.runtimes.get(name);
  }

  getAll(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  getCapabilities(): Record<string, { capabilities: AgentRuntime["capabilities"]; name: string }> {
    const result: Record<string, { capabilities: AgentRuntime["capabilities"]; name: string }> = {};
    for (const [name, rt] of this.runtimes) {
      result[name] = { name: rt.name, capabilities: rt.capabilities };
    }
    return result;
  }
}

