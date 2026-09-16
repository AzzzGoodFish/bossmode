// Shared JSON value mechanics. Callers own domain fields and error context.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Checks the container only; field types still require domain validation. */
export function requireObject(value: unknown, error = "Expected a JSON object"): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, any>;
}

/** Ordinary persisted objects; optional properties keep JSON.stringify semantics. */
export function objectJson(value: unknown): string {
  requireObject(value);
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") throw new Error("Invalid JSON object");
    parseObject(text);
    return text;
  } catch { throw new Error("Invalid JSON object"); }
}
export function optionalJson(value: unknown): string | null { return value == null ? null : objectJson(value); }
export function parseObject(text: string): Record<string, unknown> {
  try { return requireObject(JSON.parse(text)); }
  catch { throw new Error("Invalid JSON object"); } // Never expose a secret-bearing source in parser errors.
}
export function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined)) as T;
}

/** Canonical JSON for immutable identities: reject lossy values, sort object keys.
 * This deliberately differs from ordinary JSON.stringify's optional-field behavior. */
export function canonicalJson(value: unknown, error = "Invalid JSON"): string {
  const ancestors = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object" || ancestors.has(v)) throw new Error(error);
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error(`${error} array`);
        return `[${Array.from(v, encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error(`${error} object`);
      if (Object.getOwnPropertySymbols(v).length) throw new Error(`${error} symbols`);
      return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { ancestors.delete(v); }
  };
  return encode(value);
}
