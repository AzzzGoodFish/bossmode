// Mock runtime for testing — implements AgentRuntime + AgentHandle
import { vi } from "vitest";
import {randomUUID} from "node:crypto";
import {getDatabase} from "../../src/data/database.js";
import type {
  AgentRuntime,
  AgentHandle,
  AgentStreamEvent,
  CreateAgentOpts,
  RuntimeCapabilities,
  RuntimeDetectResult,
} from "../../src/agent/runtime/types.js";

// Mutable mock state — tests can reassign via setMockPromptFn etc.
export let mockPromptFn = vi.fn().mockResolvedValue(undefined);
export let mockCompactFn = vi.fn().mockResolvedValue(undefined);
export let mockSteerFn = vi.fn();
export let mockAbortFn = vi.fn();
export let mockIsWorking = false;

// Live mock handles — acceptance tests emit stream events (message_end/tool_end)
// from inside mockPromptFn via emitMockEvent to exercise turn settlement.
const liveHandles: MockAgentHandle[] = [];

export function emitMockEvent(event: AgentStreamEvent): void {
  for (const h of liveHandles) h.emit(event);
}

export function setMockPromptFn(fn: any): void { mockPromptFn = fn; }
export function setMockCompactFn(fn: any): void { mockCompactFn = fn; }
export function setMockSteerFn(fn: any): void { mockSteerFn = fn; }
export function setMockIsWorking(v: boolean): void { mockIsWorking = v; }

export function resetMocks(): void {
  mockPromptFn = vi.fn().mockResolvedValue(undefined);
  mockCompactFn = vi.fn().mockResolvedValue(undefined);
  mockSteerFn = vi.fn();
  mockAbortFn = vi.fn();
  mockIsWorking = false;
  liveHandles.length = 0;
}

export class MockAgentHandle implements AgentHandle {
  private listeners = new Set<(event: AgentStreamEvent) => void>();

  constructor() {
    liveHandles.push(this);
  }

  get isWorking(): boolean {
    return mockIsWorking;
  }

  async prompt(message: string,options?:{beforeDispatch?:(event:{attemptId:string;dispatchIndex:number;message:string})=>void}): Promise<void> {
    if(options?.beforeDispatch)getDatabase().transaction(()=>options.beforeDispatch!({attemptId:`mock:${randomUUID()}`,dispatchIndex:0,message}));
    this.emit({ type: "agent_start" });
    try {
      return await mockPromptFn(message);
    } finally {
      this.emit({ type: "agent_end" });
    }
  }

  async compact(): Promise<{ aborted: boolean }> {
    this.emit({ type: "agent_start" });
    this.emit({ type: "compaction_start", reason: "manual" });
    await mockCompactFn();
    this.emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
    this.emit({ type: "agent_end" });
    return { aborted: false };
  }

  abort(): void {
    mockAbortFn();
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  async destroyAndWait(): Promise<void> { this.abort(); await this.waitForIdle(); this.destroy(); }

  destroy(): void {
    this.listeners.clear();
    const index = liveHandles.indexOf(this);
    if (index >= 0) liveHandles.splice(index, 1);
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
  readonly name: string;
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
  private owners = new WeakMap<MockAgentHandle,string>();

  constructor(name = "mock") {
    this.name = name;
  }

  async detect(): Promise<RuntimeDetectResult> {
    return { available: true, version: "mock-1.0", path: "/mock" };
  }

  async createAgent(_opts: CreateAgentOpts): Promise<AgentHandle> {
    const handle = new MockAgentHandle();
    this.handles.push(handle);
    this.owners.set(handle,_opts.member.id);
    return handle;
  }

  async shutdownMember(memberId:string): Promise<void> {
    await Promise.all(this.handles.filter(handle=>this.owners.get(handle)===memberId).map(handle=>handle.destroyAndWait()));
  }

  async shutdownAll(): Promise<void> {
    await Promise.all(this.handles.map(handle=>handle.destroyAndWait()));
    this.handles = [];
  }
}
