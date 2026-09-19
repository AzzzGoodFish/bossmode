import type { AgentSession } from "@earendil-works/pi-coding-agent";
export async function shutdownSdkSession(session: AgentSession, beforeDispose?: () => void, settleResources?: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  try {
    await session.abort();
  } catch (err: any) {
    errors.push(`abort: ${err?.message || String(err)}`);
  }
  try {
    session.abortCompaction();
    session.abortBranchSummary();
  } catch {}
  try { await settleResources?.(); } catch (error) { errors.push(`resource settlement: ${String(error)}`); }
  const runner: any = session.extensionRunner;
  if (typeof runner?.hasHandlers === "function" && runner.hasHandlers("session_shutdown")) {
    // Handler failures surface via onError ({extensionPath, event, error}),
    // never as emit() rejections — collect them for THIS shutdown only.
    const shutdownErrors: string[] = [];
    const off = typeof runner.onError === "function"
      ? runner.onError((e: any) => {
          if (e?.event === "session_shutdown") shutdownErrors.push(`${e?.extensionPath ?? "extension"}: ${e?.error ?? "unknown error"}`);
        })
      : null;
    try {
      await runner.emit({ type: "session_shutdown" } as any);
    } catch (err: any) {
      errors.push(`session_shutdown emit: ${err?.message || String(err)}`);
    } finally {
      try { off?.(); } catch {}
    }
    errors.push(...shutdownErrors);
  }
  try { beforeDispose?.(); } catch {}
  // Always runs, even when earlier stages failed. dispose() is synchronous
  // and throws AggregateError when a registered resource cleanup fails.
  try {
    session.dispose();
  } catch (err: any) {
    const detail = err instanceof AggregateError && Array.isArray(err.errors)
      ? err.errors.map((e: any) => e?.message || String(e)).join(", ")
      : err?.message || String(err);
    errors.push(`dispose: ${detail}`);
  }
  return errors;
}
