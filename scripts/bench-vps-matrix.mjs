#!/usr/bin/env node
/**
 * Paired A/B daemon benchmark. Runs isolated instances SEQUENTIALLY to avoid
 * measuring both daemons against one another. Requires already-built checkouts.
 * Defaults to a sibling baseline worktree; override BENCH_BASELINE_ROOT.
 *
 * BENCH_REPEATS=2 BENCH_HEAPS=128,192,256 node scripts/bench-vps-matrix.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cpus, totalmem } from "node:os";

const currentRoot = resolve(import.meta.dirname, "..");
const baselineRoot = resolve(process.env.BENCH_BASELINE_ROOT ?? join(currentRoot, "../openrig-baseline-vps"));
const outputFile = resolve(process.env.BENCH_MATRIX_OUTPUT ?? join(currentRoot, "docs/reference/vps-stage2-local-samples.json"));
const repeats = Number(process.env.BENCH_REPEATS ?? 2);
const heaps = (process.env.BENCH_HEAPS ?? "128,192,256").split(",").map(Number);
const uiStates = (process.env.BENCH_UI_STATES ?? "0,1").split(",");
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20 ||
    heaps.some(n => !Number.isSafeInteger(n) || n < 64 || n > 8192) ||
    uiStates.some(n => n !== "0" && n !== "1")) {
  throw new Error("Invalid BENCH_REPEATS, BENCH_HEAPS or BENCH_UI_STATES");
}
const originals = {
  baseline: resolve(baselineRoot, "packages/daemon/dist/index.js"),
  modified: resolve(currentRoot, "packages/daemon/dist/index.js"),
};
for (const file of Object.values(originals)) {
  if (!existsSync(file)) throw new Error(`Build daemon before benchmarking: ${file}`);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
const samples = [];
function revision(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}
function sharedCgroupMemoryLimitMb() {
  try {
    const relative = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").at(-1);
    const maximum = readFileSync(join("/sys/fs/cgroup", relative, "memory.max"), "utf8").trim();
    return maximum === "max" ? null : Math.round(Number(maximum) / 1024 / 1024);
  } catch {
    return null;
  }
}
const result = {
  methodology: "Sequential paired isolated Node daemon processes, local machine; V8 heap cap, not a physical RAM/cgroup cap",
  collectedAt: new Date().toISOString(), node: process.version,
  hostCpuCount: cpus().length, hostRamMb: Math.round(totalmem() / 1024 / 1024),
  sharedCgroupMemoryLimitMb: sharedCgroupMemoryLimitMb(),
  // Never publish absolute contributor paths when committing raw measurements.
  worktrees: {
    baseline: { directory: basename(baselineRoot), revision: revision(baselineRoot) },
    modified: { directory: basename(currentRoot), revision: revision(currentRoot) },
  },
  repeats, heaps, uiStates,
  samples, summary: [],
};
function save() {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n");
}
for (const heap of heaps) {
  for (const ui of uiStates) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Alternate the order to lessen drift if memory pressure changes over time.
      for (const variant of (repeat % 2 ? ["modified", "baseline"] : ["baseline", "modified"])) {
        const env = {
          ...process.env,
          BENCH_DAEMON_PATH: originals[variant],
          BENCH_HEAP_MB: String(heap), BENCH_UI_ENABLED: ui,
          BENCH_REQUESTS: process.env.BENCH_REQUESTS ?? "120",
          BENCH_CONCURRENCY: process.env.BENCH_CONCURRENCY ?? "8",
          BENCH_IDLE_MS: process.env.BENCH_IDLE_MS ?? "1500",
          BENCH_SAMPLE_MS: process.env.BENCH_SAMPLE_MS ?? "100",
        };
        const child = spawnSync(process.execPath, [join(currentRoot, "scripts/bench-vps-lean.mjs")], {
          env, cwd: currentRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 1_000_000,
        });
        let data;
        try { data = JSON.parse(child.stdout); }
        catch { data = { parseFailure: true, outputTail: child.stdout?.slice(-250) ?? "" }; }
        const sample = {
          variant, heapMb: heap, uiEnabled: ui === "1", repeat,
          exitCode: child.status, signal: child.signal ?? null,
          ...data,
          ...(child.status ? { diagnostic: child.stderr?.slice(-400) } : {}),
        };
        samples.push(sample);
        save();
        console.log(`${variant.padEnd(8)} heap=${heap} ui=${ui} #${repeat + 1}: exit=${child.status} idle=${data.idleRssMb ?? "?"}MiB hwm=${data.daemonHighWaterRssMb ?? "?"}MiB startup=${data.startupMs ?? "?"}ms`);
      }
    }
    const pair = Object.fromEntries(["baseline", "modified"].map(variant => [
      variant, samples.filter(s => s.heapMb === heap && s.uiEnabled === (ui === "1") && s.variant === variant),
    ]));
    if (Object.values(pair).every(rows => rows.every(s => s.exitCode === 0))) {
      const row = { heapMb: heap, uiEnabled: ui === "1" };
      for (const metric of ["idleRssMb", "daemonHighWaterRssMb", "sampledPeakProcessTreeRssMb", "startupMs", "sampledAvgCpuPercentOfOneCore", "throughputRps"]) {
        row[metric] = {
          baseline: median(pair.baseline.map(s => s[metric])),
          modified: median(pair.modified.map(s => s[metric])),
        };
        row[metric].delta = Math.round((row[metric].modified - row[metric].baseline) * 10) / 10;
      }
      result.summary.push(row);
    } else {
      result.summary.push({ heapMb: heap, uiEnabled: ui === "1", incomplete: true });
    }
    save();
  }
}
console.log(JSON.stringify(result.summary, null, 2));
if (samples.some(row => row.exitCode !== 0)) process.exitCode = 1;
