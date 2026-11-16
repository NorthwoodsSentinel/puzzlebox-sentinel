// The CLI, tested unchanged. src/cli.ts is a script with top-level effects (process.argv, process.exit, signal
// handlers, Bun.file / Bun.stdin), so each case imports it into a fresh module registry with:
//   - process.argv set to the case's arguments,
//   - process.exit replaced by a throw the harness catches (so `fail()` really stops, as it does in production),
//   - process.on captured instead of registered (the test fires SIGINT / SIGTERM itself),
//   - a minimal `Bun` global (file().text(), stdin.stream()) because the suite runs on Node.
// Keys are throwaway values generated per run; the server is the in-process mock puzzlebox.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { signBundle, verifyBundle } from "../src/evidence.ts";
import type { GuardEvidenceBundle, UnsignedBundle } from "../src/types.ts";
import { startMockPuzzlebox, type MockPuzzlebox } from "./mock-puzzlebox.ts";

const KEY = randomBytes(32).toString("hex");

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface CliRun {
  code: number | undefined; // undefined: the script finished without calling process.exit
  stdout: string[];
  stderr: string[];
  signals: Map<string, () => void>;
}

type ClientModule = typeof import("../src/client.ts");

// `before` receives the fresh registry's client module: after resetModules the CLI imports a new copy, so a spy
// on the copy this file imported statically would never be seen by it.
async function runCli(
  argv: string[],
  opts: { stdin?: string; before?: (client: ClientModule) => void } = {},
): Promise<CliRun> {
  const run: CliRun = { code: undefined, stdout: [], stderr: [], signals: new Map() };
  vi.resetModules();
  const savedArgv = process.argv;
  process.argv = ["bun", "src/cli.ts", ...argv];
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Exit(code === undefined || code === null ? undefined : Number(code));
  });
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    run.signals.set(event, handler);
    return process;
  }) as typeof process.on);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void run.stdout.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void run.stderr.push(a.join(" ")));
  vi.stubGlobal("Bun", {
    file: (path: string) => ({ text: async () => readFileSync(path, "utf8") }),
    stdin: {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(opts.stdin ?? ""));
            c.close();
          },
        }),
    },
  });
  opts.before?.(await import("../src/client.ts"));
  try {
    await import("../src/cli.ts");
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    run.code = e.code;
  } finally {
    process.argv = savedArgv;
  }
  return run;
}

// Fire a captured signal handler; it ends in process.exit, which the harness turns into a throw.
function fire(run: CliRun, signal: string): number | undefined {
  try {
    run.signals.get(signal)?.();
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
  return undefined;
}

let mock: MockPuzzlebox;
let dir: string;
beforeAll(async () => {
  mock = await startMockPuzzlebox("SPECIFICATION", ["APPROVE_SPEC"]);
  dir = mkdtempSync(join(tmpdir(), "pbx-sentinel-cli-"));
});
afterAll(async () => {
  await mock.stop();
  rmSync(dir, { recursive: true, force: true });
});

const bundles = (run: CliRun) => run.stdout.map((l) => JSON.parse(l) as GuardEvidenceBundle);

describe("cli: help and argument errors", () => {
  test.each([[[]], [["help"]], [["--help"]]])("%j prints usage", async (argv) => {
    const run = await runCli(argv);
    expect(run.code).toBeUndefined();
    expect(run.stdout[0]).toContain("puzzlebox-sentinel v0.1");
  });

  test.each([
    [["frobnicate"], 'unknown command "frobnicate"'],
    [["watch", "--puzzle"], "--puzzle needs a value"],
    [["watch"], "--puzzle is required"],
    [["watch", "--puzzle", "p", "--transport", "carrier-pigeon", "--key", "k"], 'unknown transport "carrier-pigeon"'],
    [["watch", "--puzzle", "p", "--key", "k", "--interval", "0"], "--interval must be a positive number"],
    [["watch", "--puzzle", "p", "--key", "k", "--interval", "soon"], "--interval must be a positive number"],
    [["watch", "--puzzle", "p", "--key", "k", "--threshold", "-1"], "--threshold must be a positive number"],
    [["watch", "--puzzle", "p", "--key", "k", "--threshold", "x"], "--threshold must be a positive number"],
    [["watch", "--puzzle", "p", "--key", "k", "--state-threshold", "REVIEW"], "expects NAME=SECONDS"],
    [["watch", "--puzzle", "p", "--key", "k", "--state-threshold", "REVIEW=0"], "bad seconds"],
    [["watch", "--puzzle", "p", "--key", "k", "--state-threshold", "REVIEW=x"], "bad seconds"],
    [["watch", "--puzzle", "p", "--key", "k", "--drift-threshold", "1.5"], "--drift-threshold must be in [0, 1]"],
    [["watch", "--puzzle", "p", "--key", "k", "--drift-threshold", "-0.1"], "--drift-threshold must be in [0, 1]"],
    [["watch", "--puzzle", "p", "--key", "k", "--drift-threshold", "nan"], "--drift-threshold must be in [0, 1]"],
  ])("%j exits 2: %s", async (argv, message) => {
    const run = await runCli(argv);
    expect(run.code).toBe(2);
    expect(run.stderr[0]).toContain(message);
    expect(run.stderr[1]).toContain("Usage:");
  });

  test("a key is required for watch and verify when the env var is unset", async () => {
    vi.stubEnv("PUZZLEBOX_SENTINEL_KEY", undefined);
    for (const argv of [["watch", "--puzzle", "p"], ["verify"]]) {
      const run = await runCli(argv);
      expect(run.code).toBe(2);
      expect(run.stderr[0]).toContain("--key or PUZZLEBOX_SENTINEL_KEY is required");
    }
  });
});

describe("cli: watch", () => {
  test("--once over SSE (auto) with the key from the env emits one signed bundle", async () => {
    vi.stubEnv("PUZZLEBOX_SENTINEL_KEY", KEY);
    const run = await runCli(["watch", "--server", mock.url, "--puzzle", "p1", "--once"]);
    expect(run.code).toBeUndefined();
    const [b] = bundles(run);
    expect(bundles(run)).toHaveLength(1);
    expect(b.state).toBe("SPECIFICATION");
    expect(b.verdict).toBe("healthy");
    expect(verifyBundle(b, KEY)).toBe(true);
    expect(run.stderr).toContain(`[sentinel] connected via SSE: ${mock.url}`);
  });

  test("--once over http with every option set", async () => {
    // The CLI's --once subscription is best-effort: a rejected subscribe must not stop the cycle.
    const refuse = (client: ClientModule) =>
      vi.spyOn(client.StreamableHttpClient.prototype, "subscribe").mockImplementation(async (_uri, onUpdated) => {
        onUpdated();
        throw new Error("refused");
      });
    const run = await runCli(
      [
        "watch",
        "--server",
        mock.url,
        "--puzzle",
        "p2",
        "--key",
        KEY,
        "--transport",
        "http",
        "--interval",
        "1",
        "--threshold",
        "60",
        "--state-threshold",
        "SPECIFICATION=1800",
        "--state-threshold",
        "REVIEW=600",
        "--drift-threshold",
        "0.7",
        "--once",
      ],
      { before: refuse },
    );
    expect(run.code).toBeUndefined();
    expect(bundles(run)).toHaveLength(1);
    expect(verifyBundle(bundles(run)[0], KEY)).toBe(true);
    expect(run.stderr).toContain(`[sentinel] connected via streamableHttp: ${mock.url}/mcp`);
  });

  test("the long-running watch starts, and SIGINT / SIGTERM stop it with exit 0", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const run = await runCli(["watch", "--server", mock.url, "--puzzle", "p3", "--key", KEY, "--interval", "60"]);
      expect(run.code).toBeUndefined();
      expect(run.stderr.at(-1)).toBe("[sentinel] watching puzzle p3 every 60s (default threshold 300s)");
      expect(bundles(run)).toHaveLength(1);
      expect(fire(run, signal)).toBe(0);
      if (signal === "SIGINT") expect(run.stderr.at(-1)).toBe("[sentinel] stopping");
    }
  });

  test("a stuck interior during the long-running watch warns on stderr", async () => {
    const run = await runCli([
      "watch",
      "--server",
      mock.url,
      "--puzzle",
      "p4",
      "--key",
      KEY,
      "--transport",
      "http",
      "--interval",
      "0.01",
      "--threshold",
      "0.001",
    ]);
    // Wait on the condition (a warning line), not on a clock.
    await vi.waitFor(() => expect(run.stderr.some((l) => l.startsWith("WARNING: puzzle p4 verdict=stuck"))).toBe(true));
    expect(fire(run, "SIGTERM")).toBe(0);
  });

  test("an unreachable server fails both rungs of the auto ladder and the run", async () => {
    // Nothing is listening on the closed port, so both rungs of the auto ladder fail.
    const s = await startMockPuzzlebox("X");
    const url = s.url;
    await s.stop();
    await expect(runCli(["watch", "--server", url, "--puzzle", "p", "--key", KEY, "--once"])).rejects.toThrow();
  });
});

describe("cli: verify", () => {
  const unsigned: UnsignedBundle = {
    puzzle_id: "0xABC",
    state: "PLAYING",
    entered_at: "2026-07-28T12:00:00.000Z",
    dwell_seconds: 1,
    activity_count: 0,
    drift_score: null,
    findings: [],
    verdict: "healthy",
    ts: "2026-07-28T12:00:01.000Z",
    evidence_version: "0.1",
  };

  test("a valid bundle from a file verifies, exit 0", async () => {
    const file = join(dir, "good.json");
    writeFileSync(file, JSON.stringify(signBundle(unsigned, KEY)));
    const run = await runCli(["verify", "--key", KEY, file]);
    expect(run.code).toBe(0);
    expect(run.stdout).toEqual(["ok: hmac valid"]);
  });

  test("a tampered bundle on stdin fails, exit 1, with the key from the env", async () => {
    vi.stubEnv("PUZZLEBOX_SENTINEL_KEY", KEY);
    const tampered = { ...signBundle(unsigned, KEY), verdict: "stuck" };
    const run = await runCli(["verify"], { stdin: JSON.stringify(tampered) });
    expect(run.code).toBe(1);
    expect(run.stdout).toEqual(["FAIL: hmac invalid"]);
  });

  test("a bundle signed with another key fails", async () => {
    const other = randomBytes(32).toString("hex");
    const run = await runCli(["verify", "--key", KEY], { stdin: JSON.stringify(signBundle(unsigned, other)) });
    expect(run.code).toBe(1);
    expect(run.stdout).toEqual(["FAIL: hmac invalid"]);
  });

  test("input that is not JSON fails, exit 1", async () => {
    const run = await runCli(["verify", "--key", KEY], { stdin: "{not json" });
    expect(run.code).toBe(1);
    expect(run.stderr).toEqual(["verify: input is not valid JSON"]);
  });
});
