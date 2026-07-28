// End-to-end against the mock puzzlebox fixture: real HTTP, real JSON-RPC
// framing, real signing — only the clock is driven by the test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StreamableHttpClient } from "../src/client.ts";
import { verifyBundle } from "../src/evidence.ts";
import { Sentinel } from "../src/sentinel.ts";
import type { GuardEvidenceBundle } from "../src/types.ts";
import { startMockPuzzlebox, type MockPuzzlebox } from "./mock-puzzlebox.ts";

const KEY = "integration-test-key";
const T0 = Date.parse("2026-07-28T12:00:00.000Z");
const SECONDS = 1000;

describe("sentinel against a mock puzzlebox", () => {
  let mock: MockPuzzlebox;
  let sentinel: Sentinel;
  const bundles: GuardEvidenceBundle[] = [];
  const warnings: string[] = [];

  beforeAll(async () => {
    mock = startMockPuzzlebox("SPECIFICATION", ["APPROVE_SPEC"]);
    const client = new StreamableHttpClient(`${mock.url}/mcp`);
    await client.initialize();
    sentinel = new Sentinel(client, {
      puzzleId: "puzzle-xyz",
      key: KEY,
      config: { default_dwell_threshold_seconds: 30 },
      pollIntervalMs: 60_000, // irrelevant — ticks are driven manually
      onBundle: (b) => bundles.push(b),
      onWarning: (w) => warnings.push(w),
    });
  });

  afterAll(() => {
    sentinel.stop();
    mock.stop();
  });

  test("first tick observes the state and reports healthy", async () => {
    const bundle = await sentinel.tick(T0);
    expect(bundle).not.toBeNull();
    expect(bundle!.puzzle_id).toBe("puzzle-xyz");
    expect(bundle!.state).toBe("SPECIFICATION");
    expect(bundle!.verdict).toBe("healthy");
    expect(bundle!.evidence_version).toBe("0.1");
    expect(warnings.length).toBe(0);
  });

  test("unchanged state past threshold becomes stuck, with one warning", async () => {
    const bundle = await sentinel.tick(T0 + 45 * SECONDS);
    expect(bundle!.verdict).toBe("stuck");
    expect(bundle!.dwell_seconds).toBe(45);
    expect(bundle!.activity_count).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("stuck");

    // Later ticks keep reporting stuck without re-warning.
    const again = await sentinel.tick(T0 + 90 * SECONDS);
    expect(again!.verdict).toBe("stuck");
    expect(warnings.length).toBe(1);
  });

  test("every emitted bundle carries a valid HMAC; tampered copies fail", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const b of bundles) {
      expect(verifyBundle(b, KEY)).toBe(true);
      const flipped = b.verdict === "healthy" ? "stuck" : "healthy";
      expect(verifyBundle({ ...b, verdict: flipped }, KEY)).toBe(false);
      expect(verifyBundle(b, "wrong-key")).toBe(false);
    }
  });

  test("a state transition on the server resets the interior to healthy", async () => {
    mock.setState("DESIGN", ["APPROVE_DESIGN"]);
    const bundle = await sentinel.tick(T0 + 120 * SECONDS);
    expect(bundle!.state).toBe("DESIGN");
    expect(bundle!.verdict).toBe("healthy");
    expect(bundle!.dwell_seconds).toBe(0);
  });

  test("the mock actually served the snapshot tool over HTTP", () => {
    expect(mock.snapshotCalls()).toBeGreaterThanOrEqual(4);
  });
});
