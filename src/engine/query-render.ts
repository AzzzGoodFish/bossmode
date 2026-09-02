/**
 * Member-view rendering for query_room_messages (fish/architect rc.8 read-chain).
 * One renderer for both output modes: inline SDK text and markdown file export.
 * Row shape = the tool's JSON projection (seq/sender/content/ts/replyTo/attachments).
 */
import { getUserDisplayName } from "../shared/user-identity.js";

/** Same mapping as the activation envelope (message-envelope.ts): user → display name. */
function senderDisplayName(sender: string): string {
  return sender === "user" ? getUserDisplayName() : sender;
}

export interface QueryRowReplyTo {
  seq: number;
  messageId: string;
  sender?: string;
  excerpt?: string;
  unavailable?: boolean;
}

export interface QueryRow {
  seq?: number;
  sender: string;
  content: string;
  ts?: number;
  replyTo?: QueryRowReplyTo;
  attachments?: Array<{ originalFilename: string; path: string }>;
}

function replyToLine(replyTo: QueryRowReplyTo): string {
  if (replyTo.unavailable || !replyTo.sender || !replyTo.excerpt) {
    return `[In reply to msg:#${replyTo.seq} — original not visible in this context]`;
  }
  return `[In reply to msg:#${replyTo.seq} from ${senderDisplayName(replyTo.sender)}]: "${replyTo.excerpt}"`;
}

function attachmentLines(attachments: QueryRow["attachments"]): string[] {
  return (attachments || []).map(
    (a) => `Attachment: [original filename: ${a.originalFilename}](${a.path})`,
  );
}

/** Render one row as the member sees it: header + reply quote + content + attachments. */
export function renderQueryRowForMember(row: QueryRow): string {
  const seq = row.seq !== undefined ? `No.${row.seq}` : "";
  const time = typeof row.ts === "number" ? new Date(row.ts).toISOString() : "";
  const headerBits = [seq, senderDisplayName(row.sender), time].filter(Boolean).join(" · ");
  const parts: string[] = [`[${headerBits}]`];
  if (row.replyTo) parts.push(replyToLine(row.replyTo));
  if (row.content?.trim()) parts.push(row.content);
  parts.push(...attachmentLines(row.attachments));
  return parts.filter((p) => p !== "").join("\n");
}

/** Render a page of rows (blank line between messages). */
export function renderQueryRowsForMember(rows: QueryRow[]): string {
  if (rows.length === 0) return "No messages found.";
  return rows.map((m) => renderQueryRowForMember(m)).join("\n\n");
}
