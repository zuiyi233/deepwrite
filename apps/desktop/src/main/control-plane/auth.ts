import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer-token check for the local control plane. Both sides
 * are hashed to a fixed 32-byte digest so timingSafeEqual never throws on
 * length mismatch and cannot leak the token length.
 */
export function isAuthorized(
  authorizationHeader: string | undefined,
  token: string
): boolean {
  if (!authorizationHeader || !token) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match?.[1]) return false;
  return timingSafeEqual(hashToken(match[1]), hashToken(token));
}

function hashToken(value: string): Buffer {
  return createHash("sha256").update(value, "utf-8").digest();
}
