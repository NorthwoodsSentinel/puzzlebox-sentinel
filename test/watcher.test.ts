import { describe, expect, test } from "bun:test";
import { InteriorWatcher } from "../src/watcher.ts";
import type { DriftAdapter, WatcherConfig } from "../src/types.ts";

const T0 = Date.parse("2026-07-28T12:00:00.000Z");
const SECONDS = 1000;

const config: WatcherConfig = {
  default_dwell_threshold_seconds: 30,
  per_state_thresholds: { REVIEW: 5 },
};

describe("InteriorWatcher", () => {
  test("healthy before the dwell threshold", async () => {
    const w = new InteriorWatcher("p1", config);
    w.observeState("PLAYING", ["END_GAME"], T0);
    const a = await w.assess(T0 + 10 * SECONDS);
    expect(a!.unsigned.verdict).toBe("healthy");
    expect(a!.unsigned.dwell_seconds).toBe(10);
    expect(a!.new_warning).toBe(false);
  });

  test("stuck after threshold with zero activity, warns exactly once", async () => {
    const w = new InteriorWatcher("p1", config);
    w.observeState("PLAYING", [], T0);

    const first = await w.assess(T0 + 31 * SECONDS);
    expect(first!.unsigned.verdict).toBe("stuck");
    expect(first!.unsigned.activity_count).toBe(0);
    expect(first!.unsigned.findings.length).toBeGreaterThan(0);
    expect(first!.new_warning).toBe(true);

    const second = await w.assess(T0 + 60 * SECONDS);
    expect(second!.unsigned.verdict).toBe("stuck");
    expect(second!.new_warning).toBe(false); // already warned for this entry
  });

  test("observed activity prevents a stuck verdict", async () => {
    const w = new InteriorWatcher("p1", config);
    w.observeState("PLAYING", [], T0);
    w.recordActivity();
    const a = await w.assess(T0 + 60 * SECONDS);
    expect(a!.unsigned.verdict).toBe("healthy");
    expect(a!.unsigned.activity_count).toBe(1);
    // The long dwell is still on the record as a finding.
    expect(a!.unsigned.findings.some((f) => f.includes("not stuck"))).toBe(true);
  });

  test("a state transition resets the interior clock and re-arms the warning", async () => {
    const w = new InteriorWatcher("p1", config);
    w.observeState("PLAYING", [], T0);
    await w.assess(T0 + 31 * SECONDS); // stuck, warned

    const moved = w.observeState("GAME_OVER", ["RESTART"], T0 + 40 * SECONDS);
    expect(moved.transitioned).toBe(true);

    const fresh = await w.assess(T0 + 45 * SECONDS);
    expect(fresh!.unsigned.state).toBe("GAME_OVER");
    expect(fresh!.unsigned.dwell_seconds).toBe(5);
    expect(fresh!.unsigned.verdict).toBe("healthy");

    const stuckAgain = await w.assess(T0 + 71 * SECONDS);
    expect(stuckAgain!.unsigned.verdict).toBe("stuck");
    expect(stuckAgain!.new_warning).toBe(true); // re-armed by the transition
  });

  test("per-state threshold override wins over the default", async () => {
    const w = new InteriorWatcher("p1", config);
    w.observeState("REVIEW", [], T0); // REVIEW threshold is 5s
    const a = await w.assess(T0 + 6 * SECONDS);
    expect(a!.unsigned.verdict).toBe("stuck");
  });

  test("drift adapter score above threshold produces a drifting verdict", async () => {
    const adapter: DriftAdapter = { name: "fake", score: async () => 0.9 };
    const w = new InteriorWatcher("p1", { ...config, drift_threshold: 0.7 }, adapter);
    w.observeState("PLAYING", [], T0);
    const a = await w.assess(T0 + 1 * SECONDS);
    expect(a!.unsigned.verdict).toBe("drifting");
    expect(a!.unsigned.drift_score).toBe(0.9);
    expect(a!.new_warning).toBe(true);
  });

  test("a throwing drift adapter degrades to null with a finding, never crashes", async () => {
    const adapter: DriftAdapter = {
      name: "broken",
      score: async () => {
        throw new Error("adapter exploded");
      },
    };
    const w = new InteriorWatcher("p1", { ...config, drift_threshold: 0.7 }, adapter);
    w.observeState("PLAYING", [], T0);
    const a = await w.assess(T0 + 1 * SECONDS);
    expect(a!.unsigned.drift_score).toBeNull();
    expect(a!.unsigned.verdict).toBe("healthy");
    expect(a!.unsigned.findings.some((f) => f.includes("adapter exploded"))).toBe(true);
  });

  test("assess before any observation returns null", async () => {
    const w = new InteriorWatcher("p1", config);
    expect(await w.assess(T0)).toBeNull();
  });
});
