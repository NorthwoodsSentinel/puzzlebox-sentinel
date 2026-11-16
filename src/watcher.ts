// puzzlebox-sentinel — state-interior watcher
// Transport-agnostic core: feed it state observations and activity events,
// ask it for an assessment. Puzzlebox guards see transitions; this sees the
// time between them.

import type { DriftAdapter, InteriorObservation, UnsignedBundle, Verdict, WatcherConfig } from "./types.ts";
import { nullDriftAdapter } from "./types.ts";

export interface Assessment {
  unsigned: UnsignedBundle;
  // True the first time this state entry crosses into stuck/drifting —
  // the caller's cue to emit a WARNING once instead of every poll tick.
  new_warning: boolean;
}

export class InteriorWatcher {
  private state: string | null = null;
  private enteredAt = 0; // epoch ms
  private activityCount = 0;
  private warnedThisEntry = false;
  private availableActions: string[] = [];

  constructor(
    private readonly puzzleId: string,
    private readonly config: WatcherConfig,
    private readonly drift: DriftAdapter = nullDriftAdapter,
  ) {}

  // ── Inputs ──────────────────────────────────────────────────

  // Record a snapshot observation. A state change resets the interior clock:
  // new entered_at, activity count back to zero, warning re-armed.
  observeState(state: string, availableActions: string[] = [], now: number = Date.now()): { transitioned: boolean } {
    this.availableActions = availableActions;
    if (state === this.state) return { transitioned: false };
    this.state = state;
    this.enteredAt = now;
    this.activityCount = 0;
    this.warnedThisEntry = false;
    return { transitioned: true };
  }

  // Record observed activity inside the current state: a resource-updated
  // notification, an action attempt, anything showing the interior is alive.
  recordActivity(): void {
    this.activityCount++;
  }

  // ── Assessment ──────────────────────────────────────────────

  thresholdFor(state: string): number {
    return this.config.per_state_thresholds?.[state] ?? this.config.default_dwell_threshold_seconds;
  }

  async assess(now: number = Date.now()): Promise<Assessment | null> {
    if (this.state === null) return null; // nothing observed yet

    const dwellSeconds = Math.max(0, (now - this.enteredAt) / 1000);
    const threshold = this.thresholdFor(this.state);
    const findings: string[] = [];

    const observation: InteriorObservation = {
      puzzle_id: this.puzzleId,
      state: this.state,
      entered_at: new Date(this.enteredAt).toISOString(),
      dwell_seconds: dwellSeconds,
      activity_count: this.activityCount,
      available_actions: this.availableActions,
    };

    // Drift adapter — fail-open ladder: score → null-on-throw with a finding.
    // A broken adapter must degrade the evidence, not kill the watcher.
    let driftScore: number | null = null;
    try {
      driftScore = await this.drift.score(observation);
    } catch (e) {
      findings.push(
        `drift adapter "${this.drift.name}" failed: ${e instanceof Error ? e.message : "unknown error"} — drift_score degraded to null`,
      );
    }

    let verdict: Verdict = "healthy";
    if (driftScore !== null && this.config.drift_threshold !== undefined && driftScore >= this.config.drift_threshold) {
      verdict = "drifting";
      findings.push(
        `drift_score ${driftScore.toFixed(3)} at or above threshold ${this.config.drift_threshold} (adapter: ${this.drift.name})`,
      );
    } else if (dwellSeconds >= threshold && this.activityCount === 0) {
      verdict = "stuck";
      findings.push(
        `state "${this.state}" dwelled ${Math.floor(dwellSeconds)}s with zero observed activity (threshold ${threshold}s)`,
      );
    } else if (dwellSeconds >= threshold) {
      findings.push(
        `state "${this.state}" dwelled ${Math.floor(dwellSeconds)}s past threshold ${threshold}s but shows activity (${this.activityCount} events) — not stuck`,
      );
    }

    const newWarning = verdict !== "healthy" && !this.warnedThisEntry;
    if (newWarning) this.warnedThisEntry = true;

    const unsigned: UnsignedBundle = {
      puzzle_id: this.puzzleId,
      state: this.state,
      entered_at: observation.entered_at,
      dwell_seconds: Math.round(dwellSeconds * 1000) / 1000,
      activity_count: this.activityCount,
      drift_score: driftScore,
      findings,
      verdict,
      ts: new Date(now).toISOString(),
      evidence_version: "0.1",
    };

    return { unsigned, new_warning: newWarning };
  }
}
