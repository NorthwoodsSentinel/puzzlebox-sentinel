// The watch loop against an in-memory client: subscription outcomes, the poll schedule, and every degraded
// cycle (failed poll, empty snapshot). The end-to-end run over real HTTP lives in integration.test.ts.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { PuzzleboxClient } from "../src/client.ts";
import { verifyBundle } from "../src/evidence.ts";
import { Sentinel, type SentinelOptions } from "../src/sentinel.ts";
import type { GuardEvidenceBundle } from "../src/types.ts";
import { InteriorWatcher } from "../src/watcher.ts";

const KEY = `throwaway-${Math.random().toString(36).slice(2)}`;
const T0 = Date.parse("2026-07-28T12:00:00.000Z");

class FakeClient implements PuzzleboxClient {
  closed = 0;
  onUpdated: (() => void) | null = null;
  constructor(
    public snapshot: () => Promise<unknown>,
    private readonly subscribeResult: () => Promise<boolean> = async () => true,
  ) {}
  async initialize(): Promise<void> {}
  async callTool(): Promise<unknown> {
    return this.snapshot();
  }
  async subscribe(_uri: string, onUpdated: () => void): Promise<boolean> {
    this.onUpdated = onUpdated;
    return this.subscribeResult();
  }
  close(): void {
    this.closed++;
  }
}

function harness(client: PuzzleboxClient, extra: Partial<SentinelOptions> = {}) {
  const bundles: GuardEvidenceBundle[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const sentinel = new Sentinel(client, {
    puzzleId: "p1",
    key: KEY,
    config: { default_dwell_threshold_seconds: 30 },
    pollIntervalMs: 1000,
    onBundle: (b) => bundles.push(b),
    onWarning: (w) => warnings.push(w),
    onLog: (l) => logs.push(l),
    ...extra,
  });
  return { sentinel, bundles, warnings, logs };
}

const snap = (currentState?: string, availableActions?: string[]) => async () => ({ currentState, availableActions });

afterEach(() => {
  vi.useRealTimers();
});

describe("Sentinel", () => {
  test("start subscribes, ticks at once, then polls on the interval until stopped", async () => {
    vi.useFakeTimers();
    const client = new FakeClient(snap("PLAYING", ["END"]));
    const { sentinel, bundles, logs } = harness(client);
    await sentinel.start();
    expect(logs[0]).toBe("subscribed to puzzlebox:/puzzle/p1 — resource updates count as activity");
    expect(bundles).toHaveLength(1);

    // Resource updates feed the activity count.
    client.onUpdated?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bundles).toHaveLength(2);
    expect(bundles[1].activity_count).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bundles).toHaveLength(3);

    sentinel.stop();
    expect(client.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bundles).toHaveLength(3);
    for (const b of bundles) expect(verifyBundle(b, KEY)).toBe(true);
  });

  test("a stop that lands during a tick ends the schedule after that tick", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    let calls = 0;
    const client = new FakeClient(async () => {
      calls++;
      if (calls === 2) await new Promise<void>((r) => (release = r));
      return { currentState: "PLAYING" };
    });
    const { sentinel, bundles } = harness(client);
    await sentinel.start();
    await vi.advanceTimersByTimeAsync(1000); // second tick starts and blocks
    sentinel.stop();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(bundles).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test("a refused or failing subscription falls back to polling, never fatal", async () => {
    for (const subscribe of [async () => false, async () => Promise.reject(new Error("nope"))]) {
      const { sentinel, logs, bundles } = harness(new FakeClient(snap("PLAYING"), subscribe));
      await sentinel.start();
      sentinel.stop();
      expect(logs[0]).toBe("subscription unavailable — falling back to snapshot polling only");
      expect(bundles).toHaveLength(1);
    }
  });

  test("stop before start closes the client without a timer to clear", () => {
    const client = new FakeClient(snap("PLAYING"));
    harness(client).sentinel.stop();
    expect(client.closed).toBe(1);
  });

  test("a failed poll skips the cycle and logs why", async () => {
    let thrown: unknown = new Error("server down");
    const { sentinel, bundles, logs } = harness(
      new FakeClient(async () => {
        throw thrown;
      }),
    );
    expect(await sentinel.tick(T0)).toBeNull();
    thrown = "plain failure";
    expect(await sentinel.tick(T0)).toBeNull();
    expect(bundles).toHaveLength(0);
    expect(logs).toEqual([
      "snapshot poll failed: server down — skipping cycle",
      "snapshot poll failed: plain failure — skipping cycle",
    ]);
  });

  test("a snapshot without a current state skips the cycle", async () => {
    const { sentinel, bundles, logs } = harness(new FakeClient(snap(undefined)));
    expect(await sentinel.tick(T0)).toBeNull();
    expect(bundles).toHaveLength(0);
    expect(logs).toEqual(["puzzle p1: no current state in snapshot — skipping cycle"]);
  });

  test("no onLog sink is fine on every log path", async () => {
    const { sentinel } = harness(new FakeClient(async () => Promise.reject(new Error("x"))), { onLog: undefined });
    await sentinel.start();
    sentinel.stop();
    const empty = harness(new FakeClient(snap(undefined)), { onLog: undefined });
    expect(await empty.sentinel.tick(T0)).toBeNull();
  });

  test("an assessment of null emits nothing", async () => {
    vi.spyOn(InteriorWatcher.prototype, "assess").mockResolvedValue(null);
    const { sentinel, bundles } = harness(new FakeClient(snap("PLAYING")));
    expect(await sentinel.tick(T0)).toBeNull();
    expect(bundles).toHaveLength(0);
  });

  test("a stuck interior emits one warning naming the verdict and findings", async () => {
    const { sentinel, warnings } = harness(new FakeClient(snap("PLAYING")));
    await sentinel.tick(T0);
    const stuck = await sentinel.tick(T0 + 31_000);
    expect(stuck?.verdict).toBe("stuck");
    await sentinel.tick(T0 + 60_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WARNING: puzzle p1 verdict=stuck in state "PLAYING" — state "PLAYING" dwelled 31s/);
  });

  test("tick defaults its clock to now", async () => {
    const { sentinel } = harness(new FakeClient(snap("PLAYING")));
    const b = await sentinel.tick();
    expect(Math.abs(Date.parse(b!.ts) - Date.now())).toBeLessThan(5000);
  });

  test("a supplied drift adapter is used", async () => {
    const { sentinel } = harness(new FakeClient(snap("PLAYING")), {
      config: { default_dwell_threshold_seconds: 30, drift_threshold: 0.5 },
      drift: { name: "fixed", score: async () => 0.8 },
    });
    expect((await sentinel.tick(T0))?.verdict).toBe("drifting");
  });
});
