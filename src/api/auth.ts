import {validateToken} from "../services/auth-service.js";

export function extractToken(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

export function requireAuth(headers: Record<string, string | string[] | undefined>): boolean {
  const token = extractToken(headers);
  if (!token) return false;
  return validateToken(token);
}
