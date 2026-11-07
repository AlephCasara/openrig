import { describe, expect, it } from "vitest";
import { extractClaudeOtlpApiRequests } from "../src/domain/claude-otlp-api-request.js";

const attr = (key: string, value: string | number | boolean) => ({
  key,
  value: typeof value === "boolean" ? { boolValue: value }
    : typeof value === "number" ? { doubleValue: value } : { stringValue: value },
});
const integer = (key: string, value: string) => ({ key, value: { intValue: value } });
const log = (event: string, attrs: unknown[] = [], timeUnixNano?: string) => ({
  timeUnixNano, observedTimeUnixNano: "1794033601000000000",
  attributes: [attr("event.name", event), ...attrs],
  body: { stringValue: "private body must never be retained" },
});
const envelope = (...records: unknown[]) => ({
  resourceLogs: [
    { resource: { attributes: [attr("session.id", "native-session"), attr("seat_id", "forged-seat"), attr("authorization", "secret")] },
      scopeLogs: [{ logRecords: records.slice(0, 3) }, { logRecords: records.slice(3) }] },
  ],
  resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "api_request" }] }] }],
  resourceSpans: [{ scopeSpans: [{ spans: [{ name: "api_request" }] }] }],
});

describe("Claude Code OTLP api_request v1 contract", () => {
  it("traverses scopes, normalizes standard OTLP scalar values and preserves source semantics", () => {
    const records = extractClaudeOtlpApiRequests(envelope(
      log("unrelated", [attr("cost_usd", 999)]),
      log("api_request", [
        attr("request_id", "req-1"), attr("model", "claude-model"),
        attr("query_source", "agent"), integer("input_tokens", "12"), integer("output_tokens", "8"),
        integer("cache_read_tokens", "2"), integer("cache_creation_tokens", "3"),
        attr("cost_usd", 0.042), attr("prompt", "sensitive"), attr("headers", "sensitive"),
      ], "1794033600000000000"),
      null,
      log("claude_code.api_request", [attr("request_id", "req-2")]),
    ), "verified-seat");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: 1, runtime: "claude-code", producer: "claude-code-otlp",
      source: "otlp-http-json-log", eventName: "api_request", sourceId: "req-1",
      recordIndex: 1, dedupeKey: "claude-code:api_request:req-1",
      sessionId: "native-session", seatId: "verified-seat", model: "claude-model",
      modelSource: "attribute", querySource: "agent",
      tokens: { input: 12, output: 8, cacheRead: 2, cacheCreation: 3 },
      reportedCostUsd: 0.042, costBasis: "claude-code-reported-list-price-estimate",
      eventTimestamp: "2026-11-07T06:40:00.000Z", availability: "complete", invalidFields: [],
      eventTimestampSource: "timeUnixNano",
    });
    expect(records[1]).toMatchObject({
      eventName: "claude_code.api_request", recordIndex: 3, sourceId: "req-2",
      model: null, reportedCostUsd: null, availability: "partial",
    });
    expect(JSON.stringify(records)).not.toMatch(/sensitive|forged-seat|authorization|prompt|headers/);
  });

  it("keeps duplicates and out-of-order records visible under a common stable dedupe key", () => {
    const records = extractClaudeOtlpApiRequests(envelope(
      log("api_request", [attr("request_id", "same")], "1794033603000000000"),
      log("claude_code.api_request", [attr("request_id", "same")], "1794033601000000000"),
    ));
    expect(records).toHaveLength(2);
    expect(records.map(r => r.recordIndex)).toEqual([0, 1]);
    expect(records.map(r => r.dedupeKey)).toEqual([
      "claude-code:api_request:same", "claude-code:api_request:same",
    ]);
    expect(records[0].eventTimestamp! > records[1].eventTimestamp!).toBe(true);
    expect(records.every(r => r.seatId === null)).toBe(true);
  });

  it("reads Claude's event.timestamp attribute and ignores statusline-only cache field names", () => {
    const [record] = extractClaudeOtlpApiRequests(envelope(log("api_request", [
      attr("event.timestamp", "2026-11-07T06:38:00Z"),
      integer("cache_read_input_tokens", "17"), integer("cache_creation_input_tokens", "23"),
      integer("cache_read_tokens", "4"), integer("cache_creation_tokens", "6"),
    ], "1794033600000000000")));
    expect(record.eventTimestamp).toBe("2026-11-07T06:38:00.000Z");
    expect(record.eventTimestampSource).toBe("event.timestamp");
    expect(record.tokens.cacheRead).toBe(4);
    expect(record.tokens.cacheCreation).toBe(6);
  });

  it("never fabricates missing request, timestamp, model, count, cost, session or seat", () => {
    const [record] = extractClaudeOtlpApiRequests({ resourceLogs: [
      { scopeLogs: [{ logRecords: [{ attributes: [attr("event.name", "api_request")] }] }] },
    ] });
    expect(record).toMatchObject({
      sourceId: null, dedupeKey: null, eventTimestamp: null, observedTimestamp: null,
      model: null, modelSource: "unavailable", querySource: null, sessionId: null,
      seatId: null, reportedCostUsd: null, tokens: {
        input: null, output: null, cacheRead: null, cacheCreation: null,
      }, availability: "partial",
    });
    expect(record.unavailableFields).toContain("request_id");
    expect(record.unavailableFields).toContain("cost_usd");
    expect(record.invalidFields).toEqual([]);
  });

  it("marks negative, fractional, non-finite and bogus numeric fields invalid without coercing", () => {
    const [record] = extractClaudeOtlpApiRequests(envelope(log("api_request", [
      integer("input_tokens", "-2"), attr("output_tokens", 2.3),
      integer("cache_read_tokens", "9007199254740993"),
      attr("cache_creation_tokens", "oops"), attr("cost_usd", "NaN"),
    ], "invalid")));
    expect(record.tokens).toEqual({ input: null, output: null, cacheRead: null, cacheCreation: null });
    expect(record.reportedCostUsd).toBeNull();
    expect(record.eventTimestamp).toBeNull();
    expect(record.invalidFields).toEqual([
      "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens",
      "cache_creation_tokens", "timeUnixNano",
    ]);
  });

  it("ignores unrelated, malformed, or non-log payloads and refuses resource seat hints", () => {
    expect(extractClaudeOtlpApiRequests({ resourceLogs: [{ scopeLogs: [{ logRecords: [
      null, false, {}, { body: { stringValue: "not an event" } },
      { attributes: [attr("event.name", "not_api_request")] },
    ] }] }] })).toEqual([]);
    const [record] = extractClaudeOtlpApiRequests(envelope(log("api_request")));
    expect(record.seatId).toBeNull();
  });
});
