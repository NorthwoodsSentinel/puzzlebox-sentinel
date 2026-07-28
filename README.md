# puzzlebox-sentinel

The interior watcher for [cliffhall/puzzlebox](https://github.com/cliffhall/puzzlebox).

Puzzlebox coordinates agent teams with finite state machines. Its guards fire at transitions — an exit guard checks the work before the state changes, an enter guard checks it after. Between those two moments there is a state interior, and that is where things actually go wrong: a team stalls, an agent loops, work drifts off-mission while the state machine sits still. No transition, no guard, no signal.

puzzlebox-sentinel watches the interiors. It subscribes to a puzzle, tracks how long the current state has dwelled and whether anything is happening inside it, and emits a signed guard-evidence bundle that an exit guard can consume when the transition finally comes — or that a human can act on when it doesn't.

Credit where it belongs: puzzlebox is Cliff Hall's design and code. This is a companion, not a fork. It fills its own gap — runtime evidence for the guard slots puzzlebox already sketched (`Puzzle.ts`, the exit/enter guard TODOs) — and stays out of the state machine's way.

## What it does

1. Connects to a puzzlebox server. SSE first (puzzlebox's shipped transport), streamableHttp as fallback, and snapshot polling via `get_puzzle_snapshot` either way — so it works with clients and servers that don't support resource subscriptions.
2. Subscribes to `puzzlebox:/puzzle/{id}` when the server accepts it. Resource-updated notifications count as activity inside the current state.
3. Tracks dwell time per state against a configurable threshold (a default plus per-state overrides). A state that dwells past its threshold with zero observed activity gets a `stuck` verdict and a one-time WARNING on stderr.
4. Emits a guard-evidence bundle as a JSON line on stdout at every poll interval, HMAC-signed with a shared key.

## Run it

Requires [Bun](https://bun.sh). No dependencies to install.

```
# watch a puzzle
bun src/cli.ts watch \
  --server http://localhost:3001 \
  --puzzle 0x12345 \
  --key "$PUZZLEBOX_SENTINEL_KEY" \
  --interval 5 \
  --threshold 300 \
  --state-threshold SPECIFICATION=1800 \
  --state-threshold REVIEW=600

# verify a bundle someone handed you
bun src/cli.ts verify --key "$PUZZLEBOX_SENTINEL_KEY" bundle.json
```

Bundles go to stdout (one JSON object per line, pipe-friendly). Warnings and connection logs go to stderr. `--once` does a single observe-assess cycle and exits, for cron-shaped use.

## The guard-evidence bundle

```json
{
  "puzzle_id": "0x12345",
  "state": "SPECIFICATION",
  "entered_at": "2026-07-28T12:00:00.000Z",
  "dwell_seconds": 1842.5,
  "activity_count": 0,
  "drift_score": null,
  "findings": ["state \"SPECIFICATION\" dwelled 1842s with zero observed activity (threshold 1800s)"],
  "verdict": "stuck",
  "ts": "2026-07-28T12:30:42.500Z",
  "evidence_version": "0.1",
  "hmac": "3f2a...c9"
}
```

`verdict` is one of `healthy`, `stuck`, `drifting`. `hmac` is HMAC-SHA256 (hex) over the canonical JSON of every other field — keys sorted recursively, no whitespace — with a key shared between the sentinel and whatever consumes the bundle.

## Guard-consumption interface

How a puzzlebox exit guard (or any transition-time check) should consume these bundles:

1. **Verify first.** Recompute HMAC-SHA256 over the canonical JSON of the bundle minus `hmac` (sort keys recursively at every depth, no whitespace, arrays in order) and compare constant-time. Reject on mismatch, reject on a missing or non-hex `hmac`, and reject unknown `evidence_version` values you haven't implemented. `src/evidence.ts` is a reference verifier; `bun src/cli.ts verify` wraps it.
2. **Check freshness.** `ts` is when the bundle was produced. A guard evaluating a transition should ignore bundles older than its own staleness window (a few poll intervals is a sane default). An attacker replaying an old healthy bundle is the failure this catches.
3. **Threshold on the fields, not the vibe.** The intended guard logic is mechanical: `verdict === "stuck"` or `dwell_seconds` past your own ceiling means the interior went quiet before this transition — worth a harder look at the work product. `verdict === "drifting"` with a `drift_score` means a behavioral adapter flagged the interior; weigh it by your `drift_threshold`.
4. **Treat it as ADVISORY evidence, never authority.** The bundle reports what the sentinel observed from the outside; it does not know whether the work is good. A guard should use it as one input to its sampling decision — e.g. include the findings in the sampling prompt, or lower its acceptance bar when the interior was stuck — and never auto-cancel a transition on the bundle alone.
5. **Key handling.** The shared key is a symmetric trust link between one sentinel and its consumers. Rotate it like any shared secret; a leaked key means forgeable evidence, not puzzle compromise — the sentinel has no write path into puzzlebox.

## Drift adapter interface (v0: null)

`drift_score` is `null` in v0 and the `drifting` verdict cannot fire unless you wire an adapter. The seam is `DriftAdapter` in `src/types.ts`:

```ts
export interface DriftAdapter {
  name: string;
  score(observation: InteriorObservation): Promise<number | null>;
}
```

An adapter receives the interior observation (puzzle, state, dwell, activity, available actions) and returns a score in `[0, 1]` — 0 on-mission, 1 fully adrift — or `null` when it has no signal. A throwing adapter degrades to `null` plus a finding; it never kills the watch. This is where behavioral signals from [swarm-posture](https://github.com/NorthwoodsSentinel/swarm-posture)-style tooling plug in later: the sentinel supplies the when-and-where, the adapter supplies the is-the-work-still-the-assigned-work.

## Honest v0 limitations

- **Activity is observation, not truth.** Over polling, the sentinel only sees state changes and (when subscribed) resource-updated notifications. Failed action attempts, in-state agent chatter, and anything that doesn't touch the puzzle resource are invisible. A team working hard without touching the state machine can look stuck.
- **The SSE and streamableHttp clients are hand-rolled minimal MCP**, exercised against this repo's mock fixture and written to puzzlebox's shipped transport. They have not been soak-tested against a long-lived production puzzlebox; reconnect-on-drop is not implemented — if the stream dies, the process exits and your supervisor restarts it.
- **`drifting` never fires in v0** — the null adapter is the only one shipped.
- **Symmetric key only.** HMAC means any holder of the key can mint bundles. If your consumers shouldn't be able to forge evidence, you want asymmetric signatures; that is a v0.2 question.
- **One puzzle per process.** Watch N puzzles with N processes.
- **Puzzlebox's guard slots are still TODO upstream** — this tool produces the evidence side of that interface ahead of the consumer existing. The consumption spec above is a proposal to build against, not a shipped puzzlebox API.

## Tests

```
bun test
```

Covers canonical-JSON determinism, sign/verify/tamper/wrong-key paths, stuck-state detection with per-state thresholds and warning re-arm, drift adapter success/failure ladders, and an end-to-end run against an in-process mock puzzlebox over real HTTP.

## License

Apache-2.0. See [LICENSE](LICENSE).

puzzlebox itself is by [Cliff Hall](https://github.com/cliffhall) — go read it; the state-machines-as-shared-MCP-resources idea is the interesting part, and it is his.
