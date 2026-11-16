# AGENTS.md — puzzlebox-sentinel

Rules for any agent (or person) changing this repo. The shape and most of the wording come from Cliff Hall's
`modelcontextprotocol/inspector` AGENTS.md (branch v2/main, commit d330df9617e44ec893bc1a53618662239342d433), as the
maintainer ruled on it. Where his way and ours differ, **the source's way stands until there is a reason to
depart**; every departure below says why.

`CLAUDE.md` contains only `@./AGENTS.md`. Keep one copy of these rules: two copies are strictly worse than one,
because the stale copy is indistinguishable from the live one.

## What this is

A companion watcher for Cliff Hall's [puzzlebox](https://github.com/cliffhall/puzzlebox): it polls (and, over SSE,
subscribes to) one puzzle, tracks how long the current state has dwelled and whether anything happens inside it,
and emits HMAC-signed guard-evidence bundles as JSON lines. `README.md` is the description, the bundle contract and
the guard-consumption interface; read it before changing anything. It is a Bun CLI with no runtime dependencies.
There is no deploy and no build artifact.

## Security rules (read these before touching `src/`)

The bundle is evidence a guard may act on, so the signing and verification path is the trust boundary.

- **No behavior change without an issue that says so.** A refactor, a lint fix, a type fix or a review suggestion
  is never a reason to change what the code does. Comment, formatting and type-only edits are allowed when the
  emitted JavaScript stays the same; check by comparing `bun build --no-bundle --minify-syntax --minify-whitespace`
  output for each `src/*.ts` file before and after.
- **Never weaken a check in `src/evidence.ts`**: the canonical JSON (keys sorted at every depth, `undefined` keys
  dropped, arrays in order), the strict 64-lowercase-hex `hmac` format check, the constant-time comparison, and
  `verifyBundle` returning `false` (never throwing) on malformed input.
- **The CLI's refuse paths keep their exit codes**: argument errors exit 2 with usage; `verify` exits 0 only on a
  valid signature and 1 on an invalid one or on input that is not JSON.
- **The bundle field set is the v0.1 contract** (`GuardEvidenceBundle` in `src/types.ts`). Changing a field is a
  contract change for every consumer, not a refactor.
- **Keys are shared secrets.** Never commit a key, print one, or put a real one in a test. Tests generate throwaway
  keys per run.

## Project structure

- `src/cli.ts` — the `watch` and `verify` commands (a script with top-level effects).
- `src/client.ts` — minimal hand-rolled MCP client: SSE and streamableHttp transports, and the `connect` ladder.
- `src/sentinel.ts` — the watch loop: client to watcher to signed bundles.
- `src/watcher.ts` — transport-agnostic state-interior watcher and verdicts.
- `src/evidence.ts` — canonical JSON, signing and the reference verifier.
- `src/types.ts` — the bundle contract, config and the drift-adapter seam.
- `test/` — Vitest suites (`*.test.ts`), the mock puzzlebox (`test/mock-puzzlebox.ts`) and
  `test/helpers/http-server.ts`.
- `scripts/verify-gate-scope.ts` — gate tooling.

## Development setup

- `bun install`. Bun runs this repo's own scripts (`bun run <script>`) and the sentinel itself; if you run one of
  Cliff Hall's own tools or procedures, use his runner (`npx`) as he documents it.
- Tests run on Vitest with `@vitest/coverage-v8` on Node, Cliff's choice, because Bun's coverage cannot measure
  branches or enforce a per-file bar. Run them with `bun run test`; plain `bun test` is Bun's own runner and is not
  the gate.
- The mock puzzlebox and test servers are built on `node:http` on loopback ephemeral ports.
- `src/cli.ts` is tested **unchanged**: `test/cli.test.ts` imports it into a fresh module registry per case with
  `process.argv` set, `process.exit` turned into a caught throw, signal handlers captured instead of registered, and
  a minimal `Bun` global (`file().text()`, `stdin.stream()`) because the suite runs on Node.

## Issue-driven work style

GitHub issues are the board for this public repo.

- **Before starting work, find the issue.** Every change has one. Search before filing: **never create a
  duplicate**.
- **When work begins**, create the branch **in a new git worktree**, never by switching branches in a checkout
  another session may share.
- **When work is complete**, run `bun run format` then `bun run local:gate`, **sign off every commit**
  (`git commit -s`), and open a PR with **the issue reference as the body's first line**.
- **After opening a PR, run a review loop with an off-lineage reviewer**, unprompted. Stop on the **first** clean
  round. **Weigh each finding against the issue the PR closes and decline scope expansion.** Two failed rounds in
  a row: stop, leave the PR open, list the findings in it. (Departure: Cliff uses Copilot; the maintainer chose a
  different off-lineage reviewer.)
- **If new tasks are discovered during development, file issues** rather than widening the PR.
- **Pace bulk GitHub writes: 1 s between requests, never in parallel.**
- **A security issue stays private until its fix is ready**; accepting or publishing an advisory is
  outward-facing and stays human-gated, never automated.
- **This repo is public. Merging is the maintainer's act**, and nothing personal goes into a commit, PR or test
  (home paths, emails, names, tokens). Tests use synthetic data only.

### Responding to code reviews

- Judge each suggestion against the issue the PR closes. Fix defects in what the PR added; decline, with a reason,
  what expands it; file an issue for anything worth doing on its own.
- Reply in each review comment's own thread, then post a summary in addition.

## Always test new or modified code

- **Every file under `src/` must clear ≥ 90 on all four dimensions (lines, statements, functions, branches), per
  file**, enforced by `vitest.config.ts` and therefore by `bun run test`, `bun run local:gate` and CI. This is the
  source's bar (Cliff's inspector). **Never lower the threshold to pass.**
- Measured on 2026-11-16 (statements / branches / functions / lines): `cli.ts` 98.88 / 100 / 100 / 98.76,
  `evidence.ts` 95.65 / 94.11 / 100 / 100, `client.ts`, `sentinel.ts`, `watcher.ts`, `types.ts` 100 / 100 / 100 /
  100. No coverage exclusions. (The uncovered lines are a `break` after `verify`, which always exits, and a length
  check in `verifyBundle` that the hex-format check makes unreachable; both stay as written.)
- Coverage exclusions, if one is ever needed, are exact paths, one per entry, each with a reason and a follow-up
  issue; never a glob that could hide a new file.
- **Globs are anchored to the repo root** (`./src/**/*.ts`, `./test/**/*.test.ts`). An unanchored pattern can match
  a folder name further up the path and silently empty the measured set.
- **A gate must show how much it checked.** `scripts/verify-gate-scope.ts` runs after the tests and fails if a
  tracked `.ts` file is in no tsconfig project, a `src/` file is missing from the coverage summary, or coverage
  measured zero files. Fix that by fixing the globs, never by excusing the file.
- Test files are `test/**/*.test.ts`; a file named otherwise is silently not run.
- A rule about what the code does is asserted at runtime in a test, not read out of the source.
- A test that races is fixed with an awaited condition (`vi.waitFor`, a resolved signal), never with a longer
  timeout.

## Mandatory pre-push gate

- **ALWAYS run `bun run format` before committing.**
- **`bun run local:gate` is the mandatory pre-push command.** It runs every check CI runs: `format:check`, `lint`,
  `typecheck` and `test` (Vitest with the coverage bar, then the gate-scope check). A green run here means every
  check CI applies has already passed on your machine.
- CI: `.github/workflows/ci.yml` runs the same four stages as separate steps. It never deploys; there is nothing to
  deploy.
- There is deliberately no `ci` script (the name collides with the package-manager built-in).
- Departures, each for a stated reason: no gate lease (the gate takes seconds and binds only ephemeral ports); no
  DCO check job (a required-check ruleset is a repository setting, the maintainer's to change).

## Waiting on long-running work

**When you are waiting for something to finish, arm a notifier and stop. Never spend turns polling.** For state
the harness cannot observe (a CI run, a remote review), poll inside one backgrounded loop that exits when the
condition holds, at 30 s or more.

## Build output is never a gate target

**No gate (lint, format or typecheck) may read generated output.** Out of scope: `node_modules/`, `coverage/`,
`bun.lock` and `.scratch/`. Each scope states it: `globalIgnores` in `eslint.config.js`, `.prettierignore`, and the
tsconfig `include` list. **When something starts writing to a new location, add it to the ignore lists in the same
change.** Never widen an ignore to silence a finding in first-party code. Markdown is outside the format scope:
prettier rewrites prose.

## Lint has no warning tier

**`lint` runs with `--max-warnings 0`, so a warning fails the gate exactly as an error does.** Rules: ESLint
recommended, typescript-eslint recommended, and `@typescript-eslint/no-floating-promises` at `error`.

- **Do not silence a finding to satisfy the gate.** A warning is a defect to fix. If a rule genuinely must be
  waived on one line, use its inline disable comment **with a one-line justification**. Dropping a rule or
  widening an ignore to make `lint` pass is not a fix.
- The one waiver today: `StreamableHttpClient.subscribe` in `src/client.ts` takes the two parameters the
  `PuzzleboxClient` interface requires and reads neither (the transport has no push channel); removing them would
  change the emitted code.

## TypeScript

- TypeScript for all code. Never `any`. Treat parsed JSON as untrusted and narrow it before use (`asSnapshot` in
  `src/client.ts` is the pattern for new code).
- No floating promises: `await` them, or `void` them with a comment saying why.
- An empty `catch` carries a comment saying why swallowing is correct there.
- Every new file starts with a header comment saying what it is for and why.
