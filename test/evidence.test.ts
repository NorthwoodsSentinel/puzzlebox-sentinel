import { describe, expect, test } from "vitest";
import { canonicalJson, computeHmac, signBundle, verifyBundle } from "../src/evidence.ts";
import type { UnsignedBundle } from "../src/types.ts";

const KEY = "test-shared-key";

function sampleUnsigned(): UnsignedBundle {
  return {
    puzzle_id: "0xABC",
    state: "PLAYING",
    entered_at: "2026-07-28T12:00:00.000Z",
    dwell_seconds: 42.5,
    activity_count: 0,
    drift_score: null,
    findings: ['state "PLAYING" dwelled 42s with zero observed activity (threshold 30s)'],
    verdict: "stuck",
    ts: "2026-07-28T12:00:42.500Z",
    evidence_version: "0.1",
  };
}

describe("canonicalJson", () => {
  test("is independent of key insertion order", () => {
    const a = { one: 1, two: { b: 2, a: [1, { z: 9, y: 8 }] } };
    const b = { two: { a: [1, { y: 8, z: 9 }], b: 2 }, one: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test("preserves array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  test("drops undefined-valued keys", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("sign and verify", () => {
  test("a signed bundle verifies with the same key", () => {
    const bundle = signBundle(sampleUnsigned(), KEY);
    expect(bundle.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyBundle(bundle, KEY)).toBe(true);
  });

  test("verification survives key-order shuffling in transit", () => {
    const bundle = signBundle(sampleUnsigned(), KEY);
    const shuffled = JSON.parse(JSON.stringify(bundle, Object.keys(bundle).sort().reverse()));
    expect(verifyBundle(shuffled, KEY)).toBe(true);
  });

  test("tampering with any field breaks verification", () => {
    const bundle = signBundle(sampleUnsigned(), KEY);
    expect(verifyBundle({ ...bundle, verdict: "healthy" }, KEY)).toBe(false);
    expect(verifyBundle({ ...bundle, dwell_seconds: 1 }, KEY)).toBe(false);
    expect(verifyBundle({ ...bundle, findings: [] }, KEY)).toBe(false);
  });

  test("the wrong key fails", () => {
    const bundle = signBundle(sampleUnsigned(), KEY);
    expect(verifyBundle(bundle, "some-other-key")).toBe(false);
  });

  test("malformed input returns false instead of throwing", () => {
    expect(verifyBundle(null, KEY)).toBe(false);
    expect(verifyBundle("a string", KEY)).toBe(false);
    expect(verifyBundle([1, 2, 3], KEY)).toBe(false);
    expect(verifyBundle({ no_hmac: true }, KEY)).toBe(false);
    expect(verifyBundle({ ...sampleUnsigned(), hmac: "zz-not-hex" }, KEY)).toBe(false);
  });

  test("the right HMAC in a non-canonical spelling is still rejected", () => {
    // Buffer.from(…, "hex") would decode these to the correct 32 bytes; only the strict 64-lowercase-hex check
    // stops them, so these cases pin that check.
    const bundle = signBundle(sampleUnsigned(), KEY);
    expect(verifyBundle({ ...bundle, hmac: bundle.hmac.toUpperCase() }, KEY)).toBe(false);
    expect(verifyBundle({ ...bundle, hmac: `${bundle.hmac}zz` }, KEY)).toBe(false);
    expect(verifyBundle({ ...bundle, hmac: bundle.hmac.slice(0, 62) }, KEY)).toBe(false);
  });

  test("hmac is computed over the unsigned fields only", () => {
    const unsigned = sampleUnsigned();
    const bundle = signBundle(unsigned, KEY);
    expect(bundle.hmac).toBe(computeHmac(unsigned, KEY));
  });
});
