// Clerk JWT verification, server-side, with no HTTP round-trip per call.
//
// @clerk/backend exposes `verifyToken` which fetches and caches the JWKS
// from the Clerk instance referenced by CLERK_SECRET_KEY. For our WS
// handshake we want fast and synchronous-feeling — we do at most one
// JWKS fetch per pod lifetime, then verify locally.
//
// The mobile client sends its JWT in the `Sec-WebSocket-Protocol` header
// as `Bearer.<token>` — RFC 6455 lets us repurpose subprotocols for this
// because we don't actually need a real WS subprotocol. Query param
// would also work but tokens in URLs are a classic logging hazard.

import { createClerkClient, verifyToken } from "@clerk/backend";
import { loadEnv } from "./env.js";

const env = loadEnv();

const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
});

export interface VerifiedSession {
  clerkUserId: string;
}

/**
 * Extracts a Bearer token from a `Sec-WebSocket-Protocol` header value.
 * The header arrives as a comma-separated list of subprotocols; we look
 * for "Bearer.XYZ" (we use `.` instead of space because the WS subprotocol
 * grammar doesn't allow whitespace).
 */
export function extractBearerFromSubprotocol(
  header: string | string[] | undefined,
): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(",") : header;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("Bearer.")) {
      return trimmed.slice("Bearer.".length);
    }
  }
  return null;
}

export async function verifyClerkBearer(
  token: string,
): Promise<VerifiedSession | null> {
  try {
    const claims = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    if (!claims?.sub) return null;
    return { clerkUserId: claims.sub };
  } catch {
    return null;
  }
}

// Exported in case we need to mutate Clerk state later (e.g. revoke
// session on abuse). Not used today.
export const clerkClient = clerk;
