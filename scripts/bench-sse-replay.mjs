#!/usr/bin/env node
/** One disposable SQLite/EventBus replay read with bounded (when supported) payload bytes.
 * BENCH_REPLAY_MODULE points at the built original or modified EventBus.
 * The baseline ignores the fifth replayPage argument; that is intentional.
 */
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";

const { EventBus } = await import(process.env.BENCH_REPLAY_MODULE
  ?? "../packages/daemon/dist/domain/event-bus.js");
const events = Number(process.env.BENCH_REPLAY_EVENTS ?? 500);
const payloadBytes = Number(process.env.BENCH_REPLAY_BYTES ?? 98367);
const pageBudgetBytes = Number(process.env.BENCH_REPLAY_PAGE_BUDGET ?? 4 * 1024 * 1024);
if (![events, payloadBytes, pageBudgetBytes].every(Number.isSafeInteger)
  || events < 1 || events > 10000 || payloadBytes < 64 || payloadBytes > 1_000_000
  || pageBudgetBytes < 1) {
  throw new Error("Invalid BENCH_REPLAY_EVENTS, BENCH_REPLAY_BYTES or BENCH_REPLAY_PAGE_BUDGET");
}

const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const bus = new EventBus(db);
  const insert = db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)");
  const payload = JSON.stringify({ type: "view.changed", viewName: "x".repeat(Math.max(1, payloadBytes - 80)), cause: "sse-replay-benchmark" });
  const txn = db.transaction(() => {
    for (let i = 0; i < events; i++) insert.run(null, null, "view.changed", payload);
  });
  txn();
  const before = process.memoryUsage();
  const start = performance.now();
  // One identical request at the user-facing route's cap. Older builds
  // legally ignore the extra argument, exposing their unbounded materialization.
  const page = bus.replayPage(0, bus.maxSeq(), events, undefined, pageBudgetBytes);
  const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
  const after = process.memoryUsage();
  console.log(JSON.stringify({
    events, actualPayloadBytes: Buffer.byteLength(payload),
    pageBudgetBytes, rowsReturned: page.length,
    firstSeq: page[0]?.seq ?? null, lastSeq: page.at(-1)?.seq ?? null,
    elapsedMs,
    heapBeforeMb: Math.round(before.heapUsed / 1048576 * 10) / 10,
    heapAfterMb: Math.round(after.heapUsed / 1048576 * 10) / 10,
    heapDeltaMb: Math.round((after.heapUsed - before.heapUsed) / 1048576 * 10) / 10,
    peakProcessRssMb: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10,
    finalProcessRssMb: Math.round(after.rss / 1048576 * 10) / 10,
  }));
} finally {
  db.close();
}
