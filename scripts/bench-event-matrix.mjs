#!/usr/bin/env node
/** Repeat identical committed-backlog workloads against built baseline and branch.
 * BENCH_BASELINE_ROOT, BENCH_EVENT_REPEATS, BENCH_EVENT_HEAP_MB and
 * BENCH_EVENT_CASES (semicolon-separated count:payload-bytes) are optional.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baseline = resolve(process.env.BENCH_BASELINE_ROOT ?? join(root, "../openrig-baseline-vps"));
const destination = resolve(process.env.BENCH_EVENT_MATRIX_OUTPUT ?? join(root, "docs/reference/vps-stage2-events.json"));
const repeats = Number(process.env.BENCH_EVENT_REPEATS ?? 3);
const heapMb = Number(process.env.BENCH_EVENT_HEAP_MB ?? 256);
const cases = (process.env.BENCH_EVENT_CASES ?? "2000:1024;12000:8192;3000:32768")
  .split(";").map(value => value.split(":").map(Number));
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20 || !Number.isSafeInteger(heapMb) ||
    heapMb < 64 || cases.some(([count, bytes]) =>
      !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(bytes) || bytes < 64)) {
  throw new Error("Invalid benchmark settings");
}
const modules = {
  baseline: join(baseline, "packages/daemon/dist/domain/event-bus.js"),
  modified: join(root, "packages/daemon/dist/domain/event-bus.js"),
};
for (const module of Object.values(modules))
  if (!existsSync(module)) throw new Error(`Build this EventBus before benchmarking: ${module}`);
const result = { measuredAt: new Date().toISOString(), heapMb, repeats, cases, samples: [] };
const persist = () => {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(result, null, 2) + "\n");
};
for (const [count, bytes] of cases) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const variant of (repeat % 2 ? ["modified", "baseline"] : ["baseline", "modified"])) {
      const env = { ...process.env,
        BENCH_EVENT_BUS_MODULE: modules[variant],
        BENCH_EVENTS: String(count), BENCH_EVENT_BYTES: String(bytes),
      };
      const command = process.platform === "linux" ? "prlimit" : process.execPath;
      const args = process.platform === "linux"
        ? ["--core=0", "--", process.execPath, `--max-old-space-size=${heapMb}`, join(root, "scripts/bench-event-backlog.mjs")]
        : [`--max-old-space-size=${heapMb}`, join(root, "scripts/bench-event-backlog.mjs")];
      const run = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 200_000 });
      let output;
      try { output = JSON.parse(run.stdout); }
      catch { output = { noMetrics: true }; }
      result.samples.push({
        variant, repeat, count, bytes, exitCode: run.status, signal: run.signal ?? null,
        ...output, ...(run.status ? { errorTail: run.stderr?.slice(-250) ?? "" } : {}),
      });
      persist();
      console.log(`${variant.padEnd(8)} events=${count} bytes=${bytes} heap=${heapMb} #${repeat + 1}: exit=${run.status} peakRSS=${output.peakRssMb ?? "?"}MB elapsed=${output.elapsedMs ?? "?"}ms`);
    }
  }
}
if (result.samples.some(s => s.exitCode !== 0)) process.exitCode = 1;
