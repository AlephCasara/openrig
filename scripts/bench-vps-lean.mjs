#!/usr/bin/env node
/**
 * Isolated, repeatable daemon benchmark for small VPS hosts.
 *
 * Run after building packages/daemon.  Does not use or alter the user's
 * existing OpenRig state, tmux sessions, credentials, or services.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, connect } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const DAEMON = resolve(process.env.BENCH_DAEMON_PATH ?? join(ROOT, "packages/daemon/dist/index.js"));
const SOURCE_ROOT = resolve(DAEMON, "../../../..");
const HEAP_MB = Number(process.env.BENCH_HEAP_MB ?? 256);
const UI_ENABLED = process.env.BENCH_UI_ENABLED === "1";
const TRANSCRIPTS_ENABLED = process.env.BENCH_TRANSCRIPTS_ENABLED !== "0";
const KERNEL_ENABLED = process.env.BENCH_KERNEL_ENABLED !== "0";
const FETCH_GUARD_ENABLED = process.env.BENCH_FETCH_GUARD !== "0";
const PLUGIN_VENDOR_PROBE = process.env.BENCH_PLUGIN_VENDOR_PROBE === "1";
const IDLE_MS = Number(process.env.BENCH_IDLE_MS ?? 3_000);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 80);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);
const STARTUP_TIMEOUT_MS = Number(process.env.BENCH_STARTUP_TIMEOUT_MS ?? 90_000);
const INTERVAL_MS = Number(process.env.BENCH_SAMPLE_MS ?? 200);
const CLOCK_TICKS = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());

function metrics(pid) {
  const processes = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // fields[0] is state (field 3), fields[1] ppid (field 4).
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);
      const hwm = Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1] ?? 0);
      processes.set(Number(name), {
        parent: Number(fields[1]),
        rssKb: rss,
        hwmKb: hwm,
        ticks: Number(fields[11]) + Number(fields[12]),
      });
    } catch { /* A process may exit while inspecting /proc. */ }
  }
  const family = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, row] of processes) {
      if (!family.has(id) && family.has(row.parent)) {
        family.add(id);
        changed = true;
      }
    }
  }
  let rssKb = 0, ticks = 0, present = 0;
  const members = [];
  for (const id of family) {
    const row = processes.get(id);
    if (row) {
      rssKb += row.rssKb;
      ticks += row.ticks;
      present++;
      // Only report process names, not full command lines or private argv.
      let comm = "unknown";
      try { comm = readFileSync(`/proc/${id}/comm`, "utf8").trim(); } catch { /* process race */ }
      members.push({
        role: id === pid ? "daemon" : "descendant",
        comm,
        rssMb: Math.round(row.rssKb / 1024 * 10) / 10,
      });
    }
  }
  const root = processes.get(pid);
  return {
    rssMb: Math.round(rssKb / 1024 * 10) / 10,
    rootHighWaterMb: Math.round((root?.hwmKb ?? 0) / 1024 * 10) / 10,
    members,
    ticks,
    processes: present,
  };
}

async function freePort() {
  const srv = createServer();
  await new Promise((yes, no) => srv.once("error", no).listen(0, "127.0.0.1", yes));
  const port = srv.address().port;
  await new Promise(yes => srv.close(yes));
  return port;
}

async function isListening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(400, () => finish(false));
  });
}

async function main() {
  if (!Number.isInteger(HEAP_MB) || HEAP_MB < 64 ||
      !Number.isInteger(REQUESTS) || REQUESTS < 1 ||
      !Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 ||
      !Number.isInteger(INTERVAL_MS) || INTERVAL_MS < 10 ||
      !Number.isInteger(IDLE_MS) || IDLE_MS < 0) {
    throw new Error("Invalid benchmark numeric settings");
  }
  const home = mkdtempSync(join(tmpdir(), "openrig-vps-bench-"));
  for (const dir of ["config", "cache", "data", "state", "runtime", "codex", "claude", "tmp", "tmux"])
    mkdirSync(join(home, dir), { mode: 0o700 });
  const port = await freePort();
  // Deliberate minimal allowlist: an inherited TMUX session, CODEX_HOME,
  // CLAUDE_CONFIG_DIR, runtime socket, provider env or Slack token could make
  // a disposable benchmark interact with live seats or private accounts.
  // Use a fresh dedicated tmux server and fresh provider directories.
  const env = {
    PATH: process.env.PATH,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TZ: process.env.TZ,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    TMUX_TMPDIR: join(home, "tmux"),
    TMPDIR: join(home, "tmp"),
    OPENRIG_HOME: join(home, "openrig"),
    OPENRIG_PORT: String(port),
    OPENRIG_BIND_HOST: "127.0.0.1",
    OPENRIG_TMUX_SERVER: "isolated",
    OPENRIG_UI_ENABLED: String(UI_ENABLED),
    OPENRIG_TRANSCRIPTS_ENABLED: String(TRANSCRIPTS_ENABLED),
    ...(KERNEL_ENABLED ? {} : { OPENRIG_NO_KERNEL: "1" }),
    ...(PLUGIN_VENDOR_PROBE ? { OPENRIG_PLUGIN_VENDOR_PROBE_ON_START: "1" } : {}),
  };
  const nodeArgs = [
    ...(FETCH_GUARD_ENABLED ? ["--import", join(ROOT, "scripts/bench-fetch-guard.mjs")] : []),
    `--max-old-space-size=${HEAP_MB}`, DAEMON,
  ];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: SOURCE_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let output = "";
  const collect = buf => { output = (output + buf.toString()).slice(-12_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  let phase = "startup", peak = 0, peakDetails = null, idleRss = 0, maxProcesses = 0, rootHighWaterMb = 0;
  let startMetrics = null, finishMetrics = null;
  const timer = setInterval(() => {
    const observation = metrics(child.pid);
    if (!startMetrics && observation.processes) startMetrics = { ...observation, at: performance.now() };
    if (observation.processes) finishMetrics = { ...observation, at: performance.now() };
    if (observation.rssMb > peak) {
      peak = observation.rssMb;
      peakDetails = { phase, members: observation.members };
    }
    rootHighWaterMb = Math.max(rootHighWaterMb, observation.rootHighWaterMb);
    maxProcesses = Math.max(maxProcesses, observation.processes);
    if (phase === "idle") idleRss = observation.rssMb;
  }, INTERVAL_MS);
  const start = performance.now();
  try {
    while (!await isListening(port)) {
      if (child.exitCode !== null) throw new Error(`daemon exited during startup: ${child.exitCode}`);
      if (performance.now() - start > STARTUP_TIMEOUT_MS) {
        throw new Error(`daemon did not listen within ${STARTUP_TIMEOUT_MS} ms`);
      }
      await delay(150);
    }
    const startupMs = Math.round(performance.now() - start);
    phase = "idle";
    await delay(IDLE_MS);
    // Exercise real lightweight surfaces, including existing plugin inventory,
    // cost projection and disabled-by-default Slack status.
    const endpoints = ["/api/health", "/api/plugins", "/api/telemetry/usage/cost", "/api/gateway/slack/status", "/", "/specs"];
    let next = 0;
    const codes = {};
    const codesByPath = {};
    const unexpected = [];
    const begin = performance.now();
    phase = "requests";
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, REQUESTS) }, async () => {
      while (next < REQUESTS) {
        const i = next++;
        const path = endpoints[i % endpoints.length];
        const url = `http://127.0.0.1:${port}${path}`;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const content = await response.text();
          codes[response.status] = (codes[response.status] ?? 0) + 1;
          codesByPath[path] ??= {};
          codesByPath[path][response.status] = (codesByPath[path][response.status] ?? 0) + 1;
          const expected = path === "/" || path === "/specs" ? (UI_ENABLED ? 200 : 404) : 200;
          if (response.status !== expected ||
              (path === "/" && UI_ENABLED && !content.includes("<!doctype html") && !content.includes("<!DOCTYPE html")) ||
              (path === "/" && !UI_ENABLED && response.headers.get("x-openrig-web-ui") !== "off")) {
            unexpected.push({ path, status: response.status });
          }
        } catch {
          codes.network_error = (codes.network_error ?? 0) + 1;
          codesByPath[path] ??= {};
          codesByPath[path].network_error = (codesByPath[path].network_error ?? 0) + 1;
          unexpected.push({ path, networkError: true });
        }
      }
    }));
    const requestMs = Math.round(performance.now() - begin);
    phase = "cooldown";
    await delay(1_000);
    const last = metrics(child.pid);
    const duration = ((finishMetrics?.at ?? performance.now()) - (startMetrics?.at ?? start)) / 1000;
    const ticks = (finishMetrics?.ticks ?? last.ticks) - (startMetrics?.ticks ?? last.ticks);
    console.log(JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: SOURCE_ROOT, encoding: "utf8" }).trim(),
      modified: execFileSync("git", ["status", "--short", "--untracked-files=no"], { cwd: SOURCE_ROOT, encoding: "utf8" }).trim() !== "",
      node: process.version, heapLimitMb: HEAP_MB,
      host: "isolated local process, not a verified VPS",
      webUiEnabled: UI_ENABLED,
      transcriptsEnabled: TRANSCRIPTS_ENABLED,
      kernelAutoBootEnabled: KERNEL_ENABLED,
      fetchGuardEnabled: FETCH_GUARD_ENABLED,
      pluginVendorRemoteProbeOptIn: PLUGIN_VENDOR_PROBE,
      pluginVendorFetchLogObserved: output.includes("[plugin-vendor] fetch openrig-core"),
      startupMs, idleRssMb: idleRss,
      // Sampled every 200ms. Short-lived tmux helpers may start/exit between
      // samples; these figures exclude independent agent tmux sessions.
      sampledPeakProcessTreeRssMb: peak,
      sampledPeakProcessBreakdown: peakDetails,
      daemonHighWaterRssMb: rootHighWaterMb,
      cooldownRssMb: last.rssMb, sampledPeakProcessCount: maxProcesses,
      sampledAvgCpuPercentOfOneCore: Math.round(1000 * ticks / CLOCK_TICKS / Math.max(duration, 0.1)) / 10,
      requests: REQUESTS, concurrency: CONCURRENCY, requestMs,
      throughputRps: Math.round(1000 * REQUESTS / Math.max(requestMs, 1) * 10) / 10,
      httpCodes: codes, codesByPath, unexpected,
    }, null, 2));
    if (unexpected.length > 0) process.exitCode = 1;
  } catch (error) {
    // Logs from a fresh isolated daemon are kept local. Do not emit raw logs
    // because a future configuration could print sensitive environment data.
    console.error(`Benchmark failed: ${error.message}; last daemon output lines: ${output.split("\n").slice(-3).map(line => line.slice(0, 120)).join(" | ")}`);
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5_000)]);
    if (child.exitCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
