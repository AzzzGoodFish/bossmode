/** Domain-local codecs. Never include source payloads in validation errors. */
export function objectJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  const text = JSON.stringify(value);
  if (!text || JSON.parse(text) === null) throw new Error("Invalid JSON object");
  return text;
}
export function optionalJson(value: unknown): string | null { return value == null ? null : objectJson(value); }
export function parseObject(text: string): Record<string, unknown> { return JSON.parse(text) as Record<string, unknown>; }
export function bool(value: boolean | undefined): number | null { return value === undefined ? null : Number(value); }
export function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as T;
}
