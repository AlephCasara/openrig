import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { parseRuntimeSummary, parseTelemetryPage, telemetryLines } from "../src/telemetry/telemetry-model.js";
import { createViewState, computeExplorerRows, emptySnapshot } from "../src/state.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import { SECTION_REGISTRY, SYSTEM_SECTIONS } from "../src/sections.js";

function page(stream: string, rows: Array<Record<string, string | null>> = [], gaps: Array<{ code: string }> = []) {
  return { schemaVersion: 1, stream, observedAt: "2026-11-07T05:00:00Z", source: { hostId: "h", bootEpoch: "b" }, rows,
    page: { returned: rows.length, filtered: 0, withheld: 0, hasMore: true, nextCursor: "abc", capReason: "source_row_limit" },
    coverage: { status: gaps.length ? "partial" : "retained_window", historyCompleteness: "unknown", retainedMinimum: "1", gaps, gapCount: gaps.length, gapDetailsTruncated: false } };
}

describe("System → Telemetry passive read", () => {
  it("preserves bounded rows, explicit source gaps, and independent unknown source status", async () => {
    const calls: string[] = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input, init) => {
      const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/api/telemetry/runtime/summary") return Response.json({ schemaVersion: 1, rigId: "rig/1", records: [], coverage: { status: "partial", historyCompleteness: "unknown", gaps: ["counter-reset:s1"], totalTokens: null, billingUsd: null }, sources: { "claude-otlp": { status: "available", reason: null, records: 2 }, "codex-usage": { status: "partial", reason: "coverage-gaps", records: 3 } }, exporter: { status: "unavailable", reason: "no-external-health-contract" } });
      if (url.pathname === "/api/ps") return Response.json([{ rigId: "rig/1" }]);
      if (url.pathname === "/api/rigs/rig%2F1/nodes") return Response.json([{ nodeId: "node/1" }]);
      if (url.pathname.includes("/events")) return Response.json(page("events", [{ seq: "1", type: "boot", createdAt: "2026-11-07T05:00:00Z" }], [{ code: "before_retained_floor" }]));
      if (url.pathname.includes("/queue-transitions")) return Response.json(page("queue-transitions", [{ transitionId: "2", state: "pending", createdAt: null }]));
      if (url.pathname.includes("/tenures")) return Response.json(page("tenures", [{ generationOrdinal: "3", kind: "boot", bootAt: null }], [{ code: "tenure_floor_history_unavailable" }]));
      throw new Error(`unexpected endpoint ${url.pathname}`);
    }) as typeof fetch });
    const view = createViewState({ instanceId: "telemetry" });
    view.dispatch(parseCommand("telemetry"));
    expect(view.get().section).toBe("telemetry");
    const snap = await hydrateSnapshot(client, undefined, null, null, null, view.get());
    expect(snap.telemetry?.events).toMatchObject({ status: "available", rows: [{ type: "boot" }] });
    const screen = renderScreen(view.get(), snap, { cols: 150, rows: 50 });
    const rendered = screen.lines.join("\n");
    expect(rendered).toContain("System · Telemetry");
    expect(rendered).toContain("before_retained_floor");
    expect(rendered).toContain("tenure_floor_history_unavailable");
    expect(rendered).toContain("Claude OTLP");
    expect(rendered).toContain("Codex native usage");
    expect(rendered).toContain("counter-reset:s1");
    expect(rendered).toContain("billing USD");
    expect(rendered).toContain("Exporter health: unavailable");
    expect(calls).toEqual([
      "GET /api/telemetry/v1/events?start=retained&limit=16",
      "GET /api/telemetry/v1/queue-transitions?start=retained&limit=16",
      "GET /api/ps", "GET /api/telemetry/runtime/summary?rigId=rig%2F1", "GET /api/rigs/rig%2F1/nodes", "GET /api/telemetry/v1/nodes/node%2F1/tenures?limit=16",
    ]);
    expect(SYSTEM_SECTIONS).toContain("telemetry");
    expect(SECTION_REGISTRY.find(s => s.name === "telemetry")).toBeDefined();
    expect(computeExplorerRows(view.get(), emptySnapshot()).some(r => r.key === "section:telemetry")).toBe(true);
  });

  it("fails closed for malformed responses, unavailable routes and an empty addressable inventory", async () => {
    expect(parseTelemetryPage({ rows: [] }, "events")).toEqual({ status: "unavailable", reason: "invalid finite telemetry response" });
    expect(parseRuntimeSummary({ schemaVersion: 1, rigId: "r", records: [], coverage: { status: "partial", historyCompleteness: "unknown", gaps: [], totalTokens: null, billingUsd: null }, sources: { "claude-otlp": { status: "partial", reason: null, records: 0 }, "codex-usage": { status: "unavailable", reason: "not-configured", records: 0 } }, exporter: { status: "unavailable", reason: "no-external-health-contract" } })).toEqual({ status: "unavailable", reason: "invalid runtime summary" });
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
      if (String(input).endsWith("/api/ps")) return Response.json([]);
      return Response.json({ error: "unavailable" }, { status: 503 });
    }) as typeof fetch });
    const data = await client.finiteTelemetry();
    expect(data.events).toEqual({ status: "unavailable", reason: "HTTP 503" });
    expect(data.tenures).toMatchObject({ status: "unavailable" });
    expect(data.runtime).toMatchObject({ status: "unavailable", reason: "rig inventory unavailable" });
    expect(telemetryLines(data, 120).map(l => l.text).join("\n")).toContain("history unknown");
  });

  it("fails closed for multiple addressable rigs while retaining passive telemetry reads", async () => {
    const calls: string[] = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/ps") return Response.json([{ rigId: "rig-a" }, { rigId: "rig-b" }]);
      if (url.pathname === "/api/telemetry/v1/events") return Response.json(page("events", [{ seq: "1", type: "boot", createdAt: null }]));
      if (url.pathname === "/api/telemetry/v1/queue-transitions") return Response.json(page("queue-transitions", [{ transitionId: "2", state: "pending", createdAt: null }]));
      throw new Error(`unexpected targeted request ${url.pathname}`);
    }) as typeof fetch });
    const data = await client.finiteTelemetry();
    expect(data.events).toMatchObject({ status: "available", rows: [{ type: "boot" }] });
    expect(data.transitions).toMatchObject({ status: "available", rows: [{ state: "pending" }] });
    expect(data.runtime).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/multiple rigs|ambiguous/i) });
    expect(data.tenures).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/multiple rigs|ambiguous/i) });
    expect(telemetryLines(data, 120).map(l => l.text).join("\n")).toMatch(/multiple rigs|ambiguous/i);
    expect(calls).toEqual([
      "/api/telemetry/v1/events?start=retained&limit=16",
      "/api/telemetry/v1/queue-transitions?start=retained&limit=16",
      "/api/ps",
    ]);
  });

  it("leaves tenures unavailable for multiple nodes of one rig without choosing the first", async () => {
    const calls: string[] = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/ps") return Response.json([{ rigId: "rig-1" }]);
      if (url.pathname === "/api/rigs/rig-1/nodes") return Response.json([{ nodeId: "node-a" }, { nodeId: "node-b" }]);
      if (url.pathname === "/api/telemetry/runtime/summary") return Response.json({ schemaVersion: 1, rigId: "rig-1", records: [], coverage: { status: "available", historyCompleteness: "unknown", gaps: [], totalTokens: null, billingUsd: null }, sources: { "claude-otlp": { status: "available", reason: null, records: 0 }, "codex-usage": { status: "available", reason: null, records: 0 } }, exporter: { status: "unavailable", reason: "no-external-health-contract" } });
      if (url.pathname === "/api/telemetry/v1/events") return Response.json(page("events", [{ seq: "1", type: "boot", createdAt: null }]));
      if (url.pathname === "/api/telemetry/v1/queue-transitions") return Response.json(page("queue-transitions", [{ transitionId: "2", state: "pending", createdAt: null }]));
      throw new Error(`unexpected tenure or targeted request ${url.pathname}`);
    }) as typeof fetch });
    const data = await client.finiteTelemetry();
    expect(data.events).toMatchObject({ status: "available", rows: [{ type: "boot" }] });
    expect(data.transitions).toMatchObject({ status: "available", rows: [{ state: "pending" }] });
    expect(data.runtime).toMatchObject({ status: "available" });
    expect(data.tenures).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/multiple nodes|ambiguous/i) });
    expect(calls).toEqual([
      "/api/telemetry/v1/events?start=retained&limit=16",
      "/api/telemetry/v1/queue-transitions?start=retained&limit=16",
      "/api/ps",
      "/api/telemetry/runtime/summary?rigId=rig-1",
      "/api/rigs/rig-1/nodes",
    ]);
  });
});
