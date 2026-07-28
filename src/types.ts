// puzzlebox-sentinel — shared types
// Companion watcher for cliffhall/puzzlebox (https://github.com/cliffhall/puzzlebox).
// Puzzlebox guards fire at transitions. Drift happens inside states. This tool
// watches the interiors and emits signed evidence a transition guard can consume.

export type Verdict = "healthy" | "stuck" | "drifting";

// The signed guard-evidence bundle. Field set is the v0.1 contract — an exit
// guard verifies `hmac` over the canonical JSON of every OTHER field, then
// thresholds on verdict / dwell_seconds. Advisory evidence, never authority.
export interface GuardEvidenceBundle {
  puzzle_id: string;
  state: string;
  entered_at: string; // ISO 8601 — when the puzzle entered this state (first observed)
  dwell_seconds: number;
  activity_count: number; // action attempts / update notifications observed in this state
  drift_score: number | null; // null in v0 — see DriftAdapter
  findings: string[];
  verdict: Verdict;
  ts: string; // ISO 8601 — when this bundle was produced
  evidence_version: "0.1";
  hmac: string; // hex HMAC-SHA256 over canonical JSON of the bundle minus this field
}

export type UnsignedBundle = Omit<GuardEvidenceBundle, "hmac">;

export interface WatcherConfig {
  // Seconds a state may dwell with zero observed activity before it is "stuck".
  default_dwell_threshold_seconds: number;
  // Per-state overrides, keyed by state name.
  per_state_thresholds?: Record<string, number>;
  // When a DriftAdapter returns a score at or above this, verdict is "drifting".
  // Unset = drifting can never fire (v0 default, since drift_score is null).
  drift_threshold?: number;
}

// What the watcher knows about a state interior at assessment time. This is
// the input surface for drift adapters.
export interface InteriorObservation {
  puzzle_id: string;
  state: string;
  entered_at: string;
  dwell_seconds: number;
  activity_count: number;
  available_actions: string[];
}

// v0 adapter seam for behavioral drift signals (swarm-posture and siblings).
// Contract: return a number in [0, 1] (0 = on-mission, 1 = fully adrift),
// or null when no signal is available. Throwing is treated as null plus a
// finding — a broken adapter degrades the evidence, never kills the watcher.
export interface DriftAdapter {
  name: string;
  score(observation: InteriorObservation): Promise<number | null>;
}

// The v0 adapter: no behavioral signal wired yet, honest null.
export const nullDriftAdapter: DriftAdapter = {
  name: "null",
  score: async () => null,
};

// One puzzle snapshot as puzzlebox's get_puzzle_snapshot tool returns it.
export interface PuzzleSnapshot {
  currentState: string | undefined;
  availableActions: string[] | undefined;
}
