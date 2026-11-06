#!/usr/bin/env node
/** Measure max RSS while draining a single large committed EventBus backlog.
 * Works on pristine and modified builds: no API flags or internal mocks.
 * Use identical BENCH_EVENTS and BENCH_EVENT_BYTES for before/after runs.
 */
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
const { EventBus } = await import(process.env.BENCH_EVENT_BUS_MODULE ?? "../packages/daemon/dist/domain/event-bus.js");

const count = Number(process.env.BENCH_EVENTS ?? 12_000);
const bytes = Number(process.env.BENCH_EVENT_BYTES ?? 8192);
if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(bytes) || bytes < 64 || bytes > 1_000_000)
  throw new Error("BENCH_EVENTS must be a positive integer; BENCH_EVENT_BYTES must be 64..1000000");
const db = new Database(":memory:");
db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
const bus = new EventBus(db);
const insert = db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)");
const payload = JSON.stringify({ type: "view.changed", viewName: "x".repeat(Math.max(1, bytes - 80)), cause: "vps-benchmark" });
let delivered = 0;
bus.subscribe(() => delivered++);
const start = performance.now();
bus.withNotifyEnvelope(() => {
  for (let i = 0; i < count; i++)
    insert.run(null, null, "view.changed", payload);
});
const elapsedMs = Math.round(performance.now() - start);
if (delivered !== count) throw new Error(`Lost notifications: ${delivered}/${count}`);
console.log(JSON.stringify({
  events: count, payloadBytes: Buffer.byteLength(payload),
  delivered, elapsedMs,
  peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10,
  finalRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10,
  heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 10) / 10,
}, null, 2));
db.close();
