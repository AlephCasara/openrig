import { describe, it, expect } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot } from "../src/types.js";

const route = "/api/ps/seat-resources";
const body = { schemaVersion: 1, sampledAt: "2026-11-07T04:30:00Z", host: "fixture-node", seats: [
  { sessionName: "ready@rig", rigId: "rig", state: "running", availability: "available", reason: null, observed: { bytesCurrent: 10485760, bytesLimit: 20971520, swapBytesCurrent: 524288, source: "cgroup-v2" } },
  { sessionName: "offline@rig", rigId: "rig", state: "stopped", availability: "unavailable", reason: "cgroup missing", observed: null },
  { sessionName: "legacy@rig", rigId: "rig", state: "running", availability: "unsupported", reason: "no cgroup-v2", observed: null },
] };
function fixture(payload: unknown = body, status = 200) {
  const calls: string[] = [];
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url: string, init?: RequestInit) => {
    const target = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${target.pathname}`);
    return Response.json(payload, { status });
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "memory-test", getSnapshot: () => snap });
  const refresh = async () => { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); };
  const text = () => renderScreen(view.get(), snap, { cols: 170, rows: 65 }).lines.join("\n");
  return { client, calls, view, refresh, text, snapshot: () => snap };
}

describe("System → Memory passive journey", () => {
  it("opens via System, hydrates exactly one GET, draws all states and seat detail, and navigates back", async () => {
    const t = fixture();
    t.view.dispatch({ type: "jump", section: "system" });
    expect(computeExplorerRows(t.view.get(), t.snapshot()).some((r) => r.key === "section:memory")).toBe(true);
    t.view.dispatch(parseCommand("memory"));
    expect(t.view.get().section).toBe("memory");
    await t.refresh();
    expect(t.calls).toEqual([`GET ${route}`]);
    expect(t.text()).toContain("10.0 MiB");
    expect(t.text()).toContain("unavailable: cgroup missing");
    expect(t.text()).toContain("unsupported: no cgroup-v2");
    expect(t.text()).toContain("fixture-node");
    t.view.dispatch({ type: "memory-select", key: "rig/ready@rig" });
    expect(t.text()).toContain("Swap: 0.5 MiB");
    expect(t.text()).toContain("Source: cgroup-v2");
    t.view.dispatch({ type: "back" });
    expect(t.view.get().memorySelected).toBeNull();
    expect(t.view.get().section).toBe("memory");
    t.view.dispatch({ type: "back" });
    expect(t.view.get().section).toBe("system");
  });
  it("fails closed for malformed payloads, never fabricating zero memory", async () => {
    for (const bad of [{ ...body, seats: [{ ...body.seats[0], observed: { bytesCurrent: -1, bytesLimit: null, source: "cgroup-v2" } }] }, { ...body, seats: [{ ...body.seats[1], reason: null }] }, { ...body, schemaVersion: 2 }]) {
      const t = fixture(bad);
      t.view.dispatch(parseCommand("memory"));
      await t.refresh();
      expect(t.snapshot().readErrors.join(" ")).toContain("not a valid seat-resources/v1");
      expect(t.text()).toContain("Memory unavailable");
      expect(t.text()).not.toContain("0.0 MiB");
    }
  });
  it("preserves 404 and unavailable reasons and permits passive re-reads", async () => {
    const older = fixture({ error: "not_found" }, 404);
    older.view.dispatch(parseCommand("memory"));
    await older.refresh();
    expect(older.text()).toContain("HTTP 404");
    const t = fixture();
    t.view.dispatch(parseCommand("memory"));
    await t.refresh(); await t.refresh();
    expect(t.calls).toEqual([`GET ${route}`, `GET ${route}`]);
    t.view.dispatch({ type: "memory-select", key: "rig/offline@rig" });
    expect(t.text()).toContain("Reason: cgroup missing");
  });
});
