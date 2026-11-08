import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  TopologySeatResolutionError,
  listOrphanTopologySeatFolders,
  resolveTopologySeat,
} from "../src/domain/topology-seat-resolution.js";
import { resolveAuthoredRecapPointer, writeSeatRecapAt } from "../src/domain/context-packs/seat-recap-store.js";

describe("registered topology seat resolution", () => {
  let db: Database.Database;
  let topologyRoot: string;

  beforeEach(() => {
    db = createFullTestDb();
    topologyRoot = mkdtempSync(join(tmpdir(), "topology-seat-resolution-"));
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "my-rig");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-lead", "rig-1", "lead.dev-a", "codex");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-dev", "rig-1", "dev.impl", "codex");
    mkdirSync(join(topologyRoot, "rigs", "my-rig", "seats", "lead.dev-a"), { recursive: true });
    mkdirSync(join(topologyRoot, "rigs", "my-rig", "seats", "dev-impl"), { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(topologyRoot, { recursive: true, force: true });
  });

  it("maps logical, dashed and canonical refs onto the same registered dotted folder", () => {
    for (const ref of ["lead.dev-a", "lead-dev-a", "lead-dev-a@my-rig"]) {
      const resolved = resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: ref });
      expect(resolved.logicalId).toBe("lead.dev-a");
      expect(resolved.folderName).toBe("lead.dev-a");
      expect(resolved.seatDir).toBe(join(topologyRoot, "rigs", "my-rig", "seats", "lead.dev-a"));
    }
  });

  it("preserves a verified existing dashed physical layout for the registered logical seat", () => {
    const resolved = resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: "dev.impl" });
    expect(resolved.folderName).toBe("dev-impl");
    expect(resolved.seatDir).toBe(join(topologyRoot, "rigs", "my-rig", "seats", "dev-impl"));
  });

  it("chooses the logical id for new storage instead of inventing a dashed directory", () => {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-qa", "rig-1", "qa.reviewer", "codex");
    const resolved = resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: "qa-reviewer" });
    expect(resolved.folderName).toBe("qa.reviewer");
  });

  it("rejects unknown seats and lists valid logical ids", () => {
    expect(() => resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: "nosuchseat" }))
      .toThrowError(expect.objectContaining<TopologySeatResolutionError>({
        code: "seat_not_found",
        validLogicalIds: ["dev.impl", "lead.dev-a"],
      }));
  });

  it("never legitimizes a symlinked alias", () => {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("node-ops", "rig-1", "ops.agent", "codex");
    const outside = join(topologyRoot, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(topologyRoot, "rigs", "my-rig", "seats", "ops-agent"));
    expect(() => resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: "ops-agent" }))
      .toThrow(/symlink|not a directory/);
  });

  it("reports the duplicate dashed bug folder as orphan when the logical folder is authoritative", () => {
    mkdirSync(join(topologyRoot, "rigs", "my-rig", "seats", "lead-dev-a"));
    const orphans = listOrphanTopologySeatFolders(db, { topologyRoot, rigName: "my-rig" });
    expect(orphans.map((entry) => entry.name)).toContain("lead-dev-a");
    expect(orphans.map((entry) => entry.name)).not.toContain("lead.dev-a");
    expect(orphans.map((entry) => entry.name)).not.toContain("dev-impl");
  });

  it("acceptance: dashed/session refs write and read the same registered logical seat folder", () => {
    const written = writeSeatRecapAt({
      db,
      topologyRoot,
      rig: "my-rig",
      seat: "lead-dev-a",
      content: "## Recent Decisions\nresolved the seat through the registry",
    });
    expect(written.path).toBe(join(topologyRoot, "rigs", "my-rig", "seats", "lead.dev-a", "RECAP.md"));
    expect(resolveAuthoredRecapPointer("lead-dev-a@my-rig", topologyRoot, db)).toEqual({ address: "seat:RECAP.md", chainLength: 0 });
  });

  it("acceptance: unknown recap seat fails and names valid logical ids without creating a folder", () => {
    expect(() => writeSeatRecapAt({
      db,
      topologyRoot,
      rig: "my-rig",
      seat: "nosuchseat",
      content: "## Recent Decisions\nnone",
    })).toThrow(/Valid logical seat ids: dev\.impl, lead\.dev-a/);
    expect(() => resolveTopologySeat(db, { topologyRoot, rigName: "my-rig", seatRef: "nosuchseat" })).toThrow();
  });
});
