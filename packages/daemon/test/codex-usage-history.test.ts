import { describe, expect, it } from "vitest";
import { collectCodexUsageHistory, decodeCodexUsageRecord } from "../src/domain/codex-usage-history.js";

const native = (timestamp: string, input: number, session = "thread-a") => ({
  type: "event_msg", timestamp, session_id: session,
  payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, output_tokens: 10, cached_input_tokens: 4, reasoning_output_tokens: 2 },
    last_token_usage: { input_tokens: 99, output_tokens: 77 },
    model_context_window: 200_000,
  } },
});
const turn = (id: string, input: number, timestamp = "2026-11-07T07:01:00Z") => ({
  type: "token_usage_record", id, timestamp, session_id: "thread-a", turn_id: id,
  token_usage: { input_tokens: input, output_tokens: 3, cached_input_tokens: 1, reasoning_output_tokens: 2 },
});

describe("Codex A5 provenance and coverage", () => {
  it("reads cumulative native token_count snapshots without summing their last_token_usage", () => {
    const history = collectCodexUsageHistory([native("2026-11-07T07:02:00Z", 120), native("2026-11-07T07:00:00Z", 100)]);
    expect(history.latestSnapshots[0].tokens.input).toBe(120);
    expect(history.records.map(r => r.tokens.input)).toEqual([100, 120]);
    expect(history.turnTotals.input).toBeNull();
    expect(history.coverage.gaps).toContain("turn-history-unavailable");
    expect(history.records[0]).toMatchObject({ measurement: "cumulative-snapshot", cost: { amountUsd: null, kind: "unavailable" }, seatSession: null });
  });

  it("retains turn-level adapter measurements and excludes overlapping native snapshots from additive totals", () => {
    const history = collectCodexUsageHistory([native("2026-11-07T07:03:00Z", 300), turn("turn-1", 20), turn("turn-2", 30, "2026-11-07T07:02:00Z")], new Map([["thread-a", "dev-impl@rig"]]));
    expect(history.turnTotals).toEqual({ input: 50, output: 6, cachedInput: 2, reasoningOutput: 4 });
    expect(history.coverage.overlappingSnapshots).toBe(1);
    expect(history.coverage.gaps).toContain("snapshot-turn-coverage-unverified");
    expect(history.records.every(r => r.seatSession === "dev-impl@rig")).toBe(true);
  });

  it("dedupes repeated IDs and turn overlap across reader replay, irrespective of order", () => {
    const history = collectCodexUsageHistory([turn("turn-2", 4), turn("turn-1", 3), turn("turn-1", 3), { ...turn("turn-2", 4), id: "other-source-id" }]);
    expect(history.coverage.duplicateRecords).toBe(2);
    // A second source ID for the same turn must not inflate the total.
    expect(history.turnTotals.input).toBe(7);
  });

  it("detects cumulative counter resets and preserves both generations without pretending continuity", () => {
    const history = collectCodexUsageHistory([native("2026-11-07T07:02:00Z", 8), native("2026-11-07T07:01:00Z", 900)]);
    expect(history.coverage.resets).toBe(1);
    expect(history.coverage.gaps).toContain("counter-reset:thread-a");
    expect(history.latestSnapshots[0].tokens.input).toBe(8);
  });

  it("distinguishes malformed-present from absent and keeps zero only when explicitly observed", () => {
    const bad = decodeCodexUsageRecord({ ...turn("t", 0), timestamp: "invalid", model: 7, token_usage: { input_tokens: -2, output_tokens: 0 } });
    expect(bad?.tokens).toEqual({ input: null, output: 0, cachedInput: null, reasoningOutput: null });
    expect(bad?.invalidFields).toEqual(expect.arrayContaining(["timestamp", "model", "tokens.input"]));
    expect(bad?.unavailableFields).toContain("tokens.cachedInput");
    expect(bad?.model).toBeNull();
    const malformed = decodeCodexUsageRecord({ ...turn("broken", 1), token_usage: "bad" });
    const absent = decodeCodexUsageRecord({ ...turn("missing", 1), token_usage: undefined });
    expect(malformed?.invalidFields).toContain("token_usage");
    expect(absent?.invalidFields).not.toContain("token_usage");
  });

  it("preserves distinct same-time native observations without IDs independent of input order", () => {
    const first = native("2026-11-07T07:00:00Z", 100);
    const second = native("2026-11-07T07:00:00Z", 120);
    for (const batch of [[first, second, first], [second, first, first]]) {
      const history = collectCodexUsageHistory(batch);
      expect(history.records).toHaveLength(2);
      expect(history.records.map(r => r.tokens.input)).toEqual([100, 120]);
      expect(history.coverage.duplicateRecords).toBe(1);
      expect(history.latestSnapshots[0].tokens.input).toBe(120);
    }
  });

  it("detects reset in output or other cumulative counters even when input increases", () => {
    const before = native("2026-11-07T07:00:00Z", 100);
    const after = native("2026-11-07T07:01:00Z", 120);
    after.payload.info.total_token_usage.output_tokens = 20;
    before.payload.info.total_token_usage.output_tokens = 100;
    const history = collectCodexUsageHistory([after, before]);
    expect(history.coverage.resets).toBe(1);
    expect(history.coverage.gaps).toContain("counter-reset:thread-a");
  });

  it("rejects quota-only native events and flags adapter records without turn identity", () => {
    expect(decodeCodexUsageRecord({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: {} } } })).toBeNull();
    const record = decodeCodexUsageRecord({ type: "token_usage_record", token_usage: { input_tokens: 2 } });
    expect(record?.invalidFields).toContain("turnId-required-for-turn-record");
    expect(collectCodexUsageHistory([{ type: "token_usage_record", token_usage: { input_tokens: 2 } }]).turnTotals.input).toBeNull();
  });

  it("does not copy prompts, headers, auth, arbitrary attributes or unverified seat claims", () => {
    const record = decodeCodexUsageRecord({ ...turn("t", 1), seat_session: "untrusted", prompt: "secret", headers: { Authorization: "secret" }, env: { SECRET: "secret" }, attributes: { private: "secret" } });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(/secret|Authorization|prompt|headers|attributes|env|untrusted/);
    expect(record?.seatSession).toBeNull();
  });
});
