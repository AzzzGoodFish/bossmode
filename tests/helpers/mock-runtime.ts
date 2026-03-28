// Mock runtime for testing — implements AgentRuntime + AgentHandle
import { vi } from "vitest";
import type {
  AgentRuntime,
  AgentHandle,
  AgentStreamEvent,
  CreateAgentOpts,
  RuntimeCapabilities,
  RuntimeDetectResult,
} from "../../src/engine/runtime/types.js";

// Mutable mock state — tests can reassign via setMockPromptFn etc.
export let mockPromptFn = vi.fn().mockResolvedValue(undefined);
export let mockSteerFn = vi.fn();
export let mockAbortFn = vi.fn();
export let mockIsWorking = false;

export function setMockPromptFn(fn: any): void { mockPromptFn = fn; }
export function setMockSteerFn(fn: any): void { mockSteerFn = fn; }
export function setMockIsWorking(v: boolean): void { mockIsWorking = v; }

export function resetMocks(): void {
  mockPromptFn = vi.fn().mockResolvedValue(undefined);
  mockSteerFn = vi.fn();
  mockAbortFn = vi.fn();
  mockIsWorking = false;
}

export class MockAgentHandle implements AgentHandle {
  private listeners = new Set<(event: AgentStreamEvent) => void>();

  get isWorking(): boolean {
    return mockIsWorking;
  }

  async prompt(message: string): Promise<void> {
    return mockPromptFn(message);
  }

  steer(message: string): void {
    mockSteerFn(message);
  }

  abort(): void {
    mockAbortFn();
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Emit an event to all subscribers (for testing)
  emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }
}

export class MockRuntime implements AgentRuntime {
  readonly name = "mock";
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    thinking: false,
    usage: false,
    dynamicModel: false,
    dynamicThinking: false,
    permissionControl: false,
    sessionResume: false,
  };

  private handles: MockAgentHandle[] = [];

  async detect(): Promise<RuntimeDetectResult> {
    return { available: true, version: "mock-1.0", path: "/mock" };
  }

  async createAgent(_opts: CreateAgentOpts): Promise<AgentHandle> {
    const handle = new MockAgentHandle();
    this.handles.push(handle);
    return handle;
  }

  async shutdownAll(): Promise<void> {
    this.handles = [];
  }
}
