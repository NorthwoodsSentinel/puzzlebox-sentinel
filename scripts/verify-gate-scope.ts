#!/usr/bin/env bun
// verify-gate-scope: a gate must show how much it checked (AGENTS.md "Always test new or modified code").
// Three silent-shrink failures this catches, each of which would leave the gate green while checking less:
//   1. a tracked .ts file that lands in no tsconfig project is never typechecked (or linted with types);
//   2. a source file under src/ missing from the coverage summary is never held to the 90% bar;
//   3. a coverage run that measured zero files (a mis-anchored glob) passes every threshold vacuously.
// Fix a failure by fixing the include globs, never by excusing the file.
// Runs after `vitest run --coverage`, which writes coverage/coverage-summary.json.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts"], {
  cwd: root,
  encoding: "utf8",
});
if (listed.status !== 0) throw new Error(`verify-gate-scope: git ls-files failed:\n${listed.stderr}`);
const tracked = listed.stdout
  .split("\n")
  .filter(Boolean)
  .filter((f) => !f.startsWith("node_modules/"));
if (!tracked.length) throw new Error("verify-gate-scope: found no .ts files at all; the check itself is broken");

// 1. typecheck scope. Read the project's file list through the TypeScript API in-process (no subprocess, so the
// result cannot depend on how a launcher behaves in a given shell or sandbox), and treat an empty list as a broken
// check rather than as "nothing typechecked".
const parsed = ts.getParsedCommandLineOfConfigFile(
  resolve(root, "tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`verify-gate-scope: tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    },
  },
);
if (!parsed || parsed.errors.length)
  throw new Error("verify-gate-scope: could not parse tsconfig.json; the check itself is broken");
if (!parsed.fileNames.length)
  throw new Error("verify-gate-scope: tsconfig.json lists no files; the check itself is broken");
const typed = new Set(parsed.fileNames.map((f) => relative(root, f)));
const untyped = tracked.filter((f) => !typed.has(f));

// 2 and 3. coverage scope
const summaryPath = resolve(root, "coverage/coverage-summary.json");
if (!existsSync(summaryPath))
  throw new Error("verify-gate-scope: no coverage summary; run vitest with --coverage first");
const measured = new Set(
  Object.keys(JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>)
    .filter((k) => k !== "total")
    .map((k) => relative(root, k)),
);
const sources = tracked.filter((f) => f.startsWith("src/") && !f.endsWith(".d.ts"));
const unmeasured = sources.filter((f) => !measured.has(f));

console.log(`gate scope: typechecked ${tracked.length - untyped.length} of ${tracked.length} .ts files`);
console.log(`gate scope: coverage measured ${sources.length - unmeasured.length} of ${sources.length} src/ files`);
if (!sources.length || !measured.size) {
  console.error("  coverage measured zero files; a gate that checked nothing cannot pass");
  process.exit(1);
}
if (untyped.length || unmeasured.length) {
  for (const f of untyped) console.error(`  not in any tsconfig project: ${f}`);
  for (const f of unmeasured) console.error(`  missing from coverage: ${f}`);
  process.exit(1);
}
