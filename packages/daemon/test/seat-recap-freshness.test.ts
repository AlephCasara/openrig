import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { readSeatRecapAge, staleRecapWarning } from "../src/domain/seat-recap-freshness.js";

describe("authored recap freshness", () => {
  let db: Database.Database;
  let topologyRoot: string;
  let recapPath: string;

  beforeEach(() => {
    db = createFullTestDb();
    topologyRoot = mkdtempSync(join(tmpdir(), "recap-age-"));
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "my-rig");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-1", "rig-1", "lead.dev-a", "codex");
    const seatDir = join(topologyRoot, "rigs", "my-rig", "seats", "lead.dev-a");
    mkdirSync(seatDir, { recursive: true });
    recapPath = join(seatDir, "RECAP.md");
    writeFileSync(recapPath, "## Recent Decisions\nold state\n");
  });

  afterEach(() => {
    db.close();
    rmSync(topologyRoot, { recursive: true, force: true });
  });

  function qitem(id: string, created: string): void {
    db.prepare(`INSERT INTO queue_items
      (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
      VALUES (?, ?, ?, ?, ?, 'pending', 'routine', 'fixture')`)
      .run(id, created, created, "supervisor@external", "lead-dev-a@my-rig");
  }

  it("is stale iff the recap predates the selected qitem creation", () => {
    utimesSync(recapPath, new Date("2026-11-08T05:00:00Z"), new Date("2026-11-08T05:00:00Z"));
    qitem("qitem-newer", "2026-11-08T06:00:00Z");
    qitem("qitem-older", "2026-11-08T04:00:00Z");

    const stale = readSeatRecapAge(db, { topologyRoot, seatRef: "lead-dev-a", rigName: "my-rig", since: "qitem-newer" });
    expect(stale).toMatchObject({ status: "stale", stale: true, reference: { kind: "qitem", qitemId: "qitem-newer" } });
    expect(staleRecapWarning(stale)).toMatch(/stale/);

    const current = readSeatRecapAge(db, { topologyRoot, seatRef: "lead-dev-a", rigName: "my-rig", since: "qitem-older" });
    expect(current).toMatchObject({ status: "ok", stale: false });
  });

  it("defaults to the latest queue activity and treats an absent recap as a named missing state", () => {
    qitem("qitem-latest", "2026-11-08T06:00:00Z");
    rmSync(recapPath);
    const age = readSeatRecapAge(db, { topologyRoot, seatRef: "lead.dev-a", rigName: "my-rig" });
    expect(age).toMatchObject({ status: "missing", stale: true, reference: { kind: "latest-queue", qitemId: "qitem-latest" } });
    expect(staleRecapWarning(age)).toMatch(/No authored recap/);
  });
});
