#!/usr/bin/env node
/** Paired sequential A/B replay benchmark with no network or production state. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const baseline = resolve(process.env.BENCH_BASELINE_ROOT ?? join(root, "../openrig-baseline-vps"));
const target = resolve(process.env.BENCH_REPLAY_OUTPUT ?? join(root, "docs/reference/vps-stage3-replay-ab.json"));
const repeats = Number(process.env.BENCH_REPLAY_REPEATS ?? 3);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("Invalid BENCH_REPLAY_REPEATS");
const modules = {
  baseline: join(baseline, "packages/daemon/dist/domain/event-bus.js"),
  modified: join(root, "packages/daemon/dist/domain/event-bus.js"),
};
for (const modulePath of Object.values(modules)) {
  if (!existsSync(modulePath)) throw new Error("Build both daemon EventBus versions before benchmarking");
}
const rev = cwd => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const record = {
  purpose: "Single bounded-byte replayPage call A/B, same 500 large SQLite event rows. Legacy base ignores fifth argument.",
  collectedAt: new Date().toISOString(), node: process.version, repeats,
  worktrees: {
    baseline: { directory: basename(baseline), revision: rev(baseline) },
    modified: { directory: basename(root), revision: rev(root) },
  },
  samples: [], summary: {},
};
function save() {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(record, null, 2) + "\n");
}
for (let rep = 0; rep < repeats; rep++) {
  for (const variant of (rep % 2 ? ["modified", "baseline"] : ["baseline", "modified"])) {
    const processResult = spawnSync(process.execPath,
      ["--max-old-space-size=256", join(root, "scripts/bench-sse-replay.mjs")], {
        cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 500000,
        env: { ...process.env, BENCH_REPLAY_MODULE: modules[variant] },
      });
    let value;
    try { value = JSON.parse(processResult.stdout); }
    catch { value = { parseFailure: true }; }
    record.samples.push({ variant, rep, exitCode: processResult.status,
      signal: processResult.signal ?? null, ...value,
      ...(processResult.status ? { errorTail: processResult.stderr?.slice(-200) } : {}),
    });
    save();
    console.log(`${variant} #${rep + 1} rc=${processResult.status} rows=${value.rowsReturned ?? "?"} peak=${value.peakProcessRssMb ?? "?"} MiB`);
  }
}
function median(items) {
  const sorted = [...items].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
for (const variant of Object.keys(modules)) {
  const subset = record.samples.filter(s => s.variant === variant);
  if (subset.some(s => s.exitCode !== 0)) continue;
  record.summary[variant] = Object.fromEntries(
    ["peakProcessRssMb", "heapDeltaMb", "elapsedMs", "rowsReturned"].map(k => [k, median(subset.map(s => s[k]))]),
  );
}
save();
if (record.samples.some(s => s.exitCode !== 0)) process.exitCode = 1;
