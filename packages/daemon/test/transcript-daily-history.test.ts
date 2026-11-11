import { describe, expect, it } from "vitest";
import { aggregateTranscriptDailyHistory } from "../src/domain/transcript-daily-history.js";

const at = Date.parse("2026-01-10T12:00:00Z");
const row = (sessionId: string, messageId: string, model = "model-a") => ({
  seat: "worker", sessionId, messageId, model, atMs: at,
  inputTokens: 100, outputTokens: 10, cacheWriteTokens: 20, cacheReadTokens: 30,
});

describe("offline daily transcript usage history (#32)", () => {
  it("deduplicates repeated assistant message IDs within each session, not across sessions", () => {
    const r = aggregateTranscriptDailyHistory([row("s1", "m1"), row("s1", "m1"), row("s2", "m1")], { "model-a": { input: 2, output: 8, cacheWrite: 1, cacheRead: 0.5 } });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ seat: "worker", dayUtc: "2026-01-10", model: "model-a", messages: 2, inputTokens: 200, outputTokens: 20, cacheWriteTokens: 40, cacheReadTokens: 60 });
    expect(r[0]?.estimatedUsd).toBeCloseTo((200 * 2 + 20 * 8 + 40 * 1 + 60 * 0.5) / 1_000_000);
  });
  it("keeps separate models and seats, marking unknown rates n/a", () => {
    const r = aggregateTranscriptDailyHistory([row("s1", "m1"), { ...row("s2", "m2", "model-unknown"), seat: "reviewer" }], {});
    expect(r).toHaveLength(2);
    expect(r.every(x => x.estimatedUsd === null)).toBe(true);
  });
  it("refuses contradictory duplicate identities rather than double billing", () => {
    expect(() => aggregateTranscriptDailyHistory([row("s1", "m1"), { ...row("s1", "m1"), outputTokens: 999 }], {})).toThrow();
  });
  it("rejects invalid usage and timestamps", () => {
    expect(() => aggregateTranscriptDailyHistory([{ ...row("s1", "m1"), inputTokens: -1 }], {})).toThrow();
    expect(() => aggregateTranscriptDailyHistory([{ ...row("s1", "m1"), atMs: Infinity }], {})).toThrow();
  });
});
