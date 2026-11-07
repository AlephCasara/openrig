import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { runtimeTelemetrySummary } from "../src/domain/runtime-telemetry-summary.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";

const timestamp = "2026-11-07T07:00:00Z";
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const log = (id: string) => ({ timeUnixNano: "1794034800000000000", attributes: [attr("event.name", "api_request"), attr("request_id", id), attr("input_tokens", "5")] });
const claude = (...ids: string[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: ids.map(log) }] }] });
const turn = (id: string, session = "session-a") => ({ type: "token_usage_record", timestamp, session_id: session, turn_id: id, id, token_usage: { input_tokens: 9, output_tokens: 1 } });
const native = (input: number, time: string) => ({ type: "event_msg", timestamp: time, session_id: "session-a", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: 1 } } } });
const rigSeats = new Map([["claude-seat", "rig-1"], ["codex-seat", "rig-1"], ["other-seat", "rig-2"]]);
const codexSeats = new Map([["session-a", "codex-seat"], ["session-other", "other-seat"]]);
const inputs = (override: Record<string, unknown> = {}) => ({
  claude: [{ envelope: claude("c1", "c1", "c2"), verifiedSeatId: "claude-seat" }],
  codex: [native(100, "2026-11-07T07:00:00Z"), turn("t1"), native(10, "2026-11-07T07:02:00Z"), turn("t1"), turn("ignored", "session-other")],
  verifiedSeatRigs: rigSeats, verifiedCodexSeats: codexSeats, ...override,
});

describe("A6 passive dual-runtime projection", () => {
  it("keeps call, cumulative and turn semantics separate, dedupes, reports reset/overlap and unknown USD", () => {
    const view = runtimeTelemetrySummary("rig-1", inputs(), timestamp);
    expect(view.records.filter(r => r.runtime === "claude-code")).toHaveLength(2);
    expect(view.records.filter(r => r.runtime === "codex")).toHaveLength(3);
    expect(view.records.map(r => r.measurement)).toEqual(expect.arrayContaining(["call", "turn", "cumulative-snapshot"]));
    expect(view.records.some(r => r.nativeSessionId === "session-other")).toBe(false);
    expect(view.coverage.gaps).toEqual(expect.arrayContaining(["claude-duplicate-record", "codex-duplicate-record", "codex-counter-reset", "snapshot-turn-coverage-unverified"]));
    expect(view.coverage.totalTokens).toBeNull();
    expect(view.coverage.billingUsd).toBeNull();
    expect(view.exporter).toEqual({ status: "unavailable", reason: "no-external-health-contract" });
    expect(view.records.every(r => r.cost.amountUsd === null)).toBe(true);
    expect(view.records.every(r => r.model === null)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/headers|prompt|authorization|private-body/);
  });

  it("makes missing sources unavailable without zero claims", () => {
    const view = runtimeTelemetrySummary("rig-1", null, timestamp);
    expect(view.coverage.status).toBe("unavailable");
    expect(view.sources["claude-otlp"].reason).toBe("source-not-configured");
    expect(view.coverage.totalTokens).toBeNull();
  });

  it("distinguishes unverified rig attribution from verified other-rig filtering for both sources", () => {
    const unknown = runtimeTelemetrySummary("rig-1", inputs({ verifiedSeatRigs: new Map() }), timestamp);
    expect(unknown.records).toHaveLength(0);
    expect(unknown.sources["claude-otlp"]).toMatchObject({ status: "partial", reason: "record-coverage-incomplete" });
    expect(unknown.sources["codex-usage"]).toMatchObject({ status: "partial", reason: "coverage-gaps-or-unknown-attribution" });
    expect(unknown.coverage.gaps).toEqual(expect.arrayContaining(["claude-unverified-rig-attribution", "codex-unverified-rig-attribution"]));
    const other = runtimeTelemetrySummary("rig-1", inputs({ verifiedSeatRigs: new Map([["claude-seat", "rig-2"], ["codex-seat", "rig-2"], ["other-seat", "rig-2"]]) }), timestamp);
    expect(other.records).toHaveLength(0);
    expect(other.coverage.gaps).not.toContain("claude-unverified-rig-attribution");
    expect(other.coverage.gaps).not.toContain("codex-unverified-rig-attribution");
  });

  it("excludes foreign-rig Codex resets and duplicates before diagnosing target coverage", () => {
    const otherNative = (input: number, time: string) => ({ ...native(input, time), session_id: "session-other" });
    const foreign = [otherNative(100, "2026-11-07T07:00:00Z"), otherNative(10, "2026-11-07T07:02:00Z"), turn("foreign", "session-other"), turn("foreign", "session-other")];
    const view = runtimeTelemetrySummary("rig-1", inputs({ claude: [], codex: foreign }), timestamp);
    expect(view.records).toEqual([]);
    expect(view.sources["codex-usage"]).toEqual({ status: "available", reason: null, records: 0 });
    expect(view.coverage.status).toBe("available");
    expect(view.coverage.gaps).toEqual([]);

    const local = { ...turn("local"), model: "test-model", token_usage: { input_tokens: 9, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0 } };
    const crowded = runtimeTelemetrySummary("rig-1", inputs({ claude: [], codex: [...Array.from({ length: 180 }, (_, i) => turn(`foreign-${i}`, "session-other")), local] }), timestamp);
    expect(crowded.records.filter(r => r.runtime === "codex")).toHaveLength(1);
    expect(crowded.records[0]?.nativeSessionId).toBe("session-a");
    expect(crowded.coverage.gaps).not.toContain("codex-input-limit");
    expect(crowded.sources["codex-usage"].status).toBe("available");
  });

  it("keeps unknown Codex seat and unknown seat-to-rig mapping visible as partial", () => {
    for (const overrides of [
      { verifiedCodexSeats: new Map() },
      { verifiedSeatRigs: new Map([["other-seat", "rig-2"]]) },
    ]) {
      const view = runtimeTelemetrySummary("rig-1", inputs({ claude: [], codex: [turn("unverified")], ...overrides }), timestamp);
      expect(view.records).toEqual([]);
      expect(view.sources["codex-usage"].status).toBe("partial");
      expect(view.coverage.gaps).toContain("codex-unverified-rig-attribution");
    }
  });

  it("does not attribute unknown-session Codex resets, duplicates, or overlap gaps to a rig", () => {
    const unknownNative = (input: number, time: string) => ({ ...native(input, time), session_id: "unknown-session" });
    const unverified = [unknownNative(100, "2026-11-07T07:00:00Z"), turn("unknown-turn", "unknown-session"), unknownNative(10, "2026-11-07T07:02:00Z"), turn("unknown-turn", "unknown-session")];
    const view = runtimeTelemetrySummary("rig-1", inputs({ claude: [], codex: unverified, verifiedCodexSeats: new Map(), verifiedSeatRigs: new Map() }), timestamp);
    expect(view.records).toEqual([]);
    expect(view.sources["codex-usage"]).toEqual({ status: "partial", reason: "coverage-gaps-or-unknown-attribution", records: 0 });
    expect(view.coverage.status).toBe("partial");
    expect(view.coverage.gaps).toContain("codex-unverified-rig-attribution");
    for (const diagnostic of ["counter-reset:unknown-session", "snapshot-turn-coverage-unverified", "codex-duplicate-record", "codex-counter-reset"]) {
      expect(view.coverage.gaps).not.toContain(diagnostic);
    }
    expect(view.coverage.totalTokens).toBeNull();
    expect(view.coverage.billingUsd).toBeNull();
    expect(view.exporter).toEqual({ status: "unavailable", reason: "no-external-health-contract" });
  });

  it("bounds a single oversized Claude envelope before decoding", () => {
    const view = runtimeTelemetrySummary("rig-1", inputs({ claude: [{ envelope: claude(...Array.from({ length: 20000 }, (_, i) => `c${i}`)), verifiedSeatId: "claude-seat" }], codex: [] }), timestamp);
    expect(view.records).toHaveLength(128);
    expect(view.coverage.gaps).toContain("claude-record-limit");
    expect(view.sources["claude-otlp"]).toMatchObject({ status: "partial", reason: "record-coverage-incomplete", records: 128 });
  });

  it("validates rigId and serves bounded records and distinct exporter status via GET", async () => {
    const app = new Hono();
    app.route("/api/telemetry", telemetryRoutes({ db: () => { throw Error("db should not be read"); }, nowIso: () => timestamp, runtimeInputs: () => inputs() }));
    for (const query of ["", "?rigId=", "?rigId=../secrets", "?rigId=rig-1&rigId=rig-2", `?rigId=${"x".repeat(161)}`]) {
      expect((await app.request(`/api/telemetry/runtime/summary${query}`)).status).toBe(400);
    }
    const response = await app.request("/api/telemetry/runtime/summary?rigId=rig-1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ schemaVersion: 1, rigId: "rig-1", exporter: { status: "unavailable" } });
    expect(body.records.length).toBeLessThanOrEqual(128);
  });
});
