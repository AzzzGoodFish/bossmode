export function isSameLocalDate(a: number | Date, b: number | Date): boolean {
  const left = a instanceof Date ? a : new Date(a);
  const right = b instanceof Date ? b : new Date(b);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

export function formatMessageDateSeparator(ts: number, now: number = Date.now()): string {
  if (isSameLocalDate(ts, now)) return "今天";
  return new Date(ts).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
