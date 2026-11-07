import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { psRoutes } from "../src/routes/ps.js";

describe("GET /api/ps/seat-resources", () => {
  const db = createFullTestDb();

  afterEach(() => { vi.useRealTimers(); });
  afterAll(() => { db.close(); });

  it("exposes a fresh fleet inventory with explicit unavailable metrics and preserves /api/ps", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-resource", "resource-rig");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("node-resource", "rig-resource", "dev");
    const registry = new SessionRegistry(db);
    const session = registry.registerClaimedSession("node-resource", "dev@resource-rig");
    registry.updateStatus(session.id, "exited");

    const panePid = vi.fn(async () => 1234);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("psProjectionService" as never, new PsProjectionService({ db }));
      c.set("tmuxAdapter" as never, { getPanePid: panePid });
      await next();
    });
    app.route("/api/ps", psRoutes);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-07T03:00:00.000Z");
    const first = await app.request("/api/ps/seat-resources");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      schemaVersion: 1, sampledAt: "2026-11-07T03:00:00.000Z", host: expect.any(String),
      seats: [{ sessionName: "dev@resource-rig", rigId: "rig-resource", state: "exited",
        observed: null, availability: "unavailable", reason: "seat_not_running" }],
    });
    vi.setSystemTime("2026-11-07T03:01:00.000Z");
    const second = await app.request("/api/ps/seat-resources");
    expect((await second.json()).sampledAt).toBe("2026-11-07T03:01:00.000Z");
    expect(panePid).not.toHaveBeenCalled();

    const ordinary = await app.request("/api/ps");
    expect(ordinary.status).toBe(200);
    const ordinaryRows = await ordinary.json() as unknown[];
    expect(Array.isArray(ordinaryRows)).toBe(true);
    expect(ordinaryRows).toHaveLength(1);
  });
});
