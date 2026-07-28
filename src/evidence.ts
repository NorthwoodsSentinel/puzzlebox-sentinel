// puzzlebox-sentinel — evidence bundle signing and verification
// Canonical JSON (recursively sorted keys, no whitespace) + HMAC-SHA256 with a
// shared key. The consumer re-canonicalizes and compares in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { GuardEvidenceBundle, UnsignedBundle } from "./types.ts";

// ── Canonical JSON ────────────────────────────────────────────
// Deterministic serialization: object keys sorted at every depth, arrays kept
// in order, no insignificant whitespace. Two structurally-equal bundles always
// produce byte-identical output, so the HMAC survives key-order shuffles.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

// ── Sign / Verify ─────────────────────────────────────────────

export function computeHmac(unsigned: UnsignedBundle, key: string): string {
  return createHmac("sha256", key).update(canonicalJson(unsigned)).digest("hex");
}

export function signBundle(unsigned: UnsignedBundle, key: string): GuardEvidenceBundle {
  return { ...unsigned, hmac: computeHmac(unsigned, key) };
}

// Verify a received bundle. Strips `hmac`, re-canonicalizes the rest,
// recomputes, compares constant-time. Returns false on any malformed input —
// a verifier that throws on garbage is a verifier that can be crashed.
export function verifyBundle(bundle: unknown, key: string): boolean {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) return false;
  const { hmac, ...rest } = bundle as Record<string, unknown>;
  if (typeof hmac !== "string" || !/^[0-9a-f]{64}$/.test(hmac)) return false;
  const expected = createHmac("sha256", key)
    .update(canonicalJson(rest))
    .digest("hex");
  const a = Buffer.from(hmac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
