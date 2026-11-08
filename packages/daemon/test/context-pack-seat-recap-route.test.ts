// `rig context recap-write` hands the recap to the daemon when its own write is refused (a sandboxed seat can't write
// the topology tree). The daemon's route writes it through the same store, with the same address checks.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextPacksRoutes } from "../src/routes/context-packs.js";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

describe("POST /api/context-packs/seat-recap", () => {
  let tmp: string;
  let saved: string | undefined;
  let db: Database.Database;
  let app: Hono;
  const write = (body: unknown) => app.request("/api/context-packs/seat-recap", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("recap-rig", "r1");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("recap-s1", "recap-rig", "s1", "codex");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)").run("recap-session-s1", "recap-s1", "s1@r1", "running");
    const rigRepo = new RigRepository(db);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("rigRepo" as never, rigRepo); await next(); });
    app.route("/api/context-packs", contextPacksRoutes());
    tmp = mkdtempSync(join(tmpdir(), "seat-recap-route-"));
    saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
    mkdirSync(join(tmp, "topology", "rigs", "r1", "seats"), { recursive: true });
  });
  afterEach(() => {
    db.close();
    if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
    else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the seat's RECAP.md (creating the seat folder) and supersedes an earlier one into the chain", async () => {
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    const first = await write({ rig: "r1", seat: "s1", content: "## Recent Decisions\nchose A because B" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ path: join(seatDir, "RECAP.md"), superseded: 0 });
    const second = await write({ rig: "r1", seat: "s1", content: "## Recent Decisions\nthen C" });
    expect(await second.json()).toEqual({ path: join(seatDir, "RECAP.md"), superseded: 1 });
    expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("then C");
    expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
  });

  it("refuses what the CLI refuses: a missing rig, an unsafe segment, a symlinked path and an unaddressable recap", async () => {
    const missing = await write({ rig: "nope", seat: "s1", content: "## Recent Decisions\nx" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toMatch(/does not exist/);
    expect(existsSync(join(tmp, "topology", "rigs", "nope"))).toBe(false);

    const unsafe = await write({ rig: "r1", seat: "../escape", content: "## Recent Decisions\nx" });
    expect(unsafe.status).toBe(400);
    expect((await unsafe.json()).message).toMatch(/unsafe seat segment/);

    const outside = join(tmp, "outside");
    mkdirSync(outside);
    const seatsRoot = join(tmp, "topology", "rigs", "r1", "seats");
    rmSync(seatsRoot, { recursive: true, force: true });
    symlinkSync(outside, seatsRoot);
    const linked = await write({ rig: "r1", seat: "s1", content: "## Recent Decisions\nx" });
    expect(linked.status).toBe(400);
    expect((await linked.json()).message).toMatch(/symlink/);
    expect(existsSync(join(outside, "s1"))).toBe(false);
    rmSync(seatsRoot);
    mkdirSync(seatsRoot);

    const unaddressable = await write({ rig: "r1", seat: "s1", content: "## Same\na\n## Same\nb" });
    expect(unaddressable.status).toBe(400);
    expect((await unaddressable.json()).error).toBe("recap_write_refused");
    expect(existsSync(join(tmp, "topology", "rigs", "r1", "seats", "s1", "RECAP.md"))).toBe(false);
  });

  // A seat may write its own folder (a Codex writable root), and the daemon writes here for it, so a link the seat plants
  // at RECAP.md or recap-superseded/ must not carry the daemon's write out of the folder. The write is refused, and the
  // current recap, the chain and the link's private target keep their bytes.
  it.each([
    ["recap-superseded/ as a link to a private folder", "recap-superseded", "folder"],
    ["recap-superseded/ as a dangling link", "recap-superseded", "dangling"],
    ["RECAP.md as a link to a private file", "RECAP.md", "file"],
  ] as const)("refuses %s, and moves nothing", async (_name, entry, target) => {
    const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
    expect((await write({ rig: "r1", seat: "s1", content: "## Recent Decisions\nfirst" })).status).toBe(200);
    const privateDir = join(tmp, "private");
    mkdirSync(privateDir);
    const sentinel = join(privateDir, "sentinel.md");
    writeFileSync(sentinel, "private bytes\n");
    const gone = join(tmp, "gone");
    if (entry === "RECAP.md") rmSync(join(seatDir, "RECAP.md"));
    symlinkSync(target === "folder" ? privateDir : target === "dangling" ? gone : sentinel, join(seatDir, entry));
    const before = entry === "RECAP.md" ? null : readFileSync(join(seatDir, "RECAP.md"), "utf-8");

    const refused = await write({ rig: "r1", seat: "s1", content: "## Recent Decisions\nsecond" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "recap_write_refused", message: expect.stringMatching(/is a link.*Nothing was written/) });
    expect(readdirSync(privateDir)).toEqual(["sentinel.md"]);
    expect(readFileSync(sentinel, "utf-8")).toBe("private bytes\n");
    expect(existsSync(gone)).toBe(false);
    if (before !== null) expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toBe(before);
    expect(readdirSync(seatDir).filter((name) => name.startsWith(".RECAP-"))).toEqual([]);
  });

  it("answers a recap with a long whitespace run in a heading line promptly: the heading scan is linear", async () => {
    const started = performance.now();
    const res = await write({ rig: "r1", seat: "s1", content: `#${"\t".repeat(200_000)}\n## Recent Decisions\nkept the shared parser linear` });
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses a registered rig whose physical topology tree is missing", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("recap-rig-2", "r2");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)").run("recap-s2", "recap-rig-2", "qa.reviewer", "codex");

    const res = await write({ rig: "r2", seat: "qa.reviewer", content: "## Recent Decisions\nrefuse implicit rig provisioning" });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/physical topology rig directory.*does not exist/i);
    expect(existsSync(join(tmp, "topology", "rigs", "r2"))).toBe(false);
  });

  it("refuses a body without rig, seat and content as strings", async () => {
    const res = await write({ rig: "r1", seat: "s1" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });
});
