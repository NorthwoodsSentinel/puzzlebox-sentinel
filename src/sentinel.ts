// puzzlebox-sentinel — the watch loop
// Wires client → watcher → signed bundles. Testable head: the CLI hands it a
// client factory and sinks; tests hand it a mock server's client.

import { asSnapshot, puzzleResourceUri, type PuzzleboxClient } from "./client.ts";
import { signBundle } from "./evidence.ts";
import { InteriorWatcher } from "./watcher.ts";
import type { DriftAdapter, GuardEvidenceBundle, WatcherConfig } from "./types.ts";
import { nullDriftAdapter } from "./types.ts";

export interface SentinelOptions {
  puzzleId: string;
  key: string; // shared HMAC key
  config: WatcherConfig;
  pollIntervalMs: number;
  drift?: DriftAdapter;
  // Sinks — CLI points these at stdout/stderr; tests capture arrays.
  onBundle: (bundle: GuardEvidenceBundle) => void;
  onWarning: (message: string) => void;
  onLog?: (message: string) => void;
}

export class Sentinel {
  private watcher: InteriorWatcher;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly client: PuzzleboxClient,
    private readonly opts: SentinelOptions,
  ) {
    this.watcher = new InteriorWatcher(opts.puzzleId, opts.config, opts.drift ?? nullDriftAdapter);
  }

  // Run until stop(). Subscription is best-effort: an accepted subscription
  // feeds the activity heartbeat; a refused one just means polling carries
  // the whole load (that fact is logged, never fatal).
  async start(): Promise<void> {
    const uri = puzzleResourceUri(this.opts.puzzleId);
    const subscribed = await this.client
      .subscribe(uri, () => this.watcher.recordActivity())
      .catch(() => false);
    this.opts.onLog?.(
      subscribed
        ? `subscribed to ${uri} — resource updates count as activity`
        : `subscription unavailable — falling back to snapshot polling only`,
    );
    await this.tick();
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      this.scheduleNext();
    }, this.opts.pollIntervalMs);
  }

  // One observation + assessment cycle. Snapshot failures degrade to a log
  // line and a skipped cycle — a flaky server must not kill the watch.
  async tick(now: number = Date.now()): Promise<GuardEvidenceBundle | null> {
    let snapshot;
    try {
      const raw = await this.client.callTool("get_puzzle_snapshot", {
        puzzleId: this.opts.puzzleId,
      });
      snapshot = asSnapshot(raw);
    } catch (e) {
      this.opts.onLog?.(
        `snapshot poll failed: ${e instanceof Error ? e.message : e} — skipping cycle`,
      );
      return null;
    }
    if (!snapshot.currentState) {
      this.opts.onLog?.(`puzzle ${this.opts.puzzleId}: no current state in snapshot — skipping cycle`);
      return null;
    }

    this.watcher.observeState(snapshot.currentState, snapshot.availableActions ?? [], now);
    const assessment = await this.watcher.assess(now);
    if (!assessment) return null;

    const bundle = signBundle(assessment.unsigned, this.opts.key);
    this.opts.onBundle(bundle);
    if (assessment.new_warning) {
      this.opts.onWarning(
        `WARNING: puzzle ${bundle.puzzle_id} verdict=${bundle.verdict} in state "${bundle.state}" — ${bundle.findings.join("; ")}`,
      );
    }
    return bundle;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.client.close();
  }
}
