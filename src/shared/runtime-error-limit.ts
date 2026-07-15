export const USER_VISIBLE_RUNTIME_ERROR_MAX_LENGTH = 300;

export function limitRuntimeErrorMessage(message: string): string {
  const characters = Array.from(message);
  if (characters.length <= USER_VISIBLE_RUNTIME_ERROR_MAX_LENGTH) return message;
  return `${characters.slice(0, USER_VISIBLE_RUNTIME_ERROR_MAX_LENGTH - 1).join("")}…`;
}

const MEMBER_RUNTIME_FAILURE_PATTERNS = [
  /^Member "[^"]+" request failed\./,
  /^Member "[^"]+" error:/,
  /^Member "[^"]+" runtime ended unexpectedly/,
  /^Member "[^"]+" model credential is no longer available\./,
  /^Failed to create member "[^"]+":/,
  /^Failed to activate member "[^"]+":/,
  /^Failed to switch model for "[^"]+":/,
  /^Failed to switch thinking level for "[^"]+":/,
  /^Failed to refresh model credential for "[^"]+":/,
];

export function isRuntimeFailureRoomMessage(message: { sender: string; content?: string }): boolean {
  if (message.sender !== "system") return false;
  const content = message.content || "";
  return MEMBER_RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(content));
}

export function limitRuntimeFailureRoomMessage<T extends { sender: string; content?: string }>(message: T): T {
  if (!isRuntimeFailureRoomMessage(message) || typeof message.content !== "string") return message;
  const content = limitRuntimeErrorMessage(message.content);
  return content === message.content ? message : { ...message, content };
}

export function limitRuntimeErrorEvent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  const type = record.type;
  const next: Record<string, unknown> = { ...record };
  let changed = false;

  if ((type === "message_end" || type === "compaction_end") && typeof record.errorMessage === "string") {
    next.errorMessage = limitRuntimeErrorMessage(record.errorMessage);
    changed = next.errorMessage !== record.errorMessage;

    if (type === "compaction_end" && typeof record.result === "string") {
      next.result = limitRuntimeErrorMessage(record.result);
      changed = changed || next.result !== record.result;
    } else if (type === "compaction_end" && record.result && typeof record.result === "object") {
      const result = record.result as Record<string, unknown>;
      if (typeof result.error === "string") {
        const error = limitRuntimeErrorMessage(result.error);
        if (error !== result.error) {
          next.result = { ...result, error };
          changed = true;
        }
      }
    }
  }
  if (type === "runtime_exit" && typeof record.stderrTail === "string") {
    next.stderrTail = limitRuntimeErrorMessage(record.stderrTail);
    changed = changed || next.stderrTail !== record.stderrTail;
  }

  return (changed ? next : event) as T;
}
