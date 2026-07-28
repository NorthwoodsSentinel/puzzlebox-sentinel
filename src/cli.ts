#!/usr/bin/env bun
// puzzlebox-sentinel — CLI
//   bun src/cli.ts watch  --server http://localhost:3001 --puzzle <id> --key <hex-or-string>
//   bun src/cli.ts verify --key <key> [bundle.json]     (or bundle JSON on stdin)
// Bundles stream to stdout as JSON lines; warnings and logs go to stderr.

import { connect, type TransportChoice } from "./client.ts";
import { verifyBundle } from "./evidence.ts";
import { Sentinel } from "./sentinel.ts";
import type { WatcherConfig } from "./types.ts";

const USAGE = `puzzlebox-sentinel v0.1 — interior watcher for cliffhall/puzzlebox

Usage:
  puzzlebox-sentinel watch --server <url> --puzzle <id> --key <key> [options]
  puzzlebox-sentinel verify --key <key> [bundle.json]

watch options:
  --server <url>            puzzlebox base URL (default http://localhost:3001)
  --puzzle <id>             puzzle id to watch (required)
  --key <key>               shared HMAC key (or env PUZZLEBOX_SENTINEL_KEY)
  --transport sse|http|auto transport (default auto: SSE, then streamableHttp)
  --interval <seconds>      snapshot poll interval (default 5)
  --threshold <seconds>     default stuck-dwell threshold (default 300)
  --state-threshold NAME=S  per-state threshold override (repeatable)
  --drift-threshold <0..1>  verdict "drifting" when an adapter scores >= this
  --once                    single observe+assess cycle, then exit

verify:
  reads a guard-evidence bundle (file arg or stdin), recomputes the HMAC with
  --key, prints ok/fail, exits 0 on valid signature, 1 otherwise.
`;

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string[]>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (name === "once") {
        flags.set(name, ["true"]);
      } else {
        const value = rest[++i];
        if (value === undefined) fail(`--${name} needs a value`);
        const list = flags.get(name) ?? [];
        list.push(value);
        flags.set(name, list);
      }
    } else {
      positional.push(a);
    }
  }
  return { command, flags, positional };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function fail(message: string): never {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

async function runWatch(args: ParsedArgs): Promise<void> {
  const server = flag(args, "server") ?? "http://localhost:3001";
  const puzzleId = flag(args, "puzzle") ?? fail("--puzzle is required");
  const key = flag(args, "key") ?? process.env.PUZZLEBOX_SENTINEL_KEY ?? fail("--key or PUZZLEBOX_SENTINEL_KEY is required");
  const transport = (flag(args, "transport") ?? "auto") as TransportChoice;
  if (!["sse", "http", "auto"].includes(transport)) fail(`unknown transport "${transport}"`);
  const intervalSeconds = Number(flag(args, "interval") ?? "5");
  const threshold = Number(flag(args, "threshold") ?? "300");
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) fail("--interval must be a positive number");
  if (!Number.isFinite(threshold) || threshold <= 0) fail("--threshold must be a positive number");

  const perState: Record<string, number> = {};
  for (const entry of args.flags.get("state-threshold") ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) fail(`--state-threshold expects NAME=SECONDS, got "${entry}"`);
    const seconds = Number(entry.slice(eq + 1));
    if (!Number.isFinite(seconds) || seconds <= 0) fail(`bad seconds in --state-threshold "${entry}"`);
    perState[entry.slice(0, eq)] = seconds;
  }

  const driftFlagRaw = flag(args, "drift-threshold");
  const driftThreshold = driftFlagRaw === undefined ? undefined : Number(driftFlagRaw);
  if (driftThreshold !== undefined && (!Number.isFinite(driftThreshold) || driftThreshold < 0 || driftThreshold > 1)) {
    fail("--drift-threshold must be in [0, 1]");
  }

  const config: WatcherConfig = {
    default_dwell_threshold_seconds: threshold,
    per_state_thresholds: perState,
    drift_threshold: driftThreshold,
  };

  const log = (line: string) => console.error(`[sentinel] ${line}`);
  const client = await connect(server, transport, log);
  const sentinel = new Sentinel(client, {
    puzzleId,
    key,
    config,
    pollIntervalMs: intervalSeconds * 1000,
    onBundle: (bundle) => console.log(JSON.stringify(bundle)),
    onWarning: (message) => console.error(message),
    onLog: log,
  });

  if (args.flags.has("once")) {
    const uri = `puzzlebox:/puzzle/${puzzleId}`;
    await client.subscribe(uri, () => {}).catch(() => false);
    await sentinel.tick();
    sentinel.stop();
    return;
  }

  process.on("SIGINT", () => {
    log("stopping");
    sentinel.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    sentinel.stop();
    process.exit(0);
  });
  await sentinel.start();
  log(`watching puzzle ${puzzleId} every ${intervalSeconds}s (default threshold ${threshold}s)`);
}

async function runVerify(args: ParsedArgs): Promise<void> {
  const key = flag(args, "key") ?? process.env.PUZZLEBOX_SENTINEL_KEY ?? fail("--key or PUZZLEBOX_SENTINEL_KEY is required");
  const file = args.positional[0];
  const raw = file ? await Bun.file(file).text() : await new Response(Bun.stdin.stream()).text();
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch {
    console.error("verify: input is not valid JSON");
    process.exit(1);
  }
  const ok = verifyBundle(bundle, key);
  console.log(ok ? "ok: hmac valid" : "FAIL: hmac invalid");
  process.exit(ok ? 0 : 1);
}

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case "watch":
    await runWatch(args);
    break;
  case "verify":
    await runVerify(args);
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(USAGE);
    break;
  default:
    fail(`unknown command "${args.command}"`);
}
