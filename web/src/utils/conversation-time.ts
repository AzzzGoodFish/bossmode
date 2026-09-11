export function conversationTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today))
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return "昨天";
  const short = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === today.getFullYear()
    ? short
    : `${date.getFullYear()}/${short}`;
}
